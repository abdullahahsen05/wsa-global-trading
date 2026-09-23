import type { AccountStatus, TraderAccountSummary } from "@/lib/domain/types";

export const ACCOUNT_INACTIVITY_DAYS = 10;
export const ACCOUNT_INACTIVITY_MS = ACCOUNT_INACTIVITY_DAYS * 24 * 60 * 60 * 1_000;

function validTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function latestAccountActivityAt(
  lastSyncedAt: string | null | undefined,
  snapshotCapturedAt: string | null | undefined,
): string | null {
  const values = [lastSyncedAt, snapshotCapturedAt]
    .map((value) => ({ value, time: validTime(value) }))
    .filter((entry): entry is { value: string; time: number } => entry.time !== null);
  values.sort((left, right) => right.time - left.time);
  return values[0]?.value ?? null;
}

export function resolveAccountLifecycleStatus(input: {
  status: AccountStatus;
  lastSyncedAt?: string | null;
  snapshotCapturedAt?: string | null;
  serverName?: string | null;
  platform?: string | null;
  providerAccountId?: string | null;
  now?: number;
}): AccountStatus {
  if (input.status !== "CONNECTED" && input.status !== "RESTRICTED") {
    return input.status;
  }

  const lastActivity = validTime(
    latestAccountActivityAt(input.lastSyncedAt, input.snapshotCapturedAt),
  );

  // Broker server/platform are operational metadata used for display and
  // credential re-entry. Older accounts can have a provider account and
  // successful sync history while one of these display fields is missing.
  // Do not demote those live accounts to PENDING; that removes them from
  // selectors and makes the trader workspace look disconnected.
  if (!input.serverName || !input.platform) {
    if (lastActivity !== null) return input.status;
    return input.providerAccountId ? "SYNCING" : "PENDING";
  }

  if (lastActivity === null) {
    return "SYNCING";
  }

  if ((input.now ?? Date.now()) - lastActivity >= ACCOUNT_INACTIVITY_MS) {
    return "INACTIVE";
  }

  return input.status;
}

export function isLiveConnectedAccount(account: TraderAccountSummary): boolean {
  return account.status === "CONNECTED" && account.live !== false;
}

export function resolveLiveSelectedAccountId(
  accounts: TraderAccountSummary[],
  selectedAccountId: string | null,
): string | null {
  const connectedAccounts = accounts.filter(isLiveConnectedAccount);
  return connectedAccounts.some((account) => account.accountId === selectedAccountId)
    ? selectedAccountId
    : connectedAccounts[0]?.accountId ?? null;
}
