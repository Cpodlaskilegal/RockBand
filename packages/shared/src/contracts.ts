export type CloudProvider = "local" | "aws" | "azure";
export type DeploymentEnvironment = "local" | "staging" | "prod";

export interface HostedRepo {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  githubInstallationId: string;
  linearProjectSlug: string;
  linearSecretName?: string;
  repoRoot?: string;
  orchestrationEnabled: boolean;
  cloudProvider?: CloudProvider;
  deploymentEnvironment?: DeploymentEnvironment;
  controlPlaneBaseUrl?: string;
  setupStatus: SetupStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SetupStatus {
  signedIn: boolean;
  githubConnected: boolean;
  linearConnected: boolean;
  serviceTokenConfigured: boolean;
  workflowPresent: boolean;
  workflowValid: boolean;
  orchestrationEnabled: boolean;
  lastValidatedAt?: string;
  lastError?: string;
}

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state: string;
  branchName?: string | null;
  url?: string | null;
  labels: string[];
  blockedBy: IssueBlocker[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface IssueBlocker {
  id?: string | null;
  identifier?: string | null;
  state?: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
  rawFrontMatter: string;
  rawMarkdown: string;
}

export interface HostedWorkflowWarning {
  field: string;
  message: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: HostedWorkflowWarning[];
  ignoredFields: string[];
  effectiveConfig?: EffectiveWorkflowConfig;
  promptTemplate?: string;
}

export interface EffectiveWorkflowConfig {
  tracker: {
    kind: "linear";
    projectSlug: string;
    activeStates: string[];
    terminalStates: string[];
  };
  polling: {
    intervalMs: number;
  };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
  codex: {
    approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
    threadSandbox: "workspace-write" | "read-only" | "danger-full-access";
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
  hostedPolicy: {
    workspaceRoot: string;
    codexCommand: "codex app-server";
    workerRuntime: "managed" | "ecs-fargate" | "azure-container-apps-job";
    persistence: "managed" | "postgres+sqs" | "postgres+azure-queue";
  };
}

export interface RunSummary {
  issueId: string;
  issueIdentifier: string;
  state: string;
  sessionId?: string;
  workerInstanceId?: string;
  taskArn?: string;
  turnCount: number;
  lastEvent: string;
  lastMessage?: string;
  startedAt: string;
  lastEventAt?: string;
  tokens: TokenTotals;
  logUrl?: string | null;
  logNamespace?: string | null;
  logStream?: string | null;
  logGroupName?: string | null;
  logStreamName?: string | null;
  linearUrl?: string | null;
  pullRequestUrl?: string | null;
}

export interface RetrySummary {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  dueAt: string;
  error?: string;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning?: number;
}

export interface RepoStateResponse {
  generatedAt: string;
  repo: HostedRepo;
  counts: {
    running: number;
    retrying: number;
  };
  running: RunSummary[];
  retrying: RetrySummary[];
  codexTotals: TokenTotals;
  latestError?: string;
  validation?: WorkflowValidationResult;
}

export interface LogLink {
  label: string;
  path?: string;
  url?: string | null;
}

export interface RecentEvent {
  at: string;
  event: string;
  message: string;
}

export interface IssueRunDetail {
  issueIdentifier: string;
  issueId: string;
  status: "running" | "retrying" | "idle" | "unknown";
  workspace: {
    path: string;
  };
  attempts: {
    restartCount: number;
    currentRetryAttempt: number;
  };
  running?: RunSummary;
  retry?: RetrySummary | null;
  logs: {
    codexSessionLogs: LogLink[];
  };
  recentEvents: RecentEvent[];
  lastError?: string | null;
  tracked: Record<string, unknown>;
}

export interface ConnectRepoInput {
  owner: string;
  repo: string;
  githubInstallationId: string;
  linearProjectSlug: string;
  linearApiKey: string;
  repoRoot?: string;
  cloudProvider?: CloudProvider;
  deploymentEnvironment?: DeploymentEnvironment;
}

export interface WorkflowValidationResponse {
  repo: HostedRepo;
  validation: WorkflowValidationResult;
}

export interface EnableRepoResponse {
  repo: HostedRepo;
  enabled: boolean;
}

export interface WorkerEventEnvelope {
  repoId: string;
  issueId: string;
  issueIdentifier: string;
  event: string;
  at: string;
  message?: string;
  status?: "running" | "completed" | "failed" | "retrying";
  sessionId?: string;
  turnCount?: number;
  tokens?: Partial<TokenTotals>;
  workspacePath?: string;
  error?: string;
  workerInstanceId?: string;
  taskArn?: string;
  linearUrl?: string;
  pullRequestUrl?: string;
  logPath?: string;
  logUrl?: string;
  logNamespace?: string;
  logStream?: string;
  logGroupName?: string;
  logStreamName?: string;
}

export interface WorkerDispatchRequest {
  repo: HostedRepo;
  issue: IssueSummary;
  workflow: EffectiveWorkflowConfig;
  promptTemplate: string;
  attempt?: number;
}

export interface SchedulerState {
  claimedIssueIds: Set<string>;
  runningIssueIds: Set<string>;
}

export interface CandidateSelectionInput {
  issue: IssueSummary;
  schedulerState: SchedulerState;
  workflow: EffectiveWorkflowConfig;
  runningByState: Record<string, number>;
}

export interface SecretReference {
  name: string;
  arn?: string;
}

export interface DispatchJob {
  kind: "dispatch";
  repoId: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number;
}

export interface RefreshJob {
  kind: "refresh";
  repoId: string;
  requestedAt: string;
}

export interface CancelJob {
  kind: "cancel";
  repoId: string;
  issueId: string;
  issueIdentifier?: string;
  reason: string;
}

export interface WorkerEventJob {
  kind: "worker-event";
  repoId: string;
  issueId: string;
  issueIdentifier: string;
  event: string;
  at: string;
  payload: WorkerEventEnvelope;
}

export type QueueJob = DispatchJob | RefreshJob | CancelJob | WorkerEventJob;
