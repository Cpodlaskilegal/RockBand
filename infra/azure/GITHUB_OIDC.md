# GitHub Actions Azure Credentials

The deploy workflow uses GitHub OIDC, not a long-lived client secret.

## What GitHub needs

Repository secrets:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_POSTGRES_ADMIN_PASSWORD`
- `HOSTED_SYMPHONY_SERVICE_TOKEN`
- `SYMPHONY_WORKER_EVENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `OPENAI_API_KEY`

Repository variables:

- `AZURE_LOCATION`
- `AZURE_RESOURCE_GROUP_PREFIX`
- `AZURE_CONTAINER_REGISTRY_NAME`
- `AZURE_STORAGE_ACCOUNT_NAME_PREFIX`
- `AZURE_KEY_VAULT_NAME_PREFIX`
- `AZURE_POSTGRES_SERVER_NAME_PREFIX`
- `AZURE_POSTGRES_ADMIN_LOGIN`
- `HOSTED_SYMPHONY_BASE_URL`

## Example bootstrap

```bash
APP_NAME="hosted-symphony-github-deploy"
RESOURCE_GROUP="hosted-symphony-staging-rg"
REPO="your-org/your-repo"

APP_JSON="$(az ad app create --display-name "$APP_NAME")"
APP_OBJECT_ID="$(printf '%s' "$APP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
APP_CLIENT_ID="$(printf '%s' "$APP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["appId"])')"

az ad sp create --id "$APP_CLIENT_ID" >/dev/null

cat > /tmp/hosted-symphony-federated-credential.json <<EOF
{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:${REPO}:ref:refs/heads/main",
  "description": "GitHub Actions deploy access for Hosted Symphony",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF

az ad app federated-credential create \
  --id "$APP_OBJECT_ID" \
  --parameters @/tmp/hosted-symphony-federated-credential.json

az role assignment create \
  --assignee "$APP_CLIENT_ID" \
  --role Contributor \
  --resource-group "$RESOURCE_GROUP"
```

After that, copy `APP_CLIENT_ID`, your tenant id, and your subscription id into the GitHub repository secrets listed above.
