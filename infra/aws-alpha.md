# AWS Alpha Shape

This repository runs locally with in-memory adapters, but the code structure maps directly to the intended hosted alpha:

## Control plane

- Deploy `apps/control-plane` behind an ALB or API Gateway on ECS Fargate.
- Replace `InMemoryControlPlaneStore` with Postgres-backed repositories.
- Replace direct dispatch calls with SQS messages:
  - `dispatch`
  - `refresh`
  - `cancel`
  - `worker-event`

## Workers

- Run one ECS Fargate task per issue execution.
- Mount EFS at `/mnt/symphony/<repo_id>/<issue_identifier>`.
- Use a GitHub App installation token to clone/fetch the repository into the mounted workspace.
- Launch `codex app-server` inside the issue workspace and POST signed worker events back to `/internal/worker-events`.

## Secrets

- Store the Linear API key in AWS Secrets Manager per connected repo.
- Keep the worker-event HMAC secret in Secrets Manager or SSM Parameter Store.
- Use task-role based access for ECR, CloudWatch Logs, EFS, Secrets Manager, and SQS.

## Observability

- CloudWatch Logs for control plane and worker session streams
- Postgres event projection for repo summary and issue detail APIs
- SSE or WebSocket fan-out to the VS Code extension and optional hosted dashboard
