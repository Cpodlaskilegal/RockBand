import * as vscode from "vscode";

import type { RepoStateResponse } from "@rockband/shared";

import { buildTreeRows, type RepoTreeRow } from "./viewModel.js";

export class SymphonyTreeProvider implements vscode.TreeDataProvider<RepoTreeItem> {
  private state?: RepoStateResponse;
  private readonly emitter = new vscode.EventEmitter<RepoTreeItem | undefined | void>();

  readonly onDidChangeTreeData = this.emitter.event;

  update(state: RepoStateResponse | undefined): void {
    this.state = state;
    this.emitter.fire();
  }

  getTreeItem(element: RepoTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): RepoTreeItem[] {
    return buildTreeRows(this.state).map((row) => new RepoTreeItem(row));
  }
}

export class RepoTreeItem extends vscode.TreeItem {
  constructor(row: RepoTreeRow) {
    super(row.label, vscode.TreeItemCollapsibleState.None);
    this.id = row.id;
    this.description = row.description;
    this.contextValue = row.contextValue;

    if (row.issueIdentifier) {
      this.command = {
        command: "hostedSymphony.openIssue",
        title: "Open Issue",
        arguments: [row.issueIdentifier],
      };
    }
  }
}
