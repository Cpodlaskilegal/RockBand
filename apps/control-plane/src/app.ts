import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import Fastify from "fastify";
import { ECSClient } from "@aws-sdk/client-ecs";
import { Pool } from "pg";
import {
  AzureContainerAppsJobLauncher,
  EcsWorkerLauncher,
  MockWorkerLauncher,
} from "@rockband/worker";
import type { ConnectRepoInput, WorkerEventEnvelope } from "@rockband/shared";

import { buildBearerAuthHook } from "./auth.js";
import { loadConfig } from "./config.js";
import { InMemoryLinearGateway, LinearHttpGateway } from "./linear.js";
import { PostgresControlPlaneStore } from "./postgresStore.js";
import { AzureQueueJobQueue, InMemoryJobQueue, SqsJobQueue } from "./queues.js";
import {
  AwsSecretsManagerStore,
  AzureKeyVaultSecretStore,
  InMemorySecretStore,
} from "./secrets.js";
import { HostedSymphonyService } from "./service.js";
import { InMemoryControlPlaneStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(config = loadConfig()) {
  const app = Fastify({ logger: true });
  let service!: HostedSymphonyService;

  if (config.cloudProvider === "aws") {
    if (!config.databaseUrl || !config.aws?.region || !config.aws.queueUrls) {
      throw new Error("AWS mode requires DATABASE_URL, AWS_REGION, and all SQS queue URLs");
    }

    const pool = new Pool({
      connectionString: config.databaseUrl,
    });
    const secretsClient = new SecretsManagerClient({ region: config.aws.region });
    const sqsClient = new SQSClient({ region: config.aws.region });
    const ecsClient = new ECSClient({ region: config.aws.region });
    const secretStore = new AwsSecretsManagerStore(secretsClient, config.secretPrefix);

    void runPostgresMigrations(pool, app);

    service = new HostedSymphonyService({
      store: new PostgresControlPlaneStore(pool),
      queue: new SqsJobQueue(sqsClient, config.aws.queueUrls),
      workerLauncher: new EcsWorkerLauncher(ecsClient, {
        clusterArn: required(config.aws.ecs.clusterArn, "SYMPHONY_ECS_CLUSTER_ARN"),
        taskDefinitionArn: required(config.aws.ecs.taskDefinitionArn, "SYMPHONY_ECS_WORKER_TASK_DEFINITION_ARN"),
        containerName: config.aws.ecs.containerName,
        subnetIds: requiredList(config.aws.ecs.subnetIds, "SYMPHONY_ECS_SUBNET_IDS"),
        securityGroupIds: requiredList(config.aws.ecs.securityGroupIds, "SYMPHONY_ECS_SECURITY_GROUP_IDS"),
        logNamespace: process.env.SYMPHONY_ECS_LOG_NAMESPACE,
      }),
      linearGateway: new LinearHttpGateway(secretStore),
      secretStore,
      workerEventSecret: config.workerEventSecret,
      baseUrl: config.baseUrl,
      cloudProvider: config.cloudProvider,
      deploymentEnvironment: config.deploymentEnvironment,
    });
  } else if (config.cloudProvider === "azure") {
    if (!config.databaseUrl || !config.azure) {
      throw new Error("Azure mode requires DATABASE_URL and Azure provider configuration");
    }

    const pool = new Pool({
      connectionString: config.databaseUrl,
    });
    const secretStore = new AzureKeyVaultSecretStore(config.azure.keyVaultUrl, config.secretPrefix);

    void runPostgresMigrations(pool, app);

    service = new HostedSymphonyService({
      store: new PostgresControlPlaneStore(pool),
      queue: new AzureQueueJobQueue(config.azure.storageConnectionString, config.azure.queueNames),
      workerLauncher: new AzureContainerAppsJobLauncher({
        subscriptionId: required(config.azure.containerApps.subscriptionId, "AZURE_SUBSCRIPTION_ID"),
        resourceGroupName: required(config.azure.containerApps.resourceGroupName, "AZURE_RESOURCE_GROUP"),
        jobName: required(config.azure.containerApps.jobName, "AZURE_CONTAINERAPPS_JOB_NAME"),
        containerName: config.azure.containerApps.containerName,
        image: required(config.azure.containerApps.image, "AZURE_CONTAINERAPPS_WORKER_IMAGE"),
        cpu: config.azure.containerApps.cpu,
        memory: config.azure.containerApps.memory,
        apiVersion: config.azure.containerApps.apiVersion,
        command: config.azure.containerApps.command,
        logNamespace:
          config.azure.containerApps.logNamespace ??
          `${config.azure.containerApps.resourceGroupName}/${config.azure.containerApps.jobName}`,
        extraEnv: buildAzureWorkerEnv(config),
      }),
      linearGateway: new LinearHttpGateway(secretStore),
      secretStore,
      workerEventSecret: config.workerEventSecret,
      baseUrl: config.baseUrl,
      cloudProvider: config.cloudProvider,
      deploymentEnvironment: config.deploymentEnvironment,
    });
  } else {
    const queue = new InMemoryJobQueue();
    service = new HostedSymphonyService({
      store: new InMemoryControlPlaneStore(),
      queue,
      workerLauncher: new MockWorkerLauncher({}, async (event) => {
        await service.enqueueWorkerEvent(event);
      }),
      linearGateway: new InMemoryLinearGateway(),
      secretStore: new InMemorySecretStore(),
      workerEventSecret: config.workerEventSecret,
      baseUrl: config.baseUrl,
      cloudProvider: config.cloudProvider,
      deploymentEnvironment: config.deploymentEnvironment,
    });
  }

  void service.start();
  app.addHook("preHandler", buildBearerAuthHook(config.serviceToken));

  app.get("/health", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true, service: "hosted-symphony-control-plane" }));
  app.get("/readyz", async () => ({ ok: true, provider: config.cloudProvider, environment: config.deploymentEnvironment }));

  app.post<{ Body: ConnectRepoInput }>("/v1/repos/connect", async (request, reply) => {
    const repo = await service.connectRepo(request.body);
    reply.code(201);
    return repo;
  });

  app.post<{ Params: { repoId: string } }>("/v1/repos/:repoId/validate", async (request) => {
    const repo = await service.validateRepo(request.params.repoId);
    return {
      repo,
      validation: repo.validation,
    };
  });

  app.post<{ Params: { repoId: string }; Body?: { enabled?: boolean } }>(
    "/v1/repos/:repoId/enable",
    async (request) => {
      const repo = await service.enableRepo(request.params.repoId, request.body?.enabled ?? true);
      return {
        repo,
        enabled: repo.orchestrationEnabled,
      };
    },
  );

  app.get<{ Params: { repoId: string } }>("/v1/repos/:repoId/state", async (request) => {
    return service.getRepoState(request.params.repoId);
  });

  app.get<{ Params: { repoId: string; identifier: string } }>(
    "/v1/repos/:repoId/issues/:identifier",
    async (request, reply) => {
      const detail = await service.getIssueDetail(request.params.repoId, request.params.identifier);
      if (!detail) {
        reply.code(404);
        return {
          error: {
            code: "issue_not_found",
            message: `Unknown issue ${request.params.identifier}`,
          },
        };
      }

      return detail;
    },
  );

  app.post<{ Params: { repoId: string } }>("/v1/repos/:repoId/refresh", async (request, reply) => {
    await service.refreshRepo(request.params.repoId);
    reply.code(202);
    return {
      queued: true,
      coalesced: false,
      requestedAt: new Date().toISOString(),
      operations: ["poll", "reconcile"],
    };
  });

  app.get<{ Params: { repoId: string } }>("/v1/repos/:repoId/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const write = (event: unknown) => {
      reply.raw.write("event: state\n");
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    write(await service.getRepoState(request.params.repoId));
    const unsubscribe = service.eventBus.subscribe(request.params.repoId, write);

    request.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });

    return reply;
  });

  app.post<{ Body: WorkerEventEnvelope }>("/internal/worker-events", async (request, reply) => {
    const signature = request.headers["x-symphony-signature"];
    if (typeof signature !== "string" || !isValidSignature(signature, request.body, service.workerEventSecret)) {
      reply.code(401);
      return {
        error: {
          code: "invalid_signature",
          message: "Worker event signature verification failed",
        },
      };
    }

    await service.enqueueWorkerEvent(request.body);
    reply.code(202);
    return { accepted: true };
  });

  return { app, service, config };
}

