# Azure Deployment

This folder contains the minimal Azure deployment path for Hosted Symphony:

- `main.bicep`: resource-group deployment for the control plane, worker job, PostgreSQL, storage, Key Vault, ACR, and Container Apps environment
- `parameters/staging.parameters.json`: starter staging values
- `parameters/prod.parameters.json`: starter prod values

## What it provisions

- Azure Container Registry for the control-plane and worker images
- Azure Container Apps environment plus:
  - one always-on control-plane app
  - one manual worker job used for per-issue dispatches
- Azure Database for PostgreSQL Flexible Server
- Azure Storage queues for `dispatch`, `refresh`, `cancel`, and `worker-event`
- Azure Files mounted into the worker job at `/mnt/symphony`
- Azure Key Vault for runtime and per-repo secret storage
- Log Analytics-backed application logs

## Expected deploy flow

1. Run `npm run azure:bootstrap` to generate `.env.azure.local` from the currently logged-in Azure CLI account.
2. Fill the secret placeholders in `.env.azure.local` and `source` it.
3. Build and push the images to ACR.
4. Create the target resource group.
5. Deploy `main.bicep` with the right parameter file and secure parameter overrides.
6. Copy the `controlPlanePublicUrl` output into the VS Code extension's `hostedSymphony.baseUrl` setting.
7. Install the private `.vsix` and paste the shared service token into secret storage with `Hosted Symphony: Sign In`.

## Example staging deploy

```bash
npm run azure:bootstrap
source .env.azure.local

az group create --name hosted-symphony-staging-rg --location eastus

az deployment group create \
  --resource-group hosted-symphony-staging-rg \
  --template-file infra/azure/main.bicep \
  --parameters @infra/azure/parameters/staging.parameters.json \
  --parameters \
    postgresAdminPassword="$POSTGRES_ADMIN_PASSWORD" \
    serviceToken="$HOSTED_SYMPHONY_SERVICE_TOKEN" \
    workerEventSecret="$SYMPHONY_WORKER_EVENT_SECRET" \
    githubAppId="$GITHUB_APP_ID" \
    githubAppPrivateKey="$GITHUB_APP_PRIVATE_KEY" \
    openAiApiKey="$OPENAI_API_KEY"
```

## Notes

- The worker job is configured as a manual Container Apps job because the control plane launches one execution per issue attempt.
- The control plane stores per-repo Linear API keys in Key Vault at runtime via managed identity.
- The deployment uses the published control-plane base URL you provide as a parameter. In a real environment this should be your final HTTPS hostname.
- GitHub Actions OIDC setup steps live in [`GITHUB_OIDC.md`](/Users/clawd/Documents/RockBand/infra/azure/GITHUB_OIDC.md).
