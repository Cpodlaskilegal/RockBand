import nunjucks from "nunjucks";
import { parse as parseYaml } from "yaml";

import type {
  EffectiveWorkflowConfig,
  HostedWorkflowWarning,
  IssueSummary,
  WorkflowDefinition,
  WorkflowValidationResult,
} from "./contracts.js";

const env = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: true,
});

const HOSTED_IGNORED_FIELDS = new Set([
  "workspace.root",
  "codex.command",
  "server.port",
  "worker.ssh_hosts",
  "worker.max_concurrent_agents_per_host",
]);

export function parseWorkflowMarkdown(markdown: string): WorkflowDefinition {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      config: {},
      promptTemplate: normalized.trim(),
      rawFrontMatter: "",
      rawMarkdown: markdown,
    };
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    throw new Error("workflow_parse_error: front matter fence is not closed");
  }

  const rawFrontMatter = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5).trim();
  const parsed = parseYaml(rawFrontMatter);

  if (parsed !== null && typeof parsed !== "object") {
    throw new Error("workflow_front_matter_not_a_map: expected YAML map");
  }

  return {
    config: (parsed ?? {}) as Record<string, unknown>,
    promptTemplate: body,
    rawFrontMatter,
    rawMarkdown: markdown,
  };
}

function getObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function getString(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new Error(`${field} is required`);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  return value;
}

function getNumber(value: unknown, field: string, defaultValue: number): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${field} must be a number`);
  }

  return value;
}

function getStringArray(value: unknown, field: string, defaultValue: string[]): string[] {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be a list of strings`);
  }

  return value;
}

function getStringNumberMap(
  value: unknown,
  field: string,
  defaultValue: Record<string, number>,
): Record<string, number> {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, number> = {};

  for (const [key, rawValue] of entries) {
    if (typeof rawValue !== "number" || rawValue <= 0 || Number.isNaN(rawValue)) {
      throw new Error(`${field}.${key} must be a positive number`);
    }
    result[key] = rawValue;
  }

  return result;
}

function collectHostedWarnings(config: Record<string, unknown>): HostedWorkflowWarning[] {
  const warnings: HostedWorkflowWarning[] = [];
  const workspace = getObject(config.workspace, "workspace");
  const codex = getObject(config.codex, "codex");
  const worker = getObject(config.worker, "worker");
  const server = getObject(config.server, "server");

  if ("root" in workspace) {
    warnings.push({
      field: "workspace.root",
      message: "Hosted Symphony ignores workspace.root and uses a managed shared workspace mount.",
    });
  }

  if ("command" in codex) {
    warnings.push({
      field: "codex.command",
      message: "Hosted Symphony ignores codex.command and always launches codex app-server.",
    });
  }

  if ("port" in server) {
    warnings.push({
      field: "server.port",
      message: "Hosted Symphony ignores server.port because monitoring is exposed by the control plane.",
    });
  }

  if ("ssh_hosts" in worker) {
    warnings.push({
      field: "worker.ssh_hosts",
      message: "Hosted Symphony ignores worker.ssh_hosts and schedules managed workers instead.",
    });
  }

  if ("max_concurrent_agents_per_host" in worker) {
    warnings.push({
      field: "worker.max_concurrent_agents_per_host",
      message: "Hosted Symphony ignores worker.max_concurrent_agents_per_host in favor of control-plane scheduling.",
    });
  }

  return warnings;
}

