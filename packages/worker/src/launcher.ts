import { DefaultAzureCredential } from "@azure/identity";
import { RunTaskCommand, StopTaskCommand, ECSClient } from "@aws-sdk/client-ecs";
import type { WorkerDispatchRequest } from "@rockband/shared";

export interface WorkerLaunchResult {
  workerInstanceId?: string;
  taskArn?: string;
  logUrl?: string | null;
  logNamespace?: string | null;
  logStream?: string | null;
}

export interface WorkerCancelInput {
  workerInstanceId?: string;
  taskArn?: string;
  reason: string;
}

export interface WorkerLauncher {
  dispatch(request: WorkerDispatchRequest): Promise<WorkerLaunchResult>;
  cancel(input: WorkerCancelInput): Promise<void>;
}

export interface EcsWorkerLauncherOptions {
  clusterArn: string;
  taskDefinitionArn: string;
  subnetIds: string[];
  securityGroupIds: string[];
  containerName: string;
  assignPublicIp?: boolean;
  logNamespace?: string;
}

export class EcsWorkerLauncher implements WorkerLauncher {
  constructor(
    private readonly client: ECSClient,
    private readonly options: EcsWorkerLauncherOptions,
  ) {}

  async dispatch(request: WorkerDispatchRequest): Promise<WorkerLaunchResult> {
    const response = await this.client.send(
      new RunTaskCommand({
        cluster: this.options.clusterArn,
        taskDefinition: this.options.taskDefinitionArn,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.options.subnetIds,
            securityGroups: this.options.securityGroupIds,
            assignPublicIp: this.options.assignPublicIp ? "ENABLED" : "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.options.containerName,
              environment: [
                {
                  name: "WORKER_JOB_JSON",
                  value: JSON.stringify(request),
                },
              ],
            },
          ],
        },
      }),
    );

    const taskArn = response.tasks?.[0]?.taskArn;
    return {
      workerInstanceId: taskArn,
      taskArn,
      logNamespace: this.options.logNamespace ?? null,
    };
  }

  async cancel(input: WorkerCancelInput): Promise<void> {
    if (!input.taskArn) {
      return;
    }

    await this.client.send(
      new StopTaskCommand({
        cluster: this.options.clusterArn,
        task: input.taskArn,
        reason: input.reason,
      }),
    );
  }
}

export interface AzureContainerAppsJobLauncherOptions {
  subscriptionId: string;
  resourceGroupName: string;
  jobName: string;
  containerName: string;
  image: string;
  cpu: number;
  memory: string;
  apiVersion?: string;
  command?: string[];
  extraEnv?: Record<string, string | undefined>;
  logNamespace?: string;
  managementEndpoint?: string;
}

interface TokenProvider {
  getToken(scope: string): Promise<string>;
}

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<FetchLikeResponse>;

class DefaultAzureTokenProvider implements TokenProvider {
  private readonly credential = new DefaultAzureCredential();

  async getToken(scope: string): Promise<string> {
    const token = await this.credential.getToken(scope);
    if (!token?.token) {
      throw new Error("azure_access_token_unavailable");
    }
    return token.token;
  }
}

export class AzureContainerAppsJobLauncher implements WorkerLauncher {
  private readonly apiVersion: string;
  private readonly managementEndpoint: string;
  private readonly tokenProvider: TokenProvider;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly options: AzureContainerAppsJobLauncherOptions,
    dependencies: {
      tokenProvider?: TokenProvider;
      fetchImpl?: FetchLike;
    } = {},
  ) {
    this.apiVersion = options.apiVersion ?? "2023-05-01";
    this.managementEndpoint = options.managementEndpoint ?? "https://management.azure.com";
    this.tokenProvider = dependencies.tokenProvider ?? new DefaultAzureTokenProvider();
    this.fetchImpl = dependencies.fetchImpl ?? (fetch as FetchLike);
  }

  async dispatch(request: WorkerDispatchRequest): Promise<WorkerLaunchResult> {
    const response = await this.managementRequest<{
      id?: string;
      name?: string;
    }>(
      `/subscriptions/${this.options.subscriptionId}/resourceGroups/${this.options.resourceGroupName}/providers/Microsoft.App/jobs/${this.options.jobName}/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          containers: [
            {
              name: this.options.containerName,
              image: this.options.image,
              resources: {
                cpu: this.options.cpu,
                memory: this.options.memory,
              },
              ...(this.options.command?.length ? { command: this.options.command } : {}),
              env: buildAzureEnv(this.options.extraEnv, {
                WORKER_JOB_JSON: JSON.stringify(request),
              }),
            },
          ],
        }),
      },
    );

    const workerInstanceId = response.name ?? response.id?.split("/").pop();
    const logNamespace = this.options.logNamespace ?? `${this.options.resourceGroupName}/${this.options.jobName}`;

    return {
      workerInstanceId,
      logNamespace,
      logStream: workerInstanceId ?? null,
      logUrl: workerInstanceId
        ? `azure-container-apps-job://${this.options.resourceGroupName}/${this.options.jobName}/${workerInstanceId}`
        : null,
    };
  }

  async cancel(input: WorkerCancelInput): Promise<void> {
    if (!input.workerInstanceId) {
      return;
    }

    await this.managementRequest(
      `/subscriptions/${this.options.subscriptionId}/resourceGroups/${this.options.resourceGroupName}/providers/Microsoft.App/jobs/${this.options.jobName}/executions/${input.workerInstanceId}/stop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reason: input.reason,
        }),
      },
    );
  }

  private async managementRequest<T = Record<string, unknown>>(path: string, init: RequestInit): Promise<T> {
    const token = await this.tokenProvider.getToken("https://management.azure.com/.default");
    const url = new URL(`${path}?api-version=${this.apiVersion}`, this.managementEndpoint);
    const response = await this.fetchImpl(url.toString(), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`azure_management_request_failed:${response.status}:${response.statusText}:${body}`);
    }

    if (!body.trim()) {
      return {} as T;
    }

    return JSON.parse(body) as T;
  }
}

function buildAzureEnv(
  base: Record<string, string | undefined> | undefined,
  override: Record<string, string>,
): Array<{ name: string; value: string }> {
  const values = new Map<string, string>();

  for (const [key, value] of Object.entries(base ?? {})) {
    if (value) {
      values.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(override)) {
    values.set(key, value);
  }

  return [...values.entries()].map(([name, value]) => ({ name, value }));
}
