import type { IssueRunDetail, RepoStateResponse } from "@rockband/shared";

export function renderSetupHtml(
  baseUrl: string,
  state: RepoStateResponse | undefined,
  serviceTokenConfigured: boolean,
): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #11161c;
        --panel: #18212b;
        --accent: #8ec5ff;
        --text: #eff6ff;
        --muted: #99a8b8;
      }
      body {
        font-family: Georgia, "Iowan Old Style", serif;
        background: radial-gradient(circle at top, #213044, var(--bg) 65%);
        color: var(--text);
        margin: 0;
        padding: 24px;
      }
      .card {
        background: color-mix(in srgb, var(--panel) 85%, transparent);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px;
        padding: 18px;
      }
      .muted { color: var(--muted); }
      h1 { margin-top: 0; }
      code { color: var(--accent); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Hosted Symphony</h1>
      <p class="muted">Control plane: <code>${baseUrl}</code></p>
      <p>${state ? `Connected repo: <strong>${state.repo.fullName}</strong>` : "No repo connected yet."}</p>
      <p>${serviceTokenConfigured ? "Service token is configured." : "Service token is not configured yet."}</p>
      <p>Use the command palette to connect a repo, create <code>WORKFLOW.md</code>, validate it, and start monitoring runs.</p>
    </div>
  </body>
</html>`;
}

export function renderIssueHtml(detail: IssueRunDetail): string {
  const events = detail.recentEvents
    .map((event) => `<li><strong>${event.event}</strong> <span>${event.message}</span></li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      body {
        font-family: "Palatino Linotype", Palatino, serif;
        background: linear-gradient(160deg, #101317, #172231);
        color: #edf4ff;
        padding: 20px;
      }
      .meta { color: #9fb1c5; }
      ul { padding-left: 18px; }
      .pill {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(142,197,255,0.15);
        color: #8ec5ff;
      }
    </style>
  </head>
  <body>
    <div class="pill">${detail.status}</div>
    <h1>${detail.issueIdentifier}</h1>
    <p class="meta">Workspace: ${detail.workspace.path}</p>
    <p class="meta">Restart count: ${detail.attempts.restartCount} | Retry attempt: ${detail.attempts.currentRetryAttempt}</p>
    <h2>Recent events</h2>
    <ul>${events || "<li>No events yet.</li>"}</ul>
  </body>
</html>`;
}
