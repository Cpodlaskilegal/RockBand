import { describe, expect, it, vi } from "vitest";

import { AzureContainerAppsJobLauncher } from "../src/launcher.js";

describe("AzureContainerAppsJobLauncher", () => {
  it("starts a Container Apps job execution with worker payload overrides", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ name: "execution-123" }),
    }));

    const launcher = new AzureContainerAppsJobLauncher(
      {
        subscriptionId: "sub-123",
        resourceGroupName: "rg-test",
        jobName: "hosted-symphony-worker",
        containerName: "worker",
        image: "example.azurecr.io/worker:test",
        cpu: 1,
        memory: "2Gi",
        extraEnv: {
          SYMPHONY_CONTROL_PLANE_URL: "https://hosted-symphony.example.internal",
        },
      },
      {
        fetchImpl,
        tokenProvider: {
          getToken: async () => "test-token",
        },
      },
    );

    const result = await launcher.dispatch({
      repo: {
        id: "openai_symphony",
        owner: "openai",
        repo: "symphony",
        fullName: "openai/symphony",
        githubInstallationId: "inst_123",
        linearProjectSlug: "alpha",
        orchestrationEnabled: true,
        cloudProvider: "azure",
        deploymentEnvironment: "staging",
        setupStatus: {
          signedIn: true,
          githubConnected: true,
          linearConnected: true,
          serviceTokenConfigured: true,
          workflowPresent: true,
          workflowValid: true,
          orchestrationEnabled: true,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      issue: {
        id: "1",
        identifier: "RB-101",
        title: "Ship Hosted Symphony",
        state: "Todo",
        labels: [],
        blockedBy: [],
      },
      workflow: {
        tracker: {
          kind: "linear",
          projectSlug: "alpha",
          activeStates: ["Todo"],
          terminalStates: ["Done"],
        },
        polling: {
          intervalMs: 30000,
        },
        hooks: {
          timeoutMs: 60000,
        },
        agent: {
          maxConcurrentAgents: 1,
          maxTurns: 10,
          maxRetryBackoffMs: 300000,
          maxConcurrentAgentsByState: {},
        },
        codex: {
          approvalPolicy: "never",
          threadSandbox: "workspace-write",
          turnTimeoutMs: 60000,
          readTimeoutMs: 5000,
          stallTimeoutMs: 300000,
        },
        hostedPolicy: {
          workspaceRoot: "/mnt/symphony",
          codexCommand: "codex app-server",
          workerRuntime: "azure-container-apps-job",
          persistence: "postgres+azure-queue",
        },
      },
      promptTemplate: "You are working on {{ issue.identifier }}",
      attempt: 1,
    });

    expect(result.workerInstanceId).toBe("execution-123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/providers/Microsoft.App/jobs/hosted-symphony-worker/start");
    expect(init?.method).toBe("POST");
    expect(String(init?.headers?.authorization)).toBe("Bearer test-token");

    const body = JSON.parse(String(init?.body)) as {
      containers: Array<{
        env: Array<{ name: string; value: string }>;
      }>;
    };
    expect(body.containers[0]?.env.some((entry) => entry.name === "WORKER_JOB_JSON")).toBe(true);
  });

  it("stops an active Container Apps job execution", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    }));

    const launcher = new AzureContainerAppsJobLauncher(
      {
        subscriptionId: "sub-123",
        resourceGroupName: "rg-test",
        jobName: "hosted-symphony-worker",
        containerName: "worker",
        image: "example.azurecr.io/worker:test",
        cpu: 1,
        memory: "2Gi",
      },
      {
        fetchImpl,
        tokenProvider: {
          getToken: async () => "test-token",
        },
      },
    );

    await launcher.cancel({
      workerInstanceId: "execution-123",
      reason: "Issue moved to Done",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/executions/execution-123/stop");
    expect(init?.method).toBe("POST");
  });
});
