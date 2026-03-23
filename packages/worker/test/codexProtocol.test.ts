import { describe, expect, it } from "vitest";

import { createHostedWorkflowTemplate, type WorkerDispatchRequest, validateHostedWorkflow } from "@rockband/shared";

import { buildStartupMessages, parseCodexProtocolLine, signWorkerEvent } from "../src/index.js";

function makeRequest(): WorkerDispatchRequest {
  return {
    repo: {
      id: "repo_1",
      owner: "openai",
      repo: "symphony-alpha",
      fullName: "openai/symphony-alpha",
      githubInstallationId: "inst_123",
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    issue: {
      id: "issue_1",
      identifier: "RB-1",
      title: "Ship hosted symphony",
      state: "Todo",
      labels: [],
      blockedBy: [],
    },
    workflow: validateHostedWorkflow(createHostedWorkflowTemplate("alpha")).effectiveConfig!,
    promptTemplate: "You are working on {{ issue.identifier }}.",
  };
}

describe("startup messages", () => {
  it("builds initialize, thread/start, and turn/start requests", () => {
    const messages = buildStartupMessages(makeRequest(), "/mnt/symphony/repo_1/RB-1");

    expect(messages).toHaveLength(4);
    expect(messages[0]?.method).toBe("initialize");
    expect(messages[2]?.method).toBe("thread/start");
    expect(messages[3]?.method).toBe("turn/start");
  });
});

describe("protocol parsing", () => {
  it("extracts completion events and token usage", () => {
    const parsed = parseCodexProtocolLine(
      JSON.stringify({
        method: "turn/completed",
        params: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
        },
      }),
      {
        repoId: "repo_1",
        issueId: "issue_1",
        issueIdentifier: "RB-1",
      },
    );

    expect(parsed?.event).toBe("turn_completed");
    expect(parsed?.tokens?.totalTokens).toBe(150);
  });

  it("signs worker payloads deterministically", () => {
    const payload = {
      repoId: "repo_1",
      issueId: "issue_1",
      issueIdentifier: "RB-1",
      event: "notification",
      at: "2026-03-20T00:00:00.000Z",
    };

    expect(signWorkerEvent("secret", payload)).toHaveLength(64);
  });
});