export function buildEffectiveHostedConfig(config: Record<string, unknown>): EffectiveWorkflowConfig {
  const tracker = getObject(config.tracker, "tracker");
  const polling = getObject(config.polling, "polling");
  const hooks = getObject(config.hooks, "hooks");
  const agent = getObject(config.agent, "agent");
  const codex = getObject(config.codex, "codex");

  const trackerKind = getString(tracker.kind, "tracker.kind", true);
  if (trackerKind !== "linear") {
    throw new Error("tracker.kind must be linear");
  }

  const hostedHooks: EffectiveWorkflowConfig["hooks"] = {
    timeoutMs: getNumber(hooks.timeout_ms, "hooks.timeout_ms", 60000),
  };
  const afterCreate = getString(hooks.after_create, "hooks.after_create");
  const beforeRun = getString(hooks.before_run, "hooks.before_run");
  const afterRun = getString(hooks.after_run, "hooks.after_run");
  const beforeRemove = getString(hooks.before_remove, "hooks.before_remove");
  if (afterCreate) {
    hostedHooks.afterCreate = afterCreate;
  }
  if (beforeRun) {
    hostedHooks.beforeRun = beforeRun;
  }
  if (afterRun) {
    hostedHooks.afterRun = afterRun;
  }
  if (beforeRemove) {
    hostedHooks.beforeRemove = beforeRemove;
  }

  return {
    tracker: {
      kind: "linear",
      projectSlug: getString(tracker.project_slug, "tracker.project_slug", true)!,
      activeStates: getStringArray(tracker.active_states, "tracker.active_states", ["Todo", "In Progress"]),
      terminalStates: getStringArray(
        tracker.terminal_states,
        "tracker.terminal_states",
        ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      ),
    },
    polling: {
      intervalMs: getNumber(polling.interval_ms, "polling.interval_ms", 30000),
    },
    hooks: hostedHooks,
    agent: {
      maxConcurrentAgents: getNumber(agent.max_concurrent_agents, "agent.max_concurrent_agents", 10),
      maxTurns: getNumber(agent.max_turns, "agent.max_turns", 20),
      maxRetryBackoffMs: getNumber(agent.max_retry_backoff_ms, "agent.max_retry_backoff_ms", 300000),
      maxConcurrentAgentsByState: getStringNumberMap(
        agent.max_concurrent_agents_by_state,
        "agent.max_concurrent_agents_by_state",
        {},
      ),
    },
    codex: {
      approvalPolicy: (getString(codex.approval_policy, "codex.approval_policy") ?? "never") as EffectiveWorkflowConfig["codex"]["approvalPolicy"],
      threadSandbox: (getString(codex.thread_sandbox, "codex.thread_sandbox") ?? "workspace-write") as EffectiveWorkflowConfig["codex"]["threadSandbox"],
      turnTimeoutMs: getNumber(codex.turn_timeout_ms, "codex.turn_timeout_ms", 3600000),
      readTimeoutMs: getNumber(codex.read_timeout_ms, "codex.read_timeout_ms", 5000),
      stallTimeoutMs: getNumber(codex.stall_timeout_ms, "codex.stall_timeout_ms", 300000),
    },
    hostedPolicy: {
      workspaceRoot: "/mnt/symphony",
      codexCommand: "codex app-server",
      workerRuntime: "managed",
      persistence: "managed",
    },
  };
}

export function validateHostedWorkflow(markdown: string): WorkflowValidationResult {
  const errors: string[] = [];
  let promptTemplate: string | undefined;
  let effectiveConfig: EffectiveWorkflowConfig | undefined;
  let warnings: HostedWorkflowWarning[] = [];

  try {
    const parsed = parseWorkflowMarkdown(markdown);
    promptTemplate = parsed.promptTemplate;
    warnings = collectHostedWarnings(parsed.config);
    effectiveConfig = buildEffectiveHostedConfig(parsed.config);
    renderPromptTemplate(
      promptTemplate || defaultPromptTemplate(),
      sampleIssue(),
      null,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ignoredFields: warnings
      .map((warning) => warning.field)
      .filter((field) => HOSTED_IGNORED_FIELDS.has(field)),
    ...(effectiveConfig ? { effectiveConfig } : {}),
    ...(promptTemplate ? { promptTemplate } : {}),
  };
}

export function renderPromptTemplate(
  promptTemplate: string,
  issue: IssueSummary,
  attempt: number | null,
): string {
  return env.renderString(promptTemplate, {
    issue: {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      priority: issue.priority ?? null,
      state: issue.state,
      url: issue.url ?? null,
      labels: issue.labels,
      blocked_by: issue.blockedBy,
      created_at: issue.createdAt ?? null,
      updated_at: issue.updatedAt ?? null,
    },
    attempt,
  });
}

export function defaultPromptTemplate(): string {
  return [
    "You are working on Linear issue {{ issue.identifier }}.",
    "",
    "Title: {{ issue.title }}",
    "Description: {{ issue.description }}",
  ].join("\n");
}

export function createHostedWorkflowTemplate(projectSlug: string): string {
  return [
    "---",
    "tracker:",
    '  kind: linear',
    `  project_slug: "${projectSlug}"`,
    "polling:",
    "  interval_ms: 30000",
    "hooks:",
    "  after_create: |",
    "    git fetch --all --prune",
    "agent:",
    "  max_concurrent_agents: 5",
    "  max_turns: 20",
    "codex:",
    '  approval_policy: "never"',
    '  thread_sandbox: "workspace-write"',
    "---",
    "",
    "You are working on Linear issue {{ issue.identifier }}.",
    "",
    "Title: {{ issue.title }}",
    "Description: {{ issue.description }}",
    "",
    "Operate autonomously until the task reaches the next safe human handoff state.",
  ].join("\n");
}

function sampleIssue(): IssueSummary {
  return {
    id: "issue_123",
    identifier: "RB-123",
    title: "Example issue",
    description: "Investigate hosted orchestration",
    state: "Todo",
    labels: ["platform"],
    blockedBy: [],
  };
}
