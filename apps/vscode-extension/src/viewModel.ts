import type { RepoStateResponse } from "@rockband/shared";

export interface RepoTreeRow {
  id: string;
  label: string;
  description?: string;
  contextValue: "repo" | "running" | "retrying" | "meta";
  issueIdentifier?: string;
}

export function buildTreeRows(state: RepoStateResponse | undefined): RepoTreeRow[] {
  if (!state) {
    return [
      {
        id: "empty",
        label: "No repo connected",
        description: "Run Hosted Symphony: Connect Repo",
        contextValue: "meta",
      },
    ];
  }

  const rows: RepoTreeRow[] = [
    {
      id: `repo:${state.repo.id}`,
      label: state.repo.fullName,
      description: state.repo.orchestrationEnabled ? "Monitoring live" : "Connected",
      contextValue: "repo",
    },
    {
      id: `meta:health:${state.repo.id}`,
      label: `Health: ${state.validation?.valid ? "workflow valid" : "workflow missing or invalid"}`,
      description: state.latestError,
      contextValue: "meta",
    },
  ];

  for (const running of state.running) {
    rows.push({
      id: `run:${running.issueIdentifier}`,
      label: `${running.issueIdentifier} ${running.state}`,
      description: running.lastMessage ?? running.lastEvent,
      contextValue: "running",
      issueIdentifier: running.issueIdentifier,
    });
  }

  for (const retry of state.retrying) {
    rows.push({
      id: `retry:${retry.issueIdentifier}`,
      label: `${retry.issueIdentifier} retry ${retry.attempt}`,
      description: retry.error ?? retry.dueAt,
      contextValue: "retrying",
      issueIdentifier: retry.issueIdentifier,
    });
  }

  rows.push({
    id: `meta:totals:${state.repo.id}`,
    label: `Tokens: ${state.codexTotals.totalTokens}`,
    description: `${state.counts.running} running, ${state.counts.retrying} retrying`,
    contextValue: "meta",
  });

  return rows;
}
