import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildWorkspacePath,
  type CloudProvider,
  computeRetryDelayMs,
  type DeploymentEnvironment,
  isIssueEligible,
  sortCandidateIssues,
  type CancelJob,
  type ConnectRepoInput,
  type DispatchJob,
  type HostedRepo,
  type IssueSummary,
  type RefreshJob,
  type RepoStateResponse,
  type WorkerDispatchRequest,
  type WorkerEventEnvelope,
  type WorkerEventJob,
  validateHostedWorkflow,
} from "@rockband/shared";
import type { WorkerLauncher } from "@rockband/worker";

import { RepoEventBus } from "./eventBus.js";
import type { LinearGateway } from "./linear.js";
import type { JobQueue, QueueHandlers } from "./queues.js";
import type { SecretStore } from "./secrets.js";
import type { ControlPlaneStore, ManagedRepo, RuntimeIssueProjection } from "./store.js";

interface HostedSymphonyServiceOptions {
  store: ControlPlaneStore;
  queue: JobQueue;
  workerLauncher: WorkerLauncher;
  linearGateway: LinearGateway;
  secretStore: SecretStore;
  workerEventSecret?: string;
  baseUrl: string;
  cloudProvider: CloudProvider;
  deploymentEnvironment: DeploymentEnvironment;
}

export class HostedSymphonyService {
  readonly eventBus = new RepoEventBus();
  readonly workerEventSecret: string;
  readonly handlers: QueueHandlers;

  private readonly store: ControlPlaneStore;
  private readonly queue: JobQueue;
  private readonly workerLauncher: WorkerLauncher;
  private readonly linearGateway: LinearGateway;
  private readonly secretStore: SecretStore;
  private readonly baseUrl: string;
  private readonly cloudProvider: CloudProvider;
  private readonly deploymentEnvironment: DeploymentEnvironment;
  private readonly pollers = new Map<string, NodeJS.Timeout>();

  constructor(options: HostedSymphonyServiceOptions) {
    this.store = options.store;
    this.queue = options.queue;
    this.workerLauncher = options.workerLauncher;
    this.linearGateway = options.linearGateway;
    this.secretStore = options.secretStore;
    this.workerEventSecret = options.workerEventSecret ?? "dev-worker-secret";
    this.baseUrl = options.baseUrl;
    this.cloudProvider = options.cloudProvider;
    this.deploymentEnvironment = options.deploymentEnvironment;
    this.handlers = {
      dispatch: async (job) => this.processDispatchJob(job),
      refresh: async (job) => this.processRefreshJob(job),
      cancel: async (job) => this.processCancelJob(job),
      workerEvent: async (job) => this.processWorkerEventJob(job),
    };
  }

  async start(): Promise<void> {
    await this.queue.startConsumers?.(this.handlers);
  }

  async connectRepo(input: ConnectRepoInput): Promise<HostedRepo> {
    const repoId = `${input.owner}_${input.repo}`;
    const secret = await this.secretStore.putRepoLinearApiKey(repoId, input.linearApiKey);
    const repo = await this.store.createOrUpdateRepo({
      id: repoId,
      owner: input.owner,
      repo: input.repo,
      githubInstallationId: input.githubInstallationId,
      linearProjectSlug: input.linearProjectSlug,
      linearSecretName: secret.name,
      repoRoot: input.repoRoot,
      cloudProvider: input.cloudProvider ?? this.cloudProvider,
      deploymentEnvironment: input.deploymentEnvironment ?? this.deploymentEnvironment,
      controlPlaneBaseUrl: this.baseUrl,
    });

    if ((await this.linearGateway.listIssues(repo)).length === 0) {
      await this.linearGateway.seedIssues(repo.id, [
        {
          id: `${repo.id}_issue_1`,
          identifier: "RB-101",
          title: "Set up hosted Symphony alpha",
          description: "Seed issue for local development",
          priority: 2,
          state: "Todo",
          url: `https://linear.app/${input.linearProjectSlug}/issue/RB-101`,
          labels: ["seed"],
          blockedBy: [],
          createdAt: new Date().toISOString(),
        },
      ]);
    }

    await this.publishRepoState(repo.id);
    return sanitizeHostedRepo(repo);
  }

