import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile } from "node:fs/promises";

import {
  buildWorkspacePath,
  renderPromptTemplate,
  type WorkerDispatchRequest,
  type WorkerEventEnvelope,
} from "@rockband/shared";

import { createGitHubInstallationToken } from "./github.js";
import { parseCodexProtocolLine } from "./codexProtocol.js";
import { signWorkerEvent } from "./runtime.js";

export async function runWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rawJob = env.WORKER_JOB_JSON;
  if (!rawJob) {
    throw new Error("WORKER_JOB_JSON is required");
  }

  const request = JSON.parse(rawJob) as WorkerDispatchRequest;
  const workspaceRoot = env.SYMPHONY_WORKSPACE_ROOT ?? "/mnt/symphony";
  const workspacePath = buildWorkspacePath(workspaceRoot, request.repo.id, request.issue.identifier);
  await mkdir(workspacePath, { recursive: true });

  await checkoutRepo(request, workspacePath, env);

  const workflowPath = `${workspacePath}/WORKFLOW.md`;
  const workflowContent = await readFile(workflowPath, "utf8").catch(() => "");
  const prompt =
    workflowContent.trim().length > 0
      ? renderPromptTemplate(request.promptTemplate, request.issue, request.attempt ?? null)
      : request.promptTemplate;

  const codexCommand = env.CODEX_COMMAND ?? request.workflow.hostedPolicy.codexCommand;
  if (!codexCommand) {
    await postEvent(env, {
      repoId: request.repo.id,
      issueId: request.issue.id,
      issueIdentifier: request.issue.identifier,
      event: "startup_failed",
      at: new Date().toISOString(),
      status: "failed",
      error: "CODEX_COMMAND is missing",
      workspacePath,
    });
    return;
  }

  const child = spawn("bash", ["-lc", codexCommand], {
    cwd: workspacePath,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = createInterface({ input: child.stdout });
  let threadId = "";
  let turnStarted = false;

  child.stdin.write(
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "hosted-symphony-worker", version: "0.1.0" },
        capabilities: {},
      },
    }) + "\n",
  );
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  child.stdin.write(
    JSON.stringify({
      id: 2,
      method: "thread/start",
      params: {
        approvalPolicy: request.workflow.codex.approvalPolicy,
        sandbox: request.workflow.codex.threadSandbox,
        cwd: workspacePath,
      },
    }) + "\n",
  );

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) {
      continue;
    }

    const parsed = JSON.parse(raw) as {
      id?: number;
      result?: { thread?: { id?: string } };
    };
    if (parsed.id === 2 && parsed.result?.thread?.id && !turnStarted) {
      threadId = parsed.result.thread.id;
      child.stdin.write(
        JSON.stringify({
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input: [{ type: "text", text: prompt }],
            cwd: workspacePath,
            title: `${request.issue.identifier}: ${request.issue.title}`,
            approvalPolicy: request.workflow.codex.approvalPolicy,
            sandboxPolicy: { type: request.workflow.codex.threadSandbox },
          },
        }) + "\n",
      );
      turnStarted = true;
      continue;
    }

    const event = parseCodexProtocolLine(raw, {
      repoId: request.repo.id,
      issueId: request.issue.id,
      issueIdentifier: request.issue.identifier,
    });

    if (event) {
      event.workspacePath = workspacePath;
      await postEvent(env, event);
      if (event.event === "turn_completed" || event.event === "turn_failed" || event.event === "turn_cancelled") {
        child.kill("SIGTERM");
        break;
      }
    }
  }
}

async function checkoutRepo(
  request: WorkerDispatchRequest,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    return;
  }

  const token = await createGitHubInstallationToken({
    appId,
    installationId: request.repo.githubInstallationId,
    privateKeyPem: privateKey,
  });

  const repoUrl = `https://x-access-token:${token}@github.com/${request.repo.fullName}.git`;
  await runShell(`if [ -d .git ]; then git fetch --all --prune && git reset --hard origin/HEAD; else git clone ${shellEscape(repoUrl)} .; fi`, workspacePath);
}

async function runShell(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: "ignore",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`command_failed:${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function postEvent(env: NodeJS.ProcessEnv, event: WorkerEventEnvelope): Promise<void> {
  const baseUrl = env.SYMPHONY_CONTROL_PLANE_URL;
  const secret = env.SYMPHONY_WORKER_EVENT_SECRET;
  if (!baseUrl || !secret) {
    return;
  }

  const enrichedEvent: WorkerEventEnvelope = {
    ...event,
    workerInstanceId:
      event.workerInstanceId ??
      env.CONTAINER_APP_JOB_EXECUTION_NAME ??
      env.CONTAINERAPP_JOB_EXECUTION_NAME ??
      env.HOSTNAME,
    logNamespace: event.logNamespace ?? env.SYMPHONY_LOG_NAMESPACE,
    logStream:
      event.logStream ??
      env.CONTAINER_APP_JOB_EXECUTION_NAME ??
      env.CONTAINERAPP_JOB_EXECUTION_NAME ??
      env.HOSTNAME,
    logUrl: event.logUrl ?? buildAzureLogUrl(env),
  };

  const signature = signWorkerEvent(secret, enrichedEvent);
  await fetch(new URL("/internal/worker-events", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-symphony-signature": signature,
    },
    body: JSON.stringify(enrichedEvent),
  });
}

function buildAzureLogUrl(env: NodeJS.ProcessEnv): string | undefined {
  const executionName = env.CONTAINER_APP_JOB_EXECUTION_NAME ?? env.CONTAINERAPP_JOB_EXECUTION_NAME ?? env.HOSTNAME;
  const jobName = env.SYMPHONY_AZURE_JOB_NAME;
  const resourceGroup = env.SYMPHONY_AZURE_RESOURCE_GROUP;
  if (!executionName || !jobName || !resourceGroup) {
    return undefined;
  }

  return `azure-container-apps-job://${resourceGroup}/${jobName}/${executionName}`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

if (process.argv[1]?.endsWith("/cli.js")) {
  runWorkerFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
