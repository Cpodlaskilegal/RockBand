import type { IssueSummary } from "@rockband/shared";

import type { ManagedRepo } from "./store.js";
import type { SecretStore } from "./secrets.js";

export interface LinearGateway {
  listIssues(repo: ManagedRepo): Promise<IssueSummary[]>;
  seedIssues(repoId: string, issues: IssueSummary[]): Promise<void>;
}

export class InMemoryLinearGateway implements LinearGateway {
  private readonly issuesByRepo = new Map<string, IssueSummary[]>();

  async listIssues(repo: ManagedRepo): Promise<IssueSummary[]> {
    return this.issuesByRepo.get(repo.id) ?? [];
  }

  async seedIssues(repoId: string, issues: IssueSummary[]): Promise<void> {
    this.issuesByRepo.set(repoId, issues);
  }
}

export class LinearHttpGateway implements LinearGateway {
  private readonly endpoint = "https://api.linear.app/graphql";

  constructor(private readonly secretStore: SecretStore) {}

  async listIssues(repo: ManagedRepo): Promise<IssueSummary[]> {
    if (!repo.linearSecretName) {
      throw new Error(`linear_secret_missing:${repo.id}`);
    }

    const apiKey = await this.secretStore.getSecretValue(repo.linearSecretName);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: apiKey,
      },
      body: JSON.stringify({
        query: `
          query HostedSymphonyIssues($projectSlug: String!) {
            projects(filter: { slug: { eq: $projectSlug } }, first: 1) {
              nodes {
                id
                issues(first: 50) {
                  nodes {
                    id
                    identifier
                    title
                    description
                    priority
                    branchName
                    createdAt
                    updatedAt
                    url
                    state { name }
                    labels(first: 20) { nodes { name } }
                    blockedByIssues(first: 20) { nodes { id identifier state { name } } }
                  }
                }
              }
            }
          }
        `,
        variables: {
          projectSlug: repo.linearProjectSlug,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`linear_api_status:${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: {
        projects?: {
          nodes?: Array<{
            issues?: {
              nodes?: Array<Record<string, unknown>>;
            };
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (payload.errors?.length) {
      throw new Error(`linear_graphql_errors:${payload.errors.map((entry) => entry.message).join("; ")}`);
    }

    const nodes = payload.data?.projects?.nodes?.[0]?.issues?.nodes ?? [];
    return nodes.map(normalizeLinearIssue);
  }

  async seedIssues(): Promise<void> {
    return;
  }
}

function normalizeLinearIssue(issue: Record<string, unknown>): IssueSummary {
  const labels =
    ((issue.labels as { nodes?: Array<{ name?: string }> } | undefined)?.nodes ?? [])
      .map((label) => label.name)
      .filter((value): value is string => Boolean(value));

  const blockedBy =
    ((issue.blockedByIssues as { nodes?: Array<{ id?: string; identifier?: string; state?: { name?: string } }> } | undefined)
      ?.nodes ?? [])
      .map((blocker) => ({
        id: blocker.id ?? null,
        identifier: blocker.identifier ?? null,
        state: blocker.state?.name ?? null,
      }));

  return {
    id: String(issue.id ?? ""),
    identifier: String(issue.identifier ?? ""),
    title: String(issue.title ?? ""),
    description: typeof issue.description === "string" ? issue.description : null,
    priority: typeof issue.priority === "number" ? issue.priority : null,
    state: String((issue.state as { name?: string } | undefined)?.name ?? ""),
    branchName: typeof issue.branchName === "string" ? issue.branchName : null,
    url: typeof issue.url === "string" ? issue.url : null,
    labels,
    blockedBy,
    createdAt: typeof issue.createdAt === "string" ? issue.createdAt : null,
    updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : null,
  };
}
