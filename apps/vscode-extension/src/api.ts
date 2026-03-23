import type {
  ConnectRepoInput,
  HostedRepo,
  IssueRunDetail,
  RepoStateResponse,
  WorkflowValidationResponse,
} from "@rockband/shared";

export class HostedSymphonyApiClient {
  constructor(
    private readonly getBaseUrl: () => string,
    private readonly getServiceToken: () => PromiseLike<string | undefined> | string | undefined,
  ) {}

  async connectRepo(input: ConnectRepoInput): Promise<HostedRepo> {
    return this.request<HostedRepo>("/v1/repos/connect", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async validateRepo(repoId: string): Promise<WorkflowValidationResponse> {
    return this.request<WorkflowValidationResponse>(`/v1/repos/${repoId}/validate`, {
      method: "POST",
    });
  }

  async enableRepo(repoId: string): Promise<{ repo: HostedRepo; enabled: boolean }> {
    return this.request(`/v1/repos/${repoId}/enable`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
  }

  async getRepoState(repoId: string): Promise<RepoStateResponse> {
    return this.request<RepoStateResponse>(`/v1/repos/${repoId}/state`);
  }

  async getIssueDetail(repoId: string, issueIdentifier: string): Promise<IssueRunDetail> {
    return this.request<IssueRunDetail>(`/v1/repos/${repoId}/issues/${issueIdentifier}`);
  }

  async refreshRepo(repoId: string): Promise<void> {
    await this.request(`/v1/repos/${repoId}/refresh`, {
      method: "POST",
    });
  }

  eventStreamUrl(repoId: string): string {
    return new URL(`/v1/repos/${repoId}/events`, this.getBaseUrl()).toString();
  }

  async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getServiceToken();
    return token
      ? {
          authorization: `Bearer ${token}`,
        }
      : {};
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(pathname, this.getBaseUrl()), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  }
}
