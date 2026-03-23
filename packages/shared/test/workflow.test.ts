import { describe, expect, it } from "vitest";

import {
  buildWorkspacePath,
  computeRetryDelayMs,
  createHostedWorkflowTemplate,
  isIssueEligible,
  renderPromptTemplate,
  sanitizeWorkspaceKey,
  sortCandidateIssues,
  validateHostedWorkflow,
} from "../src/index.js";

describe("workflow validation", () => {
  it("validates a hosted workflow and warns on local-only fields", () => {
    const validation = validateHostedWorkflow(`---
tracker:
  kind: linear
  project_slug: "rockband"
workspace:
  root: /tmp/foo
codex:
  command: codex app-server
---

You are working on {{ issue.identifier }}.
`);

    expect(validation.valid).toBe(true);
    expect(validation.ignoredFields).toContain("workspace.root");
    expect(validation.ignoredFields).toContain("codex.command");
    expect(validation.effectiveConfig?.tracker.projectSlug).toBe("rockband");
  });

  it("fails when the project slug is missing", () => {
    const validation = validateHostedWorkflow(`---
tracker:
  kind: linear
---

Hello {{ issue.identifier }}
`);

    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain("tracker.project_slug");
  });
});

describe("prompt rendering", () => {
  it("renders the issue fields with strict checking", () => {
    const output = renderPromptTemplate(
      "Issue {{ issue.identifier }}: {{ issue.title }}",
      {
        id: "1",
        identifier: "RB-12",
        title: "Ship it",
        state: "Todo",
        labels: [],
        blockedBy: [],
      },
      null,
    );

    expect(output).toBe("Issue RB-12: Ship it");
  });
});

describe("scheduler helpers", () => {
  it("computes exponential retry backoff", () => {
    expect(computeRetryDelayMs(1, 300000)).toBe(10000);
    expect(computeRetryDelayMs(2, 300000)).toBe(20000);
    expect(computeRetryDelayMs(10, 300000)).toBe(300000);
  });

  it("sanitizes workspace paths", () => {
    expect(sanitizeWorkspaceKey("RB/123 ?")).toBe("RB_123__");
    expect(buildWorkspacePath("/mnt/symphony", "repo/1", "RB/123")).toBe("/mnt/symphony/repo_1/RB_123");
  });

  it("filters blocked todo issues", () => {
    const eligible = isIssueEligible({
      issue: {
        id: "1",
        identifier: "RB-1",
        title: "First",
        state: "Todo",
        labels: [],
        blockedBy: [{ state: "In Progress" }],
      },
      schedulerState: {
        claimedIssueIds: new Set(),
        runningIssueIds: new Set(),
      },
      workflow: validateHostedWorkflow(createHostedWorkflowTemplate("rockband")).effectiveConfig!,
      runningByState: {},
    });

    expect(eligible).toBe(false);
  });

  it("sorts candidate issues by priority and age", () => {
    const sorted = sortCandidateIssues([
      {
        id: "2",
        identifier: "RB-2",
        title: "Later",
        priority: 3,
        createdAt: "2026-03-21T00:00:00.000Z",
        state: "Todo",
        labels: [],
        blockedBy: [],
      },
      {
        id: "1",
        identifier: "RB-1",
        title: "Sooner",
        priority: 1,
        createdAt: "2026-03-20T00:00:00.000Z",
        state: "Todo",
        labels: [],
        blockedBy: [],
      },
    ]);

    expect(sorted[0]?.identifier).toBe("RB-1");
  });
});
