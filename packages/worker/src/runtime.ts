import { createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { buildWorkspacePath, type WorkerDispatchRequest, type WorkerEventEnvelope } from "@rockband/shared";

import { buildStartupMessages } from "./codexProtocol.js";
import type { WorkerLauncher, WorkerLaunchResult } from "./launcher.js";

export interface WorkerRuntimeOptions {
  workspaceRoot?: string;
  logRoot?: string;
}

export class MockWorkerRuntime {
  private readonly workspaceRoot: string;
  private readonly logRoot: string;

  constructor(options: WorkerRuntimeOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? ".data/workspaces";
    this.logRoot = options.logRoot ?? ".data/logs";
  }

  async run(
    request: WorkerDispatchRequest,
    onEvent: (event: WorkerEventEnvelope) => Promise<void> | void,
  ): Promise<void> {
    const workspacePath = buildWorkspacePath(this.workspaceRoot, request.repo.id, request.issue.identifier);
    const logPath = buildWorkspacePath(this.logRoot, request.repo.id, `${request.issue.identifier}.log`);

    await mkdir(workspacePath, { recursive: true });
    await mkdir(logPath.split("/").slice(0, -1).join("/"), { recursive: true });

    const startup = buildStartupMessages(request, workspacePath);
    await onEvent({
      repoId: request.repo.id,
      issueId: request.issue.id,
      issueIdentifier: request.issue.identifier,
      event: "session_started",
      at: new Date().toISOString(),
      status: "running",
      sessionId: "mock-thread-1-mock-turn-1",
      turnCount: 1,
      workspacePath,
      message: `Prepared workspace and startup handshake with ${startup.length} protocol messages`,
      logPath,
      linearUrl: request.issue.url ?? undefined,
    });

    await sleep(20);
    await onEvent({
      repoId: request.repo.id,
      issueId: request.issue.id,
      issueIdentifier: request.issue.identifier,
      event: "notification",
      at: new Date().toISOString(),
      status: "running",
      sessionId: "mock-thread-1-mock-turn-1",
      turnCount: 1,
      workspacePath,
      message: "Running mock Codex turn against hosted workspace",
      tokens: {
        inputTokens: 320,
        outputTokens: 140,
        totalTokens: 460,
      },
      logPath,
      linearUrl: request.issue.url ?? undefined,
    });

    await sleep(20);
    await onEvent({
      repoId: request.repo.id,
      issueId: request.issue.id,
      issueIdentifier: request.issue.identifier,
      event: "turn_completed",
      at: new Date().toISOString(),
      status: "completed",
      sessionId: "mock-thread-1-mock-turn-1",
      turnCount: 1,
      workspacePath,
      message: "Mock worker completed the issue turn",
      tokens: {
        inputTokens: 320,
        outputTokens: 180,
        totalTokens: 500,
      },
      logPath,
      linearUrl: request.issue.url ?? undefined,
    });
  }
}

export class MockWorkerLauncher implements WorkerLauncher {
  private readonly runtime: MockWorkerRuntime;

  constructor(
    options: WorkerRuntimeOptions = {},
    private readonly emitEvent?: (event: WorkerEventEnvelope) => Promise<void> | void,
  ) {
    this.runtime = new MockWorkerRuntime(options);
  }

  async dispatch(request: WorkerDispatchRequest): Promise<WorkerLaunchResult> {
    void this.runtime.run(request, async (event) => {
      await this.emitEvent?.(event);
    });

    return {
      workerInstanceId: `mock-worker/${request.repo.id}/${request.issue.identifier}`,
      taskArn: `mock-task/${request.repo.id}/${request.issue.identifier}`,
      logNamespace: "local/mock-worker",
      logStream: `${request.repo.id}/${request.issue.identifier}`,
      logUrl: `file://${logRootFor(request.repo.id, request.issue.identifier)}`,
    };
  }

  async cancel(): Promise<void> {
    return;
  }
}

function logRootFor(repoId: string, issueIdentifier: string): string {
  return buildWorkspacePath(".data/logs", repoId, `${issueIdentifier}.log`);
}

export function signWorkerEvent(secret: string, payload: WorkerEventEnvelope): string {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
