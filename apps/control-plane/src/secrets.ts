import { randomUUID } from "node:crypto";

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { SecretReference } from "@rockband/shared";

export interface SecretStore {
  putRepoLinearApiKey(repoId: string, apiKey: string): Promise<SecretReference>;
  getSecretValue(secretName: string): Promise<string>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async putRepoLinearApiKey(repoId: string, apiKey: string): Promise<SecretReference> {
    const name = `local/${repoId}/linear-api-key`;
    this.secrets.set(name, apiKey);
    return { name };
  }

  async getSecretValue(secretName: string): Promise<string> {
    const value = this.secrets.get(secretName);
    if (!value) {
      throw new Error(`secret_not_found:${secretName}`);
    }
    return value;
  }
}

export class AwsSecretsManagerStore implements SecretStore {
  constructor(
    private readonly client: SecretsManagerClient,
    private readonly prefix: string,
  ) {}

  async putRepoLinearApiKey(repoId: string, apiKey: string): Promise<SecretReference> {
    const name = `${this.prefix}/${repoId}/linear-api-key`;

    try {
      await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: apiKey,
          Description: `Linear API key for ${repoId}`,
        }),
      );
    } catch {
      await this.client.send(
        new PutSecretValueCommand({
          SecretId: name,
          SecretString: apiKey,
          ClientRequestToken: randomUUID(),
        }),
      );
    }

    return { name };
  }

  async getSecretValue(secretName: string): Promise<string> {
    const response = await this.client.send(
      new GetSecretValueCommand({
        SecretId: secretName,
      }),
    );

    if (!response.SecretString) {
      throw new Error(`secret_not_found:${secretName}`);
    }

    return response.SecretString;
  }
}

export class AzureKeyVaultSecretStore implements SecretStore {
  private readonly client: SecretClient;

  constructor(
    vaultUrl: string,
    private readonly prefix: string,
    credential = new DefaultAzureCredential(),
  ) {
    this.client = new SecretClient(vaultUrl, credential);
  }

  async putRepoLinearApiKey(repoId: string, apiKey: string): Promise<SecretReference> {
    const name = sanitizeAzureSecretName(`${this.prefix}-${repoId}-linear-api-key`);
    const secret = await this.client.setSecret(name, apiKey);
    return {
      name,
      arn: secret.properties.id,
    };
  }

  async getSecretValue(secretName: string): Promise<string> {
    const secret = await this.client.getSecret(secretName);
    if (!secret.value) {
      throw new Error(`secret_not_found:${secretName}`);
    }
    return secret.value;
  }
}

export function sanitizeAzureSecretName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 127) || "hosted-symphony-secret";
}
