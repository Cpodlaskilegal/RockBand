import type {
  CloudProvider,
  DeploymentEnvironment,
  HostedRepo,
  IssueRunDetail,
  IssueSummary,
  RecentEvent,
  RepoStateResponse,
  RetrySummary,
  RunSummary,
  SetupStatus,
  TokenTotals,
  WorkflowValidationResult,
} from "@rockband/shared";

export interface ManagedRepo extends HostedRepo {
  linearApiKey?: string;
  validation?: WorkflowValidationResult;
  promptTemplate?: string;
  latestError?: string;
  workflowContent?: string;
  runtime: RepoRuntimeProjection;
}

export interface RuntimeIssueProjection {
  issue: IssueSummary;
  status: "running" | "retrying" | "idle";
  workspacePath: string;
  restartCount: number;
  currentRetryAttempt: number;
  running?: RunSummary;
  retry?: RetrySummary | null;
  logs: {
    codexSessionLogs: { label: string; path?: string; url?: string | null }[];
  };
  recentEvents: RecentEvent[];
  lastError?: string | null;
  tracked: Record<string, unknown>;
}

export interface RepoRuntimeProjection {
  issues: Map<string, RuntimeIssueProjection>;
  running: Map<string, RunSummary>;
  retrying: Map<string, RetrySummary>;
  claimedIssueIds: Set<string>;
  runningIssueIds: Set<string>;
  completedTotals: TokenTotals;
}

export interface RepoCreateInput {
  id: string;
  owner: string;
  repo: string;
  githubInstallationId: string;
  linearProjectSlug: string;
  linearApiKey?: string;
  linearSecretName?: string;
  repoRoot?: string;
  cloudProvider?: CloudProvider;
  deploymentEnvironment?: DeploymentEnvironment;
  controlPlaneBaseUrl?: string;
}

export interface ControlPlaneStore {
  createOrUpdateRepo(input: RepoCreateInput): Promise<ManagedRepo>;
  getRepo(repoId: string): Promise<ManagedRepo | undefined>;
  listRepos(): Promise<ManagedRepo[]>;
  updateRepo(repo: ManagedRepo): Promise<ManagedRepo>;
  getIssue(repoId: string, issueIdentifier: string): Promise<RuntimeIssueProjection | undefined>;
  toRepoState(repoId: string): Promise<RepoStateResponse>;
  toIssueDetail(repoId: string, issueIdentifier: string): Promise<IssueRunDetail | undefined>;
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly repos = new Map<string, ManagedRepo>();

  async createOrUpdateRepo(input: RepoCreateInput): Promise<ManagedRepo> {
    const now = new Date().toISOString();
    const existing = this.repos.get(input.id);
    const setupStatus: SetupStatus = {
      signedIn: true,
      githubConnected: true,
      linearConnected: true,
      serviceTokenConfigured: existing?.setupStatus.serviceTokenConfigured ?? true,
      workflowPresent: existing?.setupStatus.workflowPresent ?? false,
      workflowValid: existing?.setupStatus.workflowValid ?? false,
      orchestrationEnabled: existing?.setupStatus.orchestrationEnabled ?? false,
      lastValidatedAt: existing?.setupStatus.lastValidatedAt,
      lastError: existing?.setupStatus.lastError,
    };

    const repo: ManagedRepo = {
      id: input.id,
      owner: input.owner,
      repo: input.repo,
      fullName: `${input.owner}/${input.repo}`,
      githubInstallationId: input.githubInstallationId,
      linearProjectSlug: input.linearProjectSlug,
      linearSecretName: input.linearSecretName ?? existing?.linearSecretName,
      repoRoot: input.repoRoot ?? existing?.repoRoot,
      orchestrationEnabled: existing?.orchestrationEnabled ?? false,
      cloudProvider: input.cloudProvider ?? existing?.cloudProvider ?? "local",
      deploymentEnvironment: input.deploymentEnvironment ?? existing?.deploymentEnvironment ?? "local",
      controlPlaneBaseUrl: input.controlPlaneBaseUrl ?? existing?.controlPlaneBaseUrl,
      setupStatus,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      linearApiKey: input.linearApiKey ?? existing?.linearApiKey,
      validation: existing?.validation,
      promptTemplate: existing?.promptTemplate,
      workflowContent: existing?.workflowContent,
      latestError: existing?.latestError,
      runtime: existing?.runtime ?? emptyRuntime(),
    };

    this.repos.set(repo.id, repo);
    return cloneManagedRepo(repo);
  }

  async getRepo(repoId: string): Promise<ManagedRepo | undefined> {
    const repo = this.repos.get(repoId);
    return repo ? cloneManagedRepo(repo) : undefined;
  }

  async listRepos(): Promise<ManagedRepo[]> {
    return [...this.repos.values()].map(cloneManagedRepo);
  }

  async updateRepo(repo: ManagedRepo): Promise<ManagedRepo> {
    const updated = cloneManagedRepo({
      ...repo,
      updatedAt: new Date().toISOString(),
    });
    this.repos.set(updated.id, updated);
    return cloneManagedRepo(updated);
  }

