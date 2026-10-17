if (typeof window !== "undefined") {
  throw new Error("[wsa] accountSnapshotService is server-only.");
}

/**
 * Single writer for account snapshots that also carries margin.
 *
 * - Margin present  -> `record_account_snapshot_v2` (migration 057).
 * - Margin absent, or the database is not migrated yet -> the original
 *   `record_account_snapshot`, exactly as before.
 *
 * A snapshot is therefore never lost because of the new columns, and the web
 * app, the AWS workers and the database can be deployed in any order.
 */

export interface AccountSnapshotWrite {
  accountId: string;
  balance: number;
  equity: number;
  margin?: number | null;
  freeMargin?: number | null;
  marginLevel?: number | null;
}

export interface SnapshotRpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/** The only part of the Supabase client this module needs (easy to fake in tests). */
export interface SnapshotRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ error: SnapshotRpcError | null }>;
}

export interface RecordSnapshotResult {
  error: SnapshotRpcError | null;
  /** true when the margin columns were written */
  marginRecorded: boolean;
}

/** After "function not found" the v2 writer is not retried for this long. */
const V2_RETRY_AFTER_MS = 10 * 60_000;
let v2UnavailableUntil = 0;

/** Test helper: forget what was learned about the database. */
export function resetAccountSnapshotWriterState(): void {
  v2UnavailableUntil = 0;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingFunction(error: SnapshotRpcError | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

export async function recordAccountSnapshot(
  client: SnapshotRpcClient,
  input: AccountSnapshotWrite,
  now: number = Date.now(),
): Promise<RecordSnapshotResult> {
  // Never store a reading that is not a number: it would be drawn as a hole or a crash.
  if (!Number.isFinite(input.balance) || !Number.isFinite(input.equity)) {
    return {
      error: { message: "Snapshot values must be finite numbers." },
      marginRecorded: false,
    };
  }

  const margin = finiteOrNull(input.margin);
  const freeMargin = finiteOrNull(input.freeMargin);
  const marginLevel = finiteOrNull(input.marginLevel);
  const hasMargin = margin !== null || freeMargin !== null || marginLevel !== null;

  if (hasMargin && now >= v2UnavailableUntil) {
    const v2 = await client.rpc("record_account_snapshot_v2", {
      p_account_id: input.accountId,
      p_balance: input.balance,
      p_equity: input.equity,
      p_margin: margin,
      p_free_margin: freeMargin,
      p_margin_level: marginLevel,
    });
    if (!v2.error) return { error: null, marginRecorded: true };
    // Migration 057 is not applied yet: remember it for a while instead of
    // paying a failed call on every cycle.
    if (isMissingFunction(v2.error)) v2UnavailableUntil = now + V2_RETRY_AFTER_MS;
    // Any other problem: still write the snapshot the old way below.
  }

  const legacy = await client.rpc("record_account_snapshot", {
    p_account_id: input.accountId,
    p_balance: input.balance,
    p_equity: input.equity,
  });
  return { error: legacy.error, marginRecorded: false };
}