  async validateRepo(repoId: string): Promise<ManagedRepo> {
    const repo = await this.getRepo(repoId);
    const workflowPath = path.join(repo.repoRoot ?? process.cwd(), "WORKFLOW.md");
    const content = await readFile(workflowPath, "utf8");
    const validation = validateHostedWorkflow(content);
    repo.workflowContent = content;
    repo.validation = validation;
    repo.promptTemplate = validation.promptTemplate;
    repo.setupStatus.workflowPresent = true;
    repo.setupStatus.workflowValid = validation.valid;
    repo.setupStatus.lastValidatedAt = new Date().toISOString();
    repo.setupStatus.lastError = validation.errors[0];
    repo.latestError = validation.errors[0];
    const updated = await this.store.updateRepo(repo);
    await this.publishRepoState(updated.id);
    return updated;
  }

  async enableRepo(repoId: string, enabled = true): Promise<HostedRepo> {
    const repo = await this.getRepo(repoId);
    repo.orchestrationEnabled = enabled;
    repo.setupStatus.orchestrationEnabled = enabled;
    const updated = await this.store.updateRepo(repo);

    this.stopPoller(repoId);
    if (enabled) {
      const intervalMs = updated.validation?.effectiveConfig?.polling.intervalMs ?? 30000;
      const timer = setInterval(() => {
        void this.queue.publishRefresh({
          kind: "refresh",
          repoId,
          requestedAt: new Date().toISOString(),
        });
      }, intervalMs);
      this.pollers.set(repoId, timer);
      await this.queue.publishRefresh({
        kind: "refresh",
        repoId,
        requestedAt: new Date().toISOString(),
      });
    }

    await this.publishRepoState(updated.id);
    return sanitizeHostedRepo(updated);
  }

  async refreshRepo(repoId: string): Promise<void> {
    await this.queue.publishRefresh({
      kind: "refresh",
      repoId,
      requestedAt: new Date().toISOString(),
    });
  }

  async getRepoState(repoId: string): Promise<RepoStateResponse> {
    return this.store.toRepoState(repoId);
  }

  async getIssueDetail(repoId: string, issueIdentifier: string) {
    return this.store.toIssueDetail(repoId, issueIdentifier);
  }

  async enqueueWorkerEvent(event: WorkerEventEnvelope): Promise<void> {
    await this.queue.publishWorkerEvent({
      kind: "worker-event",
      repoId: event.repoId,
      issueId: event.issueId,
      issueIdentifier: event.issueIdentifier,
      event: event.event,
      at: event.at,
      payload: event,
    });
  }

  private async processRefreshJob(job: RefreshJob): Promise<void> {
    await this.tickRepo(job.repoId);
  }