  async getIssue(repoId: string, issueIdentifier: string): Promise<RuntimeIssueProjection | undefined> {
    const repo = this.repos.get(repoId);
    const issue = repo?.runtime.issues.get(issueIdentifier);
    return issue ? cloneIssueProjection(issue) : undefined;
  }

  async toRepoState(repoId: string): Promise<RepoStateResponse> {
    const repo = this.getRepoOrThrow(repoId);
    return buildRepoState(repo);
  }

  async toIssueDetail(repoId: string, issueIdentifier: string): Promise<IssueRunDetail | undefined> {
    const repo = this.getRepoOrThrow(repoId);
    const issue = repo.runtime.issues.get(issueIdentifier);
    if (!issue) {
      return undefined;
    }

    return {
      issueIdentifier: issue.issue.identifier,
      issueId: issue.issue.id,
      status: issue.status,
      workspace: {
        path: issue.workspacePath,
      },
      attempts: {
        restartCount: issue.restartCount,
        currentRetryAttempt: issue.currentRetryAttempt,
      },
      running: issue.running,
      retry: issue.retry,
      logs: issue.logs,
      recentEvents: issue.recentEvents,
      lastError: issue.lastError,
      tracked: issue.tracked,
    };
  }

  private getRepoOrThrow(repoId: string): ManagedRepo {
    const repo = this.repos.get(repoId);
    if (!repo) {
      throw new Error(`repo_not_found:${repoId}`);
    }
    return cloneManagedRepo(repo);
  }
}

export function buildRepoState(repo: ManagedRepo): RepoStateResponse {
  const running = [...repo.runtime.running.values()];
  const retrying = [...repo.runtime.retrying.values()];
  const runningTotals = running.reduce<TokenTotals>(
    (totals, entry) => ({
      inputTokens: totals.inputTokens + entry.tokens.inputTokens,
      outputTokens: totals.outputTokens + entry.tokens.outputTokens,
      totalTokens: totals.totalTokens + entry.tokens.totalTokens,
      secondsRunning: (totals.secondsRunning ?? 0) + elapsedSeconds(entry.startedAt),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    repo: {
      ...repo,
      runtime: undefined,
      linearApiKey: undefined,
      validation: undefined,
      promptTemplate: undefined,
      latestError: undefined,
      workflowContent: undefined,
    } as HostedRepo,
    counts: {
      running: running.length,
      retrying: retrying.length,
    },
    running,
    retrying,
    codexTotals: {
      inputTokens: repo.runtime.completedTotals.inputTokens + runningTotals.inputTokens,
      outputTokens: repo.runtime.completedTotals.outputTokens + runningTotals.outputTokens,
      totalTokens: repo.runtime.completedTotals.totalTokens + runningTotals.totalTokens,
      secondsRunning: (repo.runtime.completedTotals.secondsRunning ?? 0) + (runningTotals.secondsRunning ?? 0),
    },
    latestError: repo.latestError,
    validation: repo.validation,
  };
}

export function emptyRuntime(): RepoRuntimeProjection {
  return {
    issues: new Map(),
    running: new Map(),
    retrying: new Map(),
    claimedIssueIds: new Set(),
    runningIssueIds: new Set(),
    completedTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
  };
}

export function cloneManagedRepo(repo: ManagedRepo): ManagedRepo {
  return {
    ...repo,
    setupStatus: { ...repo.setupStatus },
    runtime: cloneRuntime(repo.runtime),
  };
}

export function cloneRuntime(runtime: RepoRuntimeProjection): RepoRuntimeProjection {
  return {
    issues: new Map([...runtime.issues.entries()].map(([key, value]) => [key, cloneIssueProjection(value)])),
    running: new Map([...runtime.running.entries()].map(([key, value]) => [key, { ...value, tokens: { ...value.tokens } }])),
    retrying: new Map([...runtime.retrying.entries()].map(([key, value]) => [key, { ...value }])),
    claimedIssueIds: new Set(runtime.claimedIssueIds),
    runningIssueIds: new Set(runtime.runningIssueIds),
    completedTotals: { ...runtime.completedTotals },
  };
}

export function cloneIssueProjection(issue: RuntimeIssueProjection): RuntimeIssueProjection {
  return {
    ...issue,
    issue: { ...issue.issue, labels: [...issue.issue.labels], blockedBy: [...issue.issue.blockedBy] },
    running: issue.running ? { ...issue.running, tokens: { ...issue.running.tokens } } : undefined,
    retry: issue.retry ? { ...issue.retry } : issue.retry,
    logs: {
      codexSessionLogs: issue.logs.codexSessionLogs.map((entry) => ({ ...entry })),
    },
    recentEvents: issue.recentEvents.map((event) => ({ ...event })),
    tracked: { ...issue.tracked },
  };
}

function elapsedSeconds(startedAt: string): number {
  return Math.max((Date.now() - new Date(startedAt).getTime()) / 1000, 0);
}
