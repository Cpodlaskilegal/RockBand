import { TextEncoder } from "node:util";

import * as vscode from "vscode";
import {
  createHostedWorkflowTemplate,
  type ConnectRepoInput,
} from "@rockband/shared";

import { HostedSymphonyApiClient } from "./api.js";
import { ExtensionStateController } from "./state.js";
import { renderIssueHtml, renderSetupHtml } from "./webviews.js";
import { SymphonyTreeProvider } from "./tree.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("hostedSymphony");
  const getBaseUrl = () =>
    vscode.workspace.getConfiguration("hostedSymphony").get<string>("baseUrl", "http://127.0.0.1:4310");
  const api = new HostedSymphonyApiClient(getBaseUrl, () => context.secrets.get("hostedSymphony.serviceToken"));
  const output = vscode.window.createOutputChannel("Hosted Symphony");
  const state = new ExtensionStateController(api, output);
  const tree = new SymphonyTreeProvider();

  context.subscriptions.push(output, state, vscode.window.registerTreeDataProvider("hostedSymphony.repos", tree));
  context.subscriptions.push(state.onDidChangeState((snapshot) => tree.update(snapshot)));

  const setupPanel = vscode.window.createWebviewPanel(
    "hostedSymphonySetup",
    "Hosted Symphony",
    vscode.ViewColumn.Beside,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  setupPanel.webview.html = renderSetupHtml(getBaseUrl(), state.state, Boolean(await context.secrets.get("hostedSymphony.serviceToken")));
  context.subscriptions.push(setupPanel);

  context.subscriptions.push(
    vscode.commands.registerCommand("hostedSymphony.signIn", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Hosted Symphony service token",
        password: true,
        ignoreFocusOut: true,
      });
      if (!token) {
        return;
      }

      await context.secrets.store("hostedSymphony.serviceToken", token);
      const configuredBaseUrl = await vscode.window.showInputBox({
        prompt: "Hosted Symphony base URL",
        value: getBaseUrl(),
        ignoreFocusOut: true,
      });
      if (configuredBaseUrl && configuredBaseUrl !== getBaseUrl()) {
        await config.update("baseUrl", configuredBaseUrl, vscode.ConfigurationTarget.Global);
      }

      setupPanel.webview.html = renderSetupHtml(
        configuredBaseUrl ?? getBaseUrl(),
        state.state,
        true,
      );
      vscode.window.showInformationMessage("Hosted Symphony token saved to VS Code secret storage.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hostedSymphony.connectRepo", async () => {
      const input = await collectConnectInput();
      if (!input) {
        return;
      }

      const repo = await api.connectRepo(input);
      await state.watchRepo(repo.id);
      setupPanel.webview.html = renderSetupHtml(
        getBaseUrl(),
        state.state,
        Boolean(await context.secrets.get("hostedSymphony.serviceToken")),
      );
      vscode.window.showInformationMessage(`Connected ${repo.fullName} to Hosted Symphony.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hostedSymphony.createWorkflow", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }

      const projectSlug = await vscode.window.showInputBox({
        prompt: "Linear project slug",
        placeHolder: "alpha",
      });

      if (!projectSlug) {
        return;
      }

      const workflowUri = vscode.Uri.joinPath(workspaceFolder.uri, "WORKFLOW.md");
      const content = createHostedWorkflowTemplate(projectSlug);
      await vscode.workspace.fs.writeFile(workflowUri, new TextEncoder().encode(content));
      vscode.window.showInformationMessage("Created or updated WORKFLOW.md.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hostedSymphony.validateWorkflow", async () => {
      const repoId = state.state?.repo.id ?? deriveRepoIdFromWorkspace();
      if (!repoId) {
        vscode.window.showErrorMessage("Connect a repo first.");
        return;
      }

      const response = await api.validateRepo(repoId);
      if (response.validation.valid) {
        vscode.window.showInformationMessage("WORKFLOW.md is valid for hosted Symphony.");
        await api.enableRepo(repoId);
        await state.watchRepo(repoId);
      } else {
        vscode.window.showWarningMessage(response.validation.errors.join("\n"));
      }
      setupPanel.webview.html = renderSetupHtml(
        getBaseUrl(),
        state.state,
        Boolean(await context.secrets.get("hostedSymphony.serviceToken")),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hostedSymphony.refreshState", async () => {
      const repoId = state.state?.repo.id;
      if (!repoId) {
        vscode.window.showErrorMessage("Connect a repo first.");
        return;
      }

      await api.refreshRepo(repoId);
      await state.refresh();
      setupPanel.webview.html = renderSetupHtml(
        getBaseUrl(),
        state.state,
        Boolean(await context.secrets.get("hostedSymphony.serviceToken")),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hostedSymphony.openIssue", async (issueIdentifier: string) => {
      const repoId = state.state?.repo.id;
      if (!repoId) {
        return;
      }

      const detail = await api.getIssueDetail(repoId, issueIdentifier);
      const panel = vscode.window.createWebviewPanel(
        "hostedSymphonyIssue",
        `Hosted Symphony ${issueIdentifier}`,
        vscode.ViewColumn.Active,
        { enableScripts: false },
      );
      panel.webview.html = renderIssueHtml(detail);
    }),
  );
}

export function deactivate(): void {}

async function collectConnectInput(): Promise<ConnectRepoInput | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder first.");
    return undefined;
  }

  const owner = await vscode.window.showInputBox({ prompt: "GitHub owner", placeHolder: "openai" });
  const repo = await vscode.window.showInputBox({ prompt: "GitHub repo", placeHolder: "symphony-alpha" });
  const githubInstallationId = await vscode.window.showInputBox({
    prompt: "GitHub installation id",
    placeHolder: "inst_123",
  });
  const linearProjectSlug = await vscode.window.showInputBox({
    prompt: "Linear project slug",
    placeHolder: "alpha",
  });
  const linearApiKey = await vscode.window.showInputBox({
    prompt: "Linear personal API key",
    password: true,
    placeHolder: "lin_api_...",
  });

  if (!owner || !repo || !githubInstallationId || !linearProjectSlug || !linearApiKey) {
    return undefined;
  }

  const config = vscode.workspace.getConfiguration("hostedSymphony");
  const deploymentEnvironment = config.get<"staging" | "prod">("environment", "staging");

  return {
    owner,
    repo,
    githubInstallationId,
    linearProjectSlug,
    linearApiKey,
    repoRoot: workspaceFolder.uri.fsPath,
    cloudProvider: "azure",
    deploymentEnvironment,
  };
}

function deriveRepoIdFromWorkspace(): string | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  const name = workspaceFolder.name.replace(/[^\w.-]/g, "_");
  return `unknown_${name}`;
}