  private async processDispatchJob(job: DispatchJob): Promise<void> {
    const repo = await this.getRepo(job.repoId);
    if (!repo.validation?.effectiveConfig || !repo.promptTemplate) {
      return;
    }

    const issues = await this.linearGateway.listIssues(repo);
    const issue = issues.find((candidate) => candidate.id === job.issueId || candidate.identifier === job.issueIdentifier);
    if (!issue) {
      return;
    }

    const request: WorkerDispatchRequest = {
      repo: sanitizeHostedRepo(repo),
      issue,
      workflow: repo.validation.effectiveConfig,
      promptTemplate: repo.promptTemplate,
      attempt: job.attempt,
    };

    try {
      const launch = await this.workerLauncher.dispatch(request);
      const projection = this.ensureIssueProjection(repo, issue);
      projection.status = "running";
      const running = {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        state: issue.state,
        workerInstanceId: launch.workerInstanceId,
        taskArn: launch.taskArn,
        turnCount: 0,
        lastEvent: "dispatch_queued",
        lastMessage: "Worker task submitted",
        startedAt: new Date().toISOString(),
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        logUrl: launch.logUrl ?? null,
        logNamespace: launch.logNamespace ?? null,
        logStream: launch.logStream ?? null,
      };
      projection.running = running;
      projection.logs.codexSessionLogs =
        launch.logUrl || launch.logNamespace || launch.logStream
          ? [
              {
                label: "latest",
                url: launch.logUrl ?? buildManagedLogUrl(launch.logNamespace, launch.logStream) ?? null,
              },
            ]
          : [];
      projection.tracked.taskArn = launch.taskArn;
      projection.tracked.workerInstanceId = launch.workerInstanceId;
      repo.runtime.running.set(issue.identifier, running);
      await this.store.updateRepo(repo);
      await this.publishRepoState(repo.id);
    } catch (error) {
      await this.failIssueWithRetry(
        repo,
        issue,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async processCancelJob(job: CancelJob): Promise<void> {
    const repo = await this.getRepo(job.repoId);
    const issueProjection =
      (await this.store.getIssue(job.repoId, job.issueIdentifier ?? "")) ??
      [...repo.runtime.issues.values()].find((entry) => entry.issue.id === job.issueId);

    const taskArn = issueProjection?.running?.taskArn ?? (issueProjection?.tracked.taskArn as string | undefined);
    const workerInstanceId =
      issueProjection?.running?.workerInstanceId ?? (issueProjection?.tracked.workerInstanceId as string | undefined);

    if (!taskArn && !workerInstanceId) {
      return;
    }

    await this.workerLauncher.cancel({
      taskArn,
      workerInstanceId,
      reason: job.reason,
    });
  }

  private async processWorkerEventJob(job: WorkerEventJob): Promise<void> {
    await this.handleWorkerEvent(job.payload);
  }

  async tickRepo(repoId: string): Promise<void> {
    const repo = await this.getRepo(repoId);
    if (!repo.validation?.valid) {
      try {
        await this.validateRepo(repoId);
      } catch (error) {
        repo.latestError = error instanceof Error ? error.message : String(error);
        repo.setupStatus.lastError = repo.latestError;
        await this.store.updateRepo(repo);
        await this.publishRepoState(repo.id);
        return;
      }
    }

    if (!repo.validation?.valid || !repo.validation.effectiveConfig || !repo.promptTemplate || !repo.orchestrationEnabled) {
      return;
    }

    const issues = sortCandidateIssues(await this.linearGateway.listIssues(repo));
    const runningByState = this.computeRunningByState(repo);
    const maxConcurrentAgents = repo.validation.effectiveConfig.agent.maxConcurrentAgents;

    for (const issue of issues) {
      if (repo.runtime.running.size >= maxConcurrentAgents) {
        break;
      }

      if (
        !isIssueEligible({
          issue,
          workflow: repo.validation.effectiveConfig,
          schedulerState: {
            claimedIssueIds: repo.runtime.claimedIssueIds,
            runningIssueIds: repo.runtime.runningIssueIds,
          },
          runningByState,
        })
      ) {
        continue;
      }

      const projection = this.ensureIssueProjection(repo, issue);
      projection.status = "running";
      repo.runtime.claimedIssueIds.add(issue.id);
      repo.runtime.runningIssueIds.add(issue.id);
      repo.runtime.running.set(issue.identifier, {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        state: issue.state,
        turnCount: 0,
        lastEvent: "dispatch_pending",
        lastMessage: "Queued for managed worker launch",
        startedAt: new Date().toISOString(),
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      });

      await this.store.updateRepo(repo);
      await this.queue.publishDispatch({
        kind: "dispatch",
        repoId: repo.id,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        attempt: projection.currentRetryAttempt || 1,
      });
      runningByState[issue.state] = (runningByState[issue.state] ?? 0) + 1;
    }

    await this.publishRepoState(repo.id);
  }

  async handleWorkerEvent(event: WorkerEventEnvelope): Promise<void> {
    const repo = await this.getRepo(event.repoId);
    const issueProjection = this.ensureIssueProjection(repo, {
      id: event.issueId,
      identifier: event.issueIdentifier,
      title: event.issueIdentifier,
      state: "In Progress",
      labels: [],
      blockedBy: [],
    });

    issueProjection.recentEvents.unshift({
      at: event.at,
      event: event.event,
      message: event.message ?? event.error ?? event.event,
    });
    issueProjection.recentEvents = issueProjection.recentEvents.slice(0, 20);

    if (event.logPath || event.logUrl || event.logNamespace || event.logStream || event.logGroupName || event.logStreamName) {
      issueProjection.logs.codexSessionLogs = [
        {
          label: "latest",
          path: event.logPath,
          url:
            event.logUrl ??
            buildManagedLogUrl(
              event.logNamespace ?? event.logGroupName,
              event.logStream ?? event.logStreamName,
            ) ??
            null,
        },
      ];
    }

    if (event.workspacePath) {
      issueProjection.workspacePath = event.workspacePath;
    }

    if (event.status === "running" || event.event === "notification" || event.event === "session_started") {
      issueProjection.status = "running";
      repo.runtime.claimedIssueIds.add(event.issueId);
      repo.runtime.runningIssueIds.add(event.issueId);
      const existing = repo.runtime.running.get(event.issueIdentifier);
      const running = {
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
        state: issueProjection.issue.state,
        sessionId: event.sessionId ?? existing?.sessionId,
        workerInstanceId: event.workerInstanceId ?? existing?.workerInstanceId,
        taskArn: event.taskArn ?? existing?.taskArn,
        turnCount: event.turnCount ?? existing?.turnCount ?? 0,
        lastEvent: event.event,
        lastMessage: event.message ?? existing?.lastMessage,
        startedAt: existing?.startedAt ?? event.at,
        lastEventAt: event.at,
        tokens: {
          inputTokens: event.tokens?.inputTokens ?? existing?.tokens.inputTokens ?? 0,
          outputTokens: event.tokens?.outputTokens ?? existing?.tokens.outputTokens ?? 0,
          totalTokens: event.tokens?.totalTokens ?? existing?.tokens.totalTokens ?? 0,
        },
        logUrl:
          event.logUrl ??
          existing?.logUrl ??
          buildManagedLogUrl(
            event.logNamespace ?? event.logGroupName ?? existing?.logNamespace ?? existing?.logGroupName ?? undefined,
            event.logStream ?? event.logStreamName ?? existing?.logStream ?? existing?.logStreamName ?? undefined,
          ) ??
          null,
        logNamespace: event.logNamespace ?? existing?.logNamespace ?? null,
        logStream: event.logStream ?? existing?.logStream ?? null,
        logGroupName: event.logGroupName ?? existing?.logGroupName ?? null,
        logStreamName: event.logStreamName ?? existing?.logStreamName ?? null,
        linearUrl: event.linearUrl ?? existing?.linearUrl ?? null,
        pullRequestUrl: event.pullRequestUrl ?? existing?.pullRequestUrl ?? null,
      };
      issueProjection.running = running;
      repo.runtime.running.set(event.issueIdentifier, running);
      issueProjection.tracked.taskArn = running.taskArn;
      issueProjection.tracked.workerInstanceId = running.workerInstanceId;
    }

    if (event.status === "completed" || event.event === "turn_completed") {
      const running = issueProjection.running;
      if (running) {
        repo.runtime.completedTotals.inputTokens += running.tokens.inputTokens;
        repo.runtime.completedTotals.outputTokens += running.tokens.outputTokens;
        repo.runtime.completedTotals.totalTokens += running.tokens.totalTokens;
        repo.runtime.completedTotals.secondsRunning =
          (repo.runtime.completedTotals.secondsRunning ?? 0) +
          Math.max((Date.now() - new Date(running.startedAt).getTime()) / 1000, 0);
      }

      issueProjection.status = "idle";
      issueProjection.retry = null;
      issueProjection.currentRetryAttempt = 0;
      issueProjection.running = undefined;
      repo.runtime.claimedIssueIds.delete(event.issueId);
      repo.runtime.runningIssueIds.delete(event.issueId);
      repo.runtime.running.delete(event.issueIdentifier);
    }

    if (event.status === "failed" || event.event === "turn_failed" || event.event === "startup_failed" || event.event === "turn_cancelled") {
      await this.failIssueWithRetry(
        repo,
        issueProjection.issue,
        event.error ?? event.message ?? "Worker failure",
        issueProjection,
      );
      return;
    }

    await this.store.updateRepo(repo);
    await this.publishRepoState(repo.id);
  }

  private async failIssueWithRetry(
    repo: ManagedRepo,
    issue: IssueSummary,
    reason: string,
    projection = this.ensureIssueProjection(repo, issue),
  ): Promise<void> {
    repo.runtime.claimedIssueIds.delete(issue.id);
    repo.runtime.runningIssueIds.delete(issue.id);
    repo.runtime.running.delete(issue.identifier);
    projection.status = "retrying";
    projection.lastError = reason;
    projection.currentRetryAttempt += 1;
    projection.retry = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: projection.currentRetryAttempt,
      dueAt: new Date(
        Date.now() +
          computeRetryDelayMs(
            projection.currentRetryAttempt,
            repo.validation?.effectiveConfig?.agent.maxRetryBackoffMs ?? 300000,
          ),
      ).toISOString(),
      error: reason,
    };
    repo.runtime.retrying.set(issue.identifier, projection.retry);

    await this.store.updateRepo(repo);
    await this.publishRepoState(repo.id);
    await this.queue.publishRefresh(
      {
        kind: "refresh",
        repoId: repo.id,
        requestedAt: new Date().toISOString(),
      },
      computeRetryDelayMs(
        projection.currentRetryAttempt,
        repo.validation?.effectiveConfig?.agent.maxRetryBackoffMs ?? 300000,
      ),
    );
  }

  private ensureIssueProjection(repo: ManagedRepo, issue: IssueSummary): RuntimeIssueProjection {
    const existing = repo.runtime.issues.get(issue.identifier);
    if (existing) {
      existing.issue = issue;
      return existing;
    }

    const projection: RuntimeIssueProjection = {
      issue,
      status: "idle",
      workspacePath: buildWorkspacePath("/mnt/symphony", repo.id, issue.identifier),
      restartCount: 0,
      currentRetryAttempt: 0,
      logs: {
        codexSessionLogs: [],
      },
      recentEvents: [],
      tracked: {},
    };

    repo.runtime.issues.set(issue.identifier, projection);
    return projection;
  }

  private computeRunningByState(repo: ManagedRepo): Record<string, number> {
    const state: Record<string, number> = {};
    for (const issue of repo.runtime.issues.values()) {
      if (issue.status === "running") {
        state[issue.issue.state] = (state[issue.issue.state] ?? 0) + 1;
      }
    }
    return state;
  }

  private async publishRepoState(repoId: string): Promise<void> {
    this.eventBus.publish(repoId, await this.store.toRepoState(repoId));
  }

  private stopPoller(repoId: string): void {
    const existing = this.pollers.get(repoId);
    if (existing) {
      clearInterval(existing);
      this.pollers.delete(repoId);
    }
  }

  private async getRepo(repoId: string): Promise<ManagedRepo> {
    const repo = await this.store.getRepo(repoId);
    if (!repo) {
      throw new Error(`repo_not_found:${repoId}`);
    }
    return repo;
  }
}

function sanitizeHostedRepo(repo: ManagedRepo): HostedRepo {
  return {
    id: repo.id,
    owner: repo.owner,
    repo: repo.repo,
    fullName: repo.fullName,
    githubInstallationId: repo.githubInstallationId,
    linearProjectSlug: repo.linearProjectSlug,
    linearSecretName: repo.linearSecretName,
    repoRoot: repo.repoRoot,
    orchestrationEnabled: repo.orchestrationEnabled,
    cloudProvider: repo.cloudProvider,
    deploymentEnvironment: repo.deploymentEnvironment,
    controlPlaneBaseUrl: repo.controlPlaneBaseUrl,
    setupStatus: repo.setupStatus,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function buildManagedLogUrl(logNamespace?: string | null, logStream?: string | null): string | undefined {
  if (!logNamespace || !logStream) {
    return undefined;
  }

  if (logNamespace.startsWith("/ecs/")) {
    return `cloudwatch://${logNamespace}/${logStream}`;
  }

  return `logs://${logNamespace}/${logStream}`;
}
