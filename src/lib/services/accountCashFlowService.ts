if (typeof window !== "undefined") {
  throw new Error("[wsa] accountCashFlowService is server-only.");
}

import type { createAdminClient } from "@/lib/supabase/admin";
import type { BrokerCashFlow } from "@/lib/broker/orderNormalization";
import { chunkArray, selectAllPagesForIds } from "@/lib/supabase/pagedSelect";

/**
 * Deposits and withdrawals of a trading account (table `account_cash_flows`,
 * migration 059 - OPTIONAL).
 *
 * Why: the equity of an account moves when the client pays money in or takes it
 * out. A growth curve that does not know this reads a deposit as profit and a
 * withdrawal as a drawdown. The broker history lists these balance operations;
 * the sync stores them here and the performance chart takes them out of growth
 * and drawdown.
 *
 * Without the migration everything keeps working as before: writes are skipped,
 * reads return nothing, and the missing table is remembered for ten minutes so
 * it is not asked for on every cycle. Shared by the web app and the AWS workers
 * (no Next / React imports).
 */

type AdminDb = ReturnType<typeof createAdminClient>;

export const CASH_FLOW_TABLE = "account_cash_flows";

const WRITE_CHUNK = 200;
const TABLE_RECHECK_MS = 10 * 60_000;

let tableMissingUntil = 0;

/** Test helper: forget what was learned about the database. */
export function resetCashFlowTableState(): void {
  tableMissingUntil = 0;
}

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /could not find the table|relation .* does not exist/i.test(error.message ?? "");
}

export interface StoredCashFlow {
  /** epoch ms */
  t: number;
  /** signed, account currency */
  amount: number;
  /** the account it belongs to - only present when `loadCashFlows` was asked for it */
  accountId?: string;
}

/**
 * Stores balance operations (idempotent: the broker ticket is the key, so the
 * same deposit seen in every sync is stored once). Never throws - a cash-flow
 * problem must not stop the trade sync.
 */
export async function recordCashFlows(
  db: AdminDb,
  accountId: string,
  flows: ReadonlyArray<BrokerCashFlow>,
  currency: string,
  now: number = Date.now(),
): Promise<{ stored: number; supported: boolean }> {
  if (flows.length === 0) return { stored: 0, supported: true };
  if (now < tableMissingUntil) return { stored: 0, supported: false };

  let stored = 0;
  try {
    for (const chunk of chunkArray(flows, WRITE_CHUNK)) {
      const { error } = await db.from(CASH_FLOW_TABLE).upsert(
        chunk.map((flow) => ({
          trading_account_id: accountId,
          external_id: flow.externalId,
          kind: flow.kind,
          amount: flow.amount,
          currency,
          occurred_at: new Date(flow.t).toISOString(),
          comment: flow.comment,
        })),
        { onConflict: "trading_account_id,external_id" },
      );
      if (error) {
        if (isMissingTable(error)) {
          tableMissingUntil = now + TABLE_RECHECK_MS;
          return { stored, supported: false };
        }
        console.warn(`[cash-flows] could not store balance operations for ${accountId}: ${error.message}`);
        return { stored, supported: true };
      }
      stored += chunk.length;
    }
  } catch (error) {
    console.warn(
      `[cash-flows] could not store balance operations for ${accountId}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return { stored, supported: true };
}

/**
 * Deposits and withdrawals of the given accounts between two instants, oldest
 * first. `supported` is false when migration 059 has not been applied.
 * `withAccount` adds the account each one belongs to (a combined curve needs it
 * to leave out what happened before an account was connected).
 */
export async function loadCashFlows(
  db: AdminDb,
  accountIds: readonly string[],
  fromMs: number,
  toMs: number,
  now: number = Date.now(),
  options: { withAccount?: boolean } = {},
): Promise<{ flows: StoredCashFlow[]; supported: boolean }> {
  if (accountIds.length === 0 || !(toMs >= fromMs)) return { flows: [], supported: true };
  if (now < tableMissingUntil) return { flows: [], supported: false };

  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  try {
    const rows = await selectAllPagesForIds<{
      amount: number | string;
      occurred_at: string;
      trading_account_id?: string;
    }>(
      "Cash flow lookup failed",
      accountIds,
      (idChunk, from, to) =>
        db
          .from(CASH_FLOW_TABLE)
          .select("id, trading_account_id, amount, occurred_at")
          .in("trading_account_id", idChunk)
          .gte("occurred_at", fromIso)
          .lte("occurred_at", toIso)
          .order("occurred_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      { maxRows: 5_000 },
    );
    const flows: StoredCashFlow[] = [];
    for (const row of rows) {
      const t = new Date(row.occurred_at).getTime();
      const amount = Number(row.amount);
      if (Number.isFinite(t) && Number.isFinite(amount) && amount !== 0) {
        flows.push(
          options.withAccount && row.trading_account_id
            ? { t, amount, accountId: row.trading_account_id }
            : { t, amount },
        );
      }
    }
    flows.sort((left, right) => left.t - right.t);
    return { flows, supported: true };
  } catch (error) {
    if (isMissingTable({ message: error instanceof Error ? error.message : "" })) {
      tableMissingUntil = now + TABLE_RECHECK_MS;
      return { flows: [], supported: false };
    }
    // Any other problem: the chart is drawn without the adjustment rather than not at all.
    console.warn("[cash-flows] could not read balance operations:", error instanceof Error ? error.message : error);
    return { flows: [], supported: true };
  }
}
