import { EventSource } from "eventsource";
import * as vscode from "vscode";
import type { RepoStateResponse } from "@rockband/shared";

import { HostedSymphonyApiClient } from "./api.js";

export class ExtensionStateController implements vscode.Disposable {
  private currentRepoId?: string;
  private currentState?: RepoStateResponse;
  private stream?: EventSource;
  private pollHandle?: NodeJS.Timeout;
  private readonly emitter = new vscode.EventEmitter<RepoStateResponse | undefined>();

  readonly onDidChangeState = this.emitter.event;

  constructor(
    private readonly api: HostedSymphonyApiClient,
    private readonly output: vscode.OutputChannel,
  ) {}

  get state(): RepoStateResponse | undefined {
    return this.currentState;
  }

  async watchRepo(repoId: string): Promise<void> {
    this.currentRepoId = repoId;
    await this.refresh();
    this.attachStream(repoId);
  }

  async refresh(): Promise<void> {
    if (!this.currentRepoId) {
      return;
    }

    this.currentState = await this.api.getRepoState(this.currentRepoId);
    this.emitter.fire(this.currentState);
  }

  private attachStream(repoId: string): void {
    this.disposeStream();

    try {
      this.stream = new EventSource(this.api.eventStreamUrl(repoId), {
        fetch: async (input, init) =>
          fetch(input, {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              ...(await this.api.authHeaders()),
            },
          }),
      });
      this.stream.addEventListener("state", (event: Event) => {
        const payload = JSON.parse((event as MessageEvent).data) as RepoStateResponse;
        this.currentState = payload;
        this.emitter.fire(payload);
      });
      this.stream.addEventListener("error", () => {
        this.output.appendLine("Hosted Symphony SSE disconnected, falling back to polling.");
        this.startPolling();
      });
    } catch (error) {
      this.output.appendLine(`Hosted Symphony SSE unavailable: ${String(error)}`);
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }

    this.pollHandle = setInterval(() => {
      void this.refresh();
    }, 15000);
  }

  private disposeStream(): void {
    this.stream?.close();
    this.stream = undefined;

    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  dispose(): void {
    this.disposeStream();
    this.emitter.dispose();
  }
}
