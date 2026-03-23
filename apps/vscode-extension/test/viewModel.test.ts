import { describe, expect, it } from "vitest";

import { buildTreeRows } from "../src/viewModel.js";

describe("buildTreeRows", () => {
  it("renders a helpful empty state", () => {
    const rows = buildTreeRows(undefined);
    expect(rows[0]?.label).toContain("No repo connected");
  });

  it("renders repo, run, retry, and token rows", () => {
    const rows = buildTreeRows({
      generatedAt: "2026-03-20T00:00:00.000Z",
      repo: {
        id: "repo_1",
        owner: "openai",
        repo: "symphony-alpha",
        fullName: "openai/symphony-alpha",
        githubInstallationId: "inst_1",
        linearProjectSlug: "alpha",
        orchestrationEnabled: true,
        setupStatus: {
          signedIn: true,
          githubConnected: true,
          linearConnected: true,
          serviceTokenConfigured: true,
          workflowPresent: true,
          workflowValid: true,
          orchestrationEnabled: true,
        },
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
      },
      counts: {
        running: 1,
        retrying: 1,
      },
      running: [
        {
          issueId: "issue_1",
          issueIdentifier: "RB-1",
          state: "In Progress",
          turnCount: 1,
          lastEvent: "notification",
          lastMessage: "Working on tests",
          startedAt: "2026-03-20T00:00:00.000Z",
          tokens: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          },
        },
      ],
      retrying: [
        {
          issueId: "issue_2",
          issueIdentifier: "RB-2",
          attempt: 2,
          dueAt: "2026-03-20T00:00:10.000Z",
        },
      ],
      codexTotals: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    });

    expect(rows.some((row) => row.contextValue === "repo")).toBe(true);
    expect(rows.some((row) => row.contextValue === "running")).toBe(true);
    expect(rows.some((row) => row.contextValue === "retrying")).toBe(true);
  });
});
