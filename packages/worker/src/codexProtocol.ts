import type { WorkerEventEnvelope, WorkerDispatchRequest } from "@rockband/shared";

export interface JsonRpcRequest<TParams = Record<string, unknown>> {
  id?: number;
  method: string;
  params: TParams;
}

export interface JsonRpcResponse<TResult = Record<string, unknown>> {
  id: number;
  result?: TResult;
  error?: {
    code: number;
    message: string;
  };
}

export function buildStartupMessages(
  request: WorkerDispatchRequest,
  workspacePath: string,
): JsonRpcRequest[] {
  return [
    {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "hosted-symphony-worker",
          version: "0.1.0",
        },
        capabilities: {},
      },
    },
    {
      method: "initialized",
      params: {},
    },
    {
      id: 2,
      method: "thread/start",
      params: {
        approvalPolicy: request.workflow.codex.approvalPolicy,
        sandbox: request.workflow.codex.threadSandbox,
        cwd: workspacePath,
        tools: [
          {
            name: "linear_graphql",
            description: "Execute one GraphQL operation against the configured Linear project",
          },
        ],
      },
    },
    {
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread_placeholder",
        input: [
          {
            type: "text",
            text: request.promptTemplate,
          },
        ],
        cwd: workspacePath,
        title: `${request.issue.identifier}: ${request.issue.title}`,
        approvalPolicy: request.workflow.codex.approvalPolicy,
        sandboxPolicy: {
          type: request.workflow.codex.threadSandbox,
        },
      },
    },
  ];
}

export function parseCodexProtocolLine(
  line: string,
  context: {
    repoId: string;
    issueId: string;
    issueIdentifier: string;
  },
): WorkerEventEnvelope | null {
  const parsed = JSON.parse(line) as JsonRpcResponse & JsonRpcRequest;
  const at = new Date().toISOString();

  if (parsed.method === "turn/started") {
    const turn = getObject(parsed.params).turn as { id?: string } | undefined;
    return {
      repoId: context.repoId,
      issueId: context.issueId,
      issueIdentifier: context.issueIdentifier,
      event: "session_started",
      at,
      status: "running",
      sessionId: turn?.id ?? "unknown-turn",
    };
  }

  if (parsed.method === "turn/completed") {
    const usage = extractUsage(getObject(parsed.params));
    return {
      repoId: context.repoId,
      issueId: context.issueId,
      issueIdentifier: context.issueIdentifier,
      event: "turn_completed",
      at,
      status: "completed",
      tokens: usage,
    };
  }

  if (parsed.method === "turn/failed") {
    return {
      repoId: context.repoId,
      issueId: context.issueId,
      issueIdentifier: context.issueIdentifier,
      event: "turn_failed",
      at,
      status: "failed",
      error: JSON.stringify(getObject(parsed.params)),
    };
  }

  if (parsed.method === "turn/cancelled") {
    return {
      repoId: context.repoId,
      issueId: context.issueId,
      issueIdentifier: context.issueIdentifier,
      event: "turn_cancelled",
      at,
      status: "failed",
    };
  }

  if (parsed.method === "notification") {
    const params = getObject(parsed.params);
    const message = typeof params.message === "string" ? params.message : "Notification";
    return {
      repoId: context.repoId,
      issueId: context.issueId,
      issueIdentifier: context.issueIdentifier,
      event: "notification",
      at,
      status: "running",
      message,
      tokens: extractUsage(params),
    };
  }

  if (parsed.error) {
    return {
      repoId: context.repoId,
      issueId: context.issueId,
      issueIdentifier: context.issueIdentifier,
      event: "startup_failed",
      at,
      status: "failed",
      error: parsed.error.message,
    };
  }

  return null;
}

function getObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractUsage(source: Record<string, unknown>): WorkerEventEnvelope["tokens"] {
  const usageCandidates = [
    source.usage,
    source.total_token_usage,
    source.token_usage,
  ];

  for (const candidate of usageCandidates) {
    const usage = getObject(candidate);
    const input = toNumber(usage.input_tokens ?? usage.inputTokens);
    const output = toNumber(usage.output_tokens ?? usage.outputTokens);
    const total = toNumber(usage.total_tokens ?? usage.totalTokens);

    if (input !== undefined || output !== undefined || total !== undefined) {
      return {
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        totalTokens: total ?? (input ?? 0) + (output ?? 0),
      };
    }
  }

  return undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}