function isValidSignature(signature: string, body: WorkerEventEnvelope, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredList(value: string[], name: string): string[] {
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function buildAzureWorkerEnv(config: ReturnType<typeof loadConfig>): Record<string, string | undefined> {
  return {
    SYMPHONY_CONTROL_PLANE_URL: config.baseUrl,
    SYMPHONY_WORKER_EVENT_SECRET: config.workerEventSecret,
    SYMPHONY_WORKSPACE_ROOT: process.env.SYMPHONY_WORKSPACE_ROOT ?? "/mnt/symphony",
    SYMPHONY_LOG_NAMESPACE:
      config.azure?.containerApps.logNamespace ??
      (config.azure
        ? `${config.azure.containerApps.resourceGroupName}/${config.azure.containerApps.jobName}`
        : undefined),
    SYMPHONY_AZURE_JOB_NAME: config.azure?.containerApps.jobName,
    SYMPHONY_AZURE_RESOURCE_GROUP: config.azure?.containerApps.resourceGroupName,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_COMMAND: process.env.CODEX_COMMAND,
  };
}

async function runPostgresMigrations(pool: Pool, app: ReturnType<typeof Fastify>): Promise<void> {
  try {
    const schemaPath = path.resolve(__dirname, "../../../infra/postgres/schema.sql");
    const schema = await readFile(schemaPath, "utf8");
    await pool.query(schema);
  } catch (error) {
    app.log.error({ err: error }, "Failed to run Postgres schema migrations");
  }
}
