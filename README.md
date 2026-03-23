# Hosted Symphony Alpha

This repository contains a greenfield implementation of a hosted Symphony alpha:

- `packages/shared`: shared contracts, workflow parsing, scheduling helpers
- `packages/worker`: worker runtime helpers and Codex app-server protocol utilities
- `apps/control-plane`: Fastify control plane with REST and SSE APIs
- `apps/vscode-extension`: VS Code setup and monitoring extension
- `infra`: Azure deployment assets, legacy AWS notes, and a starter Postgres schema
- `infra/azure`: Azure Container Apps, PostgreSQL, Queue Storage, Azure Files, Key Vault, and ACR deployment templates
- `infra/cdk`: legacy AWS CDK stacks kept for compatibility during the cloud-port transition

## Quick start

```bash
npm install
npm run build
npm run test
```

Run the local control plane:

```bash
npm run dev:control-plane
```

The local implementation defaults to in-memory persistence and a mock worker runtime so the stack is
executable without Azure, AWS, GitHub App credentials, Linear credentials, or a live Codex runtime.

Package the private VSIX:

```bash
npm run package:extension
```

Validate the Azure Bicep deployment:

```bash
npm run azure:validate
```

## What is implemented

- Hosted workflow validation for `WORKFLOW.md`, including warnings for local-only Symphony fields
- Repo-scoped control-plane APIs for connect, validate, enable, state, issue detail, refresh, and SSE
- Queue-driven orchestration boundaries plus Postgres, SQS, Azure Queue Storage, Secrets Manager, Key Vault, ECS, and Azure Container Apps adapters
- Worker container entrypoint, GitHub App token helper, ECS worker launcher, and Azure Container Apps job launcher
- VS Code extension commands for setup, workflow scaffolding, validation, refresh, issue detail, and service-token secret storage
- Private VSIX packaging and GitHub Actions workflows for Azure deploy + extension release
- Unit and integration tests across shared logic, worker protocol handling, control-plane flows, and extension view models

## Next step to productionize

- Apply the Azure Bicep stack in [`infra/azure`](/Users/clawd/Documents/RockBand/infra/azure/README.md) with real resource names, secrets, and DNS
- Point the VS Code extension at the deployed `controlPlanePublicUrl` and distribute the packaged `.vsix`
- Back the repo connection flow with a real GitHub App install and repo-scoped Linear secrets in Key Vault

## Verification

- `npm run build`
- `npm run test`
- `npm run package:extension`
- `npm run azure:validate`
