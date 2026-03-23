import { Pool, type QueryResultRow } from "pg";

import type { IssueRunDetail, RepoStateResponse } from "@rockband/shared";

import {
  buildRepoState,
  cloneManagedRepo,
  cloneRuntime,
  emptyRuntime,
  type ControlPlaneStore,
  type ManagedRepo,
  type RepoCreateInput,
  type RuntimeIssueProjection,
} from "./store.js";

export class PostgresControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly pool: Pool) {}

  async createOrUpdateRepo(input: RepoCreateInput): Promise<ManagedRepo> {
    const existing = await this.getRepo(input.id);
    const now = new Date().toISOString();
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
      cloudProvider: input.cloudProvider ?? existing?.cloudProvider ?? "aws",
      deploymentEnvironment: input.deploymentEnvironment ?? existing?.deploymentEnvironment ?? "staging",
      controlPlaneBaseUrl: input.controlPlaneBaseUrl ?? existing?.controlPlaneBaseUrl,
      setupStatus: existing?.setupStatus ?? {
        signedIn: true,
        githubConnected: true,
        linearConnected: true,
        serviceTokenConfigured: true,
        workflowPresent: false,
        workflowValid: false,
        orchestrationEnabled: false,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      linearApiKey: input.linearApiKey,
      validation: existing?.validation,
      promptTemplate: existing?.promptTemplate,
      latestError: existing?.latestError,
      workflowContent: existing?.workflowContent,
      runtime: existing?.runtime ?? emptyRuntime(),
    };

    await this.pool.query(
      `
        insert into hosted_repos (
          id, owner, repo, full_name, github_installation_id, linear_project_slug, linear_secret_name,
          repo_root, orchestration_enabled, cloud_provider, deployment_environment, control_plane_base_url,
          setup_status, latest_error, workflow_validation, workflow_content, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13::jsonb, $14, $15::jsonb, $16, $17::timestamptz, $18::timestamptz
        )
        on conflict (id) do update set
          owner = excluded.owner,
          repo = excluded.repo,
          full_name = excluded.full_name,
          github_installation_id = excluded.github_installation_id,
          linear_project_slug = excluded.linear_project_slug,
          linear_secret_name = excluded.linear_secret_name,
          repo_root = excluded.repo_root,
          orchestration_enabled = excluded.orchestration_enabled,
          cloud_provider = excluded.cloud_provider,
          deployment_environment = excluded.deployment_environment,
          control_plane_base_url = excluded.control_plane_base_url,
          setup_status = excluded.setup_status,
          latest_error = excluded.latest_error,
          workflow_validation = excluded.workflow_validation,
          workflow_content = excluded.workflow_content,
          updated_at = excluded.updated_at
      `,
      [
        repo.id,
        repo.owner,
        repo.repo,
        repo.fullName,
        repo.githubInstallationId,
        repo.linearProjectSlug,
        repo.linearSecretName ?? null,
        repo.repoRoot ?? null,
        repo.orchestrationEnabled,
        repo.cloudProvider,
        repo.deploymentEnvironment,
        repo.controlPlaneBaseUrl ?? null,
        JSON.stringify(repo.setupStatus),
        repo.latestError ?? null,
        repo.validation ? JSON.stringify(repo.validation) : null,
        repo.workflowContent ?? null,
        repo.createdAt,
        repo.updatedAt,
      ],
    );

    await this.persistRuntime(repo);
    return cloneManagedRepo(repo);
  }

  async getRepo(repoId: string): Promise<ManagedRepo | undefined> {
    const repoResult = await this.pool.query(
      `
        select *
        from hosted_repos
        where id = $1
      `,
      [repoId],
    );

    const row = repoResult.rows[0];
    if (!row) {
      return undefined;
    }

    const runtime = await this.loadRuntime(repoId);
    return {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      fullName: row.full_name,
      githubInstallationId: row.github_installation_id,
      linearProjectSlug: row.linear_project_slug,
      linearSecretName: row.linear_secret_name ?? undefined,
      repoRoot: row.repo_root ?? undefined,
      orchestrationEnabled: row.orchestration_enabled,
      cloudProvider: row.cloud_provider ?? "aws",
      deploymentEnvironment: row.deployment_environment ?? "staging",
      controlPlaneBaseUrl: row.control_plane_base_url ?? undefined,
      setupStatus: row.setup_status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      validation: row.workflow_validation ?? undefined,
      latestError: row.latest_error ?? undefined,
      workflowContent: row.workflow_content ?? undefined,
      promptTemplate: row.workflow_validation?.promptTemplate ?? undefined,
      runtime,
    };
  }

  async listRepos(): Promise<ManagedRepo[]> {
    const result = await this.pool.query(`select id from hosted_repos order by updated_at desc`);
    const repos = await Promise.all(result.rows.map((row: QueryResultRow) => this.getRepo(String(row.id))));
    return repos.filter((repo): repo is ManagedRepo => repo !== undefined);
  }

  async updateRepo(repo: ManagedRepo): Promise<ManagedRepo> {
    return this.createOrUpdateRepo({
      id: repo.id,
      owner: repo.owner,
      repo: repo.repo,
      githubInstallationId: repo.githubInstallationId,
      linearProjectSlug: repo.linearProjectSlug,
      linearSecretName: repo.linearSecretName,
      repoRoot: repo.repoRoot,
      cloudProvider: repo.cloudProvider,
      deploymentEnvironment: repo.deploymentEnvironment,
      controlPlaneBaseUrl: repo.controlPlaneBaseUrl,
    }).then(async (created) => {
      created.setupStatus = repo.setupStatus;
      created.validation = repo.validation;
      created.latestError = repo.latestError;
      created.workflowContent = repo.workflowContent;
      created.promptTemplate = repo.promptTemplate;
      created.orchestrationEnabled = repo.orchestrationEnabled;
      created.runtime = cloneRuntime(repo.runtime);
      await this.pool.query(
        `
          update hosted_repos
          set setup_status = $2::jsonb,
              latest_error = $3,
              workflow_validation = $4::jsonb,
              workflow_content = $5,
              orchestration_enabled = $6,
              updated_at = now()
          where id = $1
        `,
        [
          repo.id,
          JSON.stringify(repo.setupStatus),
          repo.latestError ?? null,
          repo.validation ? JSON.stringify(repo.validation) : null,
          repo.workflowContent ?? null,
          repo.orchestrationEnabled,
        ],
      );
      await this.persistRuntime(created);
      return cloneManagedRepo(created);
    });
  }

  async getIssue(repoId: string, issueIdentifier: string): Promise<RuntimeIssueProjection | undefined> {
    const runtime = await this.loadRuntime(repoId);
    return runtime.issues.get(issueIdentifier);
  }

  async toRepoState(repoId: string): Promise<RepoStateResponse> {
    const repo = await this.getRepo(repoId);
    if (!repo) {
      throw new Error(`repo_not_found:${repoId}`);
    }
    return buildRepoState(repo);
  }

  async toIssueDetail(repoId: string, issueIdentifier: string): Promise<IssueRunDetail | undefined> {
    const repo = await this.getRepo(repoId);
    if (!repo) {
      return undefined;
    }
    const issue = repo.runtime.issues.get(issueIdentifier);
    if (!issue) {
      return undefined;
    }

    return {
      issueIdentifier: issue.issue.identifier,
      issueId: issue.issue.id,
      status: issue.status,
      workspace: { path: issue.workspacePath },
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

  private async loadRuntime(repoId: string) {
    const runtime = emptyRuntime();
    const issueRows = await this.pool.query(
      `
        select projection
        from issue_runtime_projection
        where repo_id = $1
      `,
      [repoId],
    );

    for (const row of issueRows.rows) {
      const projection = row.projection as RuntimeIssueProjection;
      runtime.issues.set(projection.issue.identifier, projection);
      if (projection.running) {
        runtime.running.set(projection.issue.identifier, projection.running);
      }
      if (projection.retry) {
        runtime.retrying.set(projection.issue.identifier, projection.retry);
      }
      if (projection.status === "running") {
        runtime.claimedIssueIds.add(projection.issue.id);
        runtime.runningIssueIds.add(projection.issue.id);
      }
    }

    const totalsResult = await this.pool.query(
      `
        select
          coalesce(sum((projection->'running'->'tokens'->>'inputTokens')::int), 0) as input_tokens,
          coalesce(sum((projection->'running'->'tokens'->>'outputTokens')::int), 0) as output_tokens,
          coalesce(sum((projection->'running'->'tokens'->>'totalTokens')::int), 0) as total_tokens
        from issue_runtime_projection
        where repo_id = $1 and projection->>'status' = 'idle'
      `,
      [repoId],
    );
    runtime.completedTotals = {
      inputTokens: Number(totalsResult.rows[0]?.input_tokens ?? 0),
      outputTokens: Number(totalsResult.rows[0]?.output_tokens ?? 0),
      totalTokens: Number(totalsResult.rows[0]?.total_tokens ?? 0),
      secondsRunning: 0,
    };

    return runtime;
  }

  private async persistRuntime(repo: ManagedRepo): Promise<void> {
    await this.pool.query(`delete from issue_runtime_projection where repo_id = $1`, [repo.id]);

    for (const projection of repo.runtime.issues.values()) {
      await this.pool.query(
        `
          insert into issue_runtime_projection (repo_id, issue_identifier, status, projection, updated_at)
          values ($1, $2, $3, $4::jsonb, now())
        `,
        [repo.id, projection.issue.identifier, projection.status, JSON.stringify(projection)],
      );
    }
  }
}
