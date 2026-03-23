export type EventPayload = unknown;

export class RepoEventBus {
  private readonly listeners = new Map<string, Set<(event: EventPayload) => void>>();

  subscribe(repoId: string, listener: (event: EventPayload) => void): () => void {
    const repoListeners = this.listeners.get(repoId) ?? new Set();
    repoListeners.add(listener);
    this.listeners.set(repoId, repoListeners);

    return () => {
      const current = this.listeners.get(repoId);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(repoId);
      }
    };
  }

  publish(repoId: string, event: EventPayload): void {
    const listeners = this.listeners.get(repoId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }
}
