import type { CandidateSelectionInput, IssueSummary } from "./contracts.js";

export function computeRetryDelayMs(attempt: number, maxRetryBackoffMs: number): number {
  if (attempt <= 0) {
    return 1000;
  }

  return Math.min(10000 * 2 ** (attempt - 1), maxRetryBackoffMs);
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function buildWorkspacePath(root: string, repoId: string, issueIdentifier: string): string {
  return `${root.replace(/\/$/, "")}/${sanitizeWorkspaceKey(repoId)}/${sanitizeWorkspaceKey(issueIdentifier)}`;
}

export function isIssueEligible(input: CandidateSelectionInput): boolean {
  const normalizedState = input.issue.state;
  const { activeStates, terminalStates } = input.workflow.tracker;
  const { claimedIssueIds, runningIssueIds } = input.schedulerState;

  if (!input.issue.id || !input.issue.identifier || !input.issue.title || !normalizedState) {
    return false;
  }

  if (!activeStates.includes(normalizedState) || terminalStates.includes(normalizedState)) {
    return false;
  }

  if (claimedIssueIds.has(input.issue.id) || runningIssueIds.has(input.issue.id)) {
    return false;
  }

  if (normalizedState === "Todo" && hasNonTerminalBlockers(input.issue, terminalStates)) {
    return false;
  }

  const stateLimit = input.workflow.agent.maxConcurrentAgentsByState[normalizedState];
  if (stateLimit !== undefined && (input.runningByState[normalizedState] ?? 0) >= stateLimit) {
    return false;
  }

  return true;
}

function hasNonTerminalBlockers(issue: IssueSummary, terminalStates: string[]): boolean {
  return issue.blockedBy.some((blocker) => blocker.state && !terminalStates.includes(blocker.state));
}

export function sortCandidateIssues(issues: IssueSummary[]): IssueSummary[] {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreatedAt = left.createdAt ?? "";
    const rightCreatedAt = right.createdAt ?? "";
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt.localeCompare(rightCreatedAt);
    }

    return left.identifier.localeCompare(right.identifier);
  });
}
