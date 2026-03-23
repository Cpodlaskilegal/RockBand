import type { CloudProvider, DeploymentEnvironment } from "@rockband/shared";

export interface QueueNames {
  dispatch: string;
  refresh: string;
  cancel: string;
  workerEvent: string;
}

export interface AwsProviderConfig {
  region: string;
  queueUrls: QueueNames;
  ecs: {
    clusterArn: string;
    taskDefinitionArn: string;
    subnetIds: string[];
    securityGroupIds: string[];
    containerName: string;
  };
}

export interface AzureProviderConfig {
  storageConnectionString: string;
  queueNames: QueueNames;
  keyVaultUrl: string;
  containerApps: {
    subscriptionId: string;
    resourceGroupName: string;
    jobName: string;
    containerName: string;
    image: string;
    cpu: number;
    memory: string;
    apiVersion: string;
    logNamespace?: string;
    command?: string[];
  };
}

export interface ControlPlaneConfig {
  cloudProvider: CloudProvider;
  port: number;
  baseUrl: string;
  deploymentEnvironment: DeploymentEnvironment;
  serviceToken: string;
  workerEventSecret: string;
  databaseUrl?: string;
  secretPrefix: string;
  aws?: AwsProviderConfig;
  azure?: AzureProviderConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const cloudProvider = resolveCloudProvider(env);
  const deploymentEnvironment = (env.HOSTED_SYMPHONY_ENVIRONMENT as DeploymentEnvironment | undefined) ?? "local";

  return {
    cloudProvider,
    port: Number(env.PORT ?? 4310),
    baseUrl: env.HOSTED_SYMPHONY_BASE_URL ?? `http://127.0.0.1:${env.PORT ?? 4310}`,
    deploymentEnvironment,
    serviceToken: env.HOSTED_SYMPHONY_SERVICE_TOKEN ?? "dev-service-token",
    workerEventSecret: env.SYMPHONY_WORKER_EVENT_SECRET ?? "dev-worker-secret",
    databaseUrl: env.DATABASE_URL,
    secretPrefix: env.SYMPHONY_SECRET_PREFIX ?? defaultSecretPrefix(cloudProvider, deploymentEnvironment),
    aws: cloudProvider === "aws" ? loadAwsConfig(env) : undefined,
    azure: cloudProvider === "azure" ? loadAzureConfig(env, deploymentEnvironment) : undefined,
  };
}

function resolveCloudProvider(env: NodeJS.ProcessEnv): CloudProvider {
  const value = env.HOSTED_SYMPHONY_CLOUD_PROVIDER ?? env.HOSTED_SYMPHONY_MODE ?? "local";
  return value === "aws" || value === "azure" ? value : "local";
}

function defaultSecretPrefix(cloudProvider: CloudProvider, deploymentEnvironment: DeploymentEnvironment): string {
  if (cloudProvider === "azure") {
    return `hosted-symphony-${deploymentEnvironment}`;
  }

  return `/hosted-symphony/${deploymentEnvironment}`;
}

function loadAwsConfig(env: NodeJS.ProcessEnv): AwsProviderConfig | undefined {
  if (
    !env.AWS_REGION ||
    !env.SYMPHONY_QUEUE_URL_DISPATCH ||
    !env.SYMPHONY_QUEUE_URL_REFRESH ||
    !env.SYMPHONY_QUEUE_URL_CANCEL ||
    !env.SYMPHONY_QUEUE_URL_WORKER_EVENT
  ) {
    return undefined;
  }

  return {
    region: env.AWS_REGION,
    queueUrls: {
      dispatch: env.SYMPHONY_QUEUE_URL_DISPATCH,
      refresh: env.SYMPHONY_QUEUE_URL_REFRESH,
      cancel: env.SYMPHONY_QUEUE_URL_CANCEL,
      workerEvent: env.SYMPHONY_QUEUE_URL_WORKER_EVENT,
    },
    ecs: {
      clusterArn: env.SYMPHONY_ECS_CLUSTER_ARN ?? "",
      taskDefinitionArn: env.SYMPHONY_ECS_WORKER_TASK_DEFINITION_ARN ?? "",
      containerName: env.SYMPHONY_ECS_WORKER_CONTAINER_NAME ?? "worker",
      subnetIds: splitList(env.SYMPHONY_ECS_SUBNET_IDS),
      securityGroupIds: splitList(env.SYMPHONY_ECS_SECURITY_GROUP_IDS),
    },
  };
}

function loadAzureConfig(
  env: NodeJS.ProcessEnv,
  deploymentEnvironment: DeploymentEnvironment,
): AzureProviderConfig | undefined {
  if (!env.AZURE_STORAGE_CONNECTION_STRING || !env.AZURE_KEY_VAULT_URL) {
    return undefined;
  }

  return {
    storageConnectionString: env.AZURE_STORAGE_CONNECTION_STRING,
    keyVaultUrl: env.AZURE_KEY_VAULT_URL,
    queueNames: {
      dispatch: env.AZURE_QUEUE_NAME_DISPATCH ?? `hosted-symphony-${deploymentEnvironment}-dispatch`,
      refresh: env.AZURE_QUEUE_NAME_REFRESH ?? `hosted-symphony-${deploymentEnvironment}-refresh`,
      cancel: env.AZURE_QUEUE_NAME_CANCEL ?? `hosted-symphony-${deploymentEnvironment}-cancel`,
      workerEvent: env.AZURE_QUEUE_NAME_WORKER_EVENT ?? `hosted-symphony-${deploymentEnvironment}-worker-event`,
    },
    containerApps: {
      subscriptionId: env.AZURE_SUBSCRIPTION_ID ?? "",
      resourceGroupName: env.AZURE_RESOURCE_GROUP ?? "",
      jobName: env.AZURE_CONTAINERAPPS_JOB_NAME ?? "",
      containerName: env.AZURE_CONTAINERAPPS_JOB_CONTAINER_NAME ?? "worker",
      image: env.AZURE_CONTAINERAPPS_WORKER_IMAGE ?? "",
      cpu: Number(env.AZURE_CONTAINERAPPS_WORKER_CPU ?? 1),
      memory: env.AZURE_CONTAINERAPPS_WORKER_MEMORY ?? "2Gi",
      apiVersion: env.AZURE_CONTAINERAPPS_API_VERSION ?? "2023-05-01",
      logNamespace: env.AZURE_CONTAINERAPPS_LOG_NAMESPACE,
      command: splitList(env.AZURE_CONTAINERAPPS_WORKER_COMMAND),
    },
  };
}

function splitList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) ?? [];
}
