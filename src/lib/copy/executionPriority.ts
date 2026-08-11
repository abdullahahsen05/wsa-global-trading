const executionPriorityUntil = new Map<string, number>();

function executionPriorityMs(): number {
  const parsed = Number.parseInt(process.env.WSA_COPY_EXECUTION_PRIORITY_MS ?? "4000", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 4_000;
  return Math.min(parsed, 15_000);
}

export function markExecutionPriority(accountIds: Array<string | null | undefined>, durationMs = executionPriorityMs()): void {
  const until = Date.now() + durationMs;
  for (const accountId of accountIds) {
    if (!accountId) continue;
    executionPriorityUntil.set(accountId, until);
  }
}

export function hasExecutionPriority(accountId: string | null | undefined): boolean {
  if (!accountId) return false;
  const until = executionPriorityUntil.get(accountId);
  if (!until) return false;
  if (until <= Date.now()) {
    executionPriorityUntil.delete(accountId);
    return false;
  }
  return true;
}
