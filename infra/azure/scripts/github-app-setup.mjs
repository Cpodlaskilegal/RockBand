import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { URLSearchParams } from "node:url";

const port = Number(process.env.GITHUB_APP_SETUP_PORT ?? 8787);
const envPath = process.env.HOSTED_SYMPHONY_ENV_FILE ?? ".env.azure.local";
const env = loadEnvFile(envPath);

const appName = process.env.GITHUB_APP_NAME ?? `hosted-symphony-${env.HOSTED_SYMPHONY_ENVIRONMENT ?? "staging"}`;
const owner = process.env.GITHUB_APP_OWNER;
const ownerType = process.env.GITHUB_APP_OWNER_TYPE === "org" ? "org" : "user";
const homepageUrl = process.env.GITHUB_APP_HOMEPAGE_URL ?? env.HOSTED_SYMPHONY_BASE_URL ?? `http://127.0.0.1:${port}`;
const state = randomUUID();
const redirectUrl = `http://127.0.0.1:${port}/redirect`;
const installUrl = ownerType === "org" && owner ? `https://github.com/organizations/${owner}/settings/apps/new` : "https://github.com/settings/apps/new";

const manifest = {
  name: appName,
  url: homepageUrl,
  redirect_url: redirectUrl,
  public: false,
  request_oauth_on_install: false,
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
  },
  default_events: [],
  description: "Hosted Symphony worker access for cloning repos, pushing branches, and opening pull requests.",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (req.method === "GET" && url.pathname === "/") {
    const formAction = `${installUrl}?state=${encodeURIComponent(state)}`;
    const html = `<!doctype html>
<html>
  <body style="font-family: system-ui; padding: 24px">
    <h1>Hosted Symphony GitHub App Setup</h1>
    <p>This page will create a preconfigured GitHub App and write its credentials into <code>${escapeHtml(envPath)}</code>.</p>
    <form method="post" action="${escapeHtml(formAction)}">
      <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}" />
      <button type="submit" style="font-size: 16px; padding: 10px 16px">Create GitHub App</button>
    </form>
    <p style="margin-top: 18px; color: #555">Owner flow: ${ownerType === "org" && owner ? `organization ${escapeHtml(owner)}` : "personal account"}</p>
  </body>
</html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/redirect") {
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (!code) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Missing GitHub manifest code.");
      return;
    }

    if (returnedState && returnedState !== state) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("GitHub state mismatch.");
      return;
    }

    try {
      const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "hosted-symphony-github-app-setup",
        },
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(`GitHub conversion failed: ${response.status} ${response.statusText} ${JSON.stringify(payload)}`);
      }

      const nextEnv = {
        GITHUB_APP_ID: String(payload.id ?? ""),
        GITHUB_APP_PRIVATE_KEY: normalizePem(payload.pem ?? ""),
        GITHUB_APP_WEBHOOK_SECRET: String(payload.webhook_secret ?? ""),
        GITHUB_APP_SLUG: String(payload.slug ?? ""),
        GITHUB_APP_CLIENT_ID: String(payload.client_id ?? ""),
        GITHUB_APP_CLIENT_SECRET: String(payload.client_secret ?? ""),
      };

      upsertEnvFile(envPath, nextEnv);

      const appSlug = nextEnv.GITHUB_APP_SLUG;
      const installationPage = appSlug ? `https://github.com/apps/${appSlug}/installations/new` : undefined;
      if (installationPage) {
        openUrl(installationPage);
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <body style="font-family: system-ui; padding: 24px">
    <h1>GitHub App Created</h1>
    <p>Saved <code>GITHUB_APP_ID</code> and <code>GITHUB_APP_PRIVATE_KEY</code> into <code>${escapeHtml(envPath)}</code>.</p>
    ${installationPage ? `<p>The install page has been opened: <a href="${escapeHtml(installationPage)}">${escapeHtml(installationPage)}</a></p>` : ""}
    <p>Install the app on the target repository, then use the installation id in the VS Code extension connect flow.</p>
  </body>
</html>`);

      console.log(`GitHub App created: ${appSlug || payload.id}`);
      console.log(`Updated ${envPath}`);
      if (installationPage) {
        console.log(`Open installation page: ${installationPage}`);
      }

      setTimeout(() => {
        server.close();
      }, 500);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error instanceof Error ? error.message : error));
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`GitHub App setup server listening at ${url}`);
  console.log(`Using env file: ${envPath}`);
  console.log(`GitHub owner flow: ${ownerType === "org" && owner ? `organization ${owner}` : "personal account"}`);
  openUrl(url);
});

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const text = readFileSync(filePath, "utf8");
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    entries[key] = value;
  }
  return entries;
}

function upsertEnvFile(filePath, values) {
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const next = current.map((line) => {
    const index = line.indexOf("=");
    if (index === -1) {
      return line;
    }
    const key = line.slice(0, index);
    if (!(key in values)) {
      return line;
    }
    seen.add(key);
    return `${key}=${encodeEnvValue(values[key])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      next.push(`${key}=${encodeEnvValue(value)}`);
    }
  }

  writeFileSync(filePath, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function encodeEnvValue(value) {
  if (value.includes("\n")) {
    return JSON.stringify(value);
  }
  return value;
}

function normalizePem(value) {
  return String(value).replace(/\r\n/g, "\n").trim();
}

function openUrl(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? [url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    shell: platform === "win32",
  });
  child.unref();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
