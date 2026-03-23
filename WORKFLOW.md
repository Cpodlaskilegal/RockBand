---
tracker:
  kind: linear
  project_slug: "alpha"
polling:
  interval_ms: 30000
hooks:
  after_create: |
    git fetch --all --prune
agent:
  max_concurrent_agents: 5
  max_turns: 20
codex:
  approval_policy: "never"
  thread_sandbox: "workspace-write"
---

You are working on Linear issue {{ issue.identifier }}.

Title: {{ issue.title }}
Description: {{ issue.description }}

Operate autonomously until the work reaches the next safe human handoff state.
