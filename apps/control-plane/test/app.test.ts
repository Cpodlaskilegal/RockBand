import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHostedWorkflowTemplate } from "@rockband/shared";

import { createApp } from "../src/app.js";

const createdApps: ReturnType<typeof createApp>[] = [];
const authHeader = {
  authorization: "Bearer dev-service-token",
};

afterEach(async () => {
  while (createdApps.length > 0) {
    const current = createdApps.pop();
    await current?.app.close();
  }
});

describe("control plane", () => {
  it("connects a repo", async () => {
    const runtime = createApp();
    createdApps.push(runtime);

    const connectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/repos/connect",
      headers: authHeader,
      payload: {
        owner: "openai",
        repo: "symphony-alpha",
        githubInstallationId: "inst_1",
        linearProjectSlug: "alpha",
        linearApiKey: "linear-secret",
        repoRoot: process.cwd(),
      },
    });

    expect(connectResponse.statusCode).toBe(201);
    expect(JSON.parse(connectResponse.payload).fullName).toBe("openai/symphony-alpha");
  });

  it("runs through validate and refresh against a workflow file", async () => {
    const runtime = createApp();
    createdApps.push(runtime);
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "rockband-"));
    await writeFile(path.join(repoRoot, "WORKFLOW.md"), createHostedWorkflowTemplate("alpha"), "utf8");

    await runtime.service.connectRepo({
      owner: "openai",
      repo: "symphony-alpha",
      githubInstallationId: "inst_1",
      linearProjectSlug: "alpha",
      linearApiKey: "linear-secret",
      repoRoot,
    });

    const repoId = "openai_symphony-alpha";
    const validateResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/repos/${repoId}/validate`,
      headers: authHeader,
    });
    expect(validateResponse.statusCode).toBe(200);
    expect(JSON.parse(validateResponse.payload).validation.valid).toBe(true);

    const enableResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/repos/${repoId}/enable`,
      headers: authHeader,
    });
    expect(enableResponse.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const issueDetailResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/repos/${repoId}/issues/RB-101`,
      headers: authHeader,
    });
    expect(issueDetailResponse.statusCode).toBe(200);
    const issueDetail = JSON.parse(issueDetailResponse.payload);
    expect(issueDetail.recentEvents.length).toBeGreaterThan(0);
    expect(issueDetail.status).toBe("idle");
  });
});
