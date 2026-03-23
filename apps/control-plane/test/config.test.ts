import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("control plane config", () => {
  it("loads Azure provider settings", () => {
    const config = loadConfig({
      HOSTED_SYMPHONY_CLOUD_PROVIDER: "azure",
      HOSTED_SYMPHONY_ENVIRONMENT: "staging",
      AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      AZURE_KEY_VAULT_URL: "https://hosted-symphony.vault.azure.net/",
      AZURE_SUBSCRIPTION_ID: "sub_123",
      AZURE_RESOURCE_GROUP: "hosted-symphony-staging-rg",
      AZURE_CONTAINERAPPS_JOB_NAME: "hosted-symphony-worker",
      AZURE_CONTAINERAPPS_JOB_CONTAINER_NAME: "worker",
      AZURE_CONTAINERAPPS_WORKER_IMAGE: "example.azurecr.io/worker:sha",
      AZURE_CONTAINERAPPS_WORKER_CPU: "2",
      AZURE_CONTAINERAPPS_WORKER_MEMORY: "4Gi",
    });

    expect(config.cloudProvider).toBe("azure");
    expect(config.azure?.queueNames.dispatch).toBe("hosted-symphony-staging-dispatch");
    expect(config.azure?.containerApps.cpu).toBe(2);
    expect(config.secretPrefix).toBe("hosted-symphony-staging");
  });
});
