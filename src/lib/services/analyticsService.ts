import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapTradeToDto } from "@/lib/mappers/tradeMapper";
import { buildAnalyticsSummary } from "@/lib/domain/metrics";
import type { AnalyticsSummary, EquityPoint } from "@/lib/domain/types";
import { isAdmin, type UserRole } from "@/lib/auth/rbac";

export type AnalyticsPeriod = AnalyticsSummary["period"];

export class AnalyticsAccessError extends Error {
  constructor(message = "Account not found or access denied") {
    super(message);
    this.name = "AnalyticsAccessError";
  }
}

type SnapshotRow = {
  trading_account_id: string;
  balance: number | string;
  equity: number | string;
  drawdown_percent?: number | string | null;
  captured_at: string;
};

export function getAnalyticsPeriodStart(
  period: AnalyticsPeriod,
  now = new Date(),
): Date | null {
  if (period === "ALL_TIME") return null;
  if (period === "DAILY") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  if (period === "MONTHLY") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

export function mapScopedEquityCurve(
  rows: SnapshotRow[],
  aggregate: boolean,
): EquityPoint[] {
  if (!aggregate) {
    return [...rows].reverse().map((row) => ({
      capturedAt: row.captured_at,
      balance: Number(row.balance),
      equity: Number(row.equity),
    }));
  }

  // Rows arrive newest first. Keep the latest snapshot per account/day, then
  // sum accounts by day to avoid a misleading zig-zag multi-account chart.
  const latestPerAccountDay = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const day = row.captured_at.slice(0, 10);
    const key = `${day}:${row.trading_account_id}`;
    if (!latestPerAccountDay.has(key)) latestPerAccountDay.set(key, row);
  }

  const totals = new Map<string, { balance: number; equity: number }>();
  for (const row of latestPerAccountDay.values()) {
    const day = row.captured_at.slice(0, 10);
    const current = totals.get(day) ?? { balance: 0, equity: 0 };
    current.balance += Number(row.balance);
    current.equity += Number(row.equity);
    totals.set(day, current);
  }

  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, total]) => ({
      capturedAt: `${day}T23:59:59.999Z`,
      balance: total.balance,
      equity: total.equity,
    }));
}

async function getScopedAccountIds(
  accountId: string,
  userId: string,
  role: UserRole,
): Promise<string[]> {
  const supabase = isAdmin(role) ? createAdminClient() : await createClient();
  let query = supabase
    .from("trading_accounts")
    .select("id")
    .eq("status", "CONNECTED");

  if (!isAdmin(role)) query = query.eq("user_id", userId);
  if (accountId !== "ALL") query = query.eq("id", accountId);

  const { data, error } = await query;
  if (error)
    throw new Error(`Failed to scope analytics accounts: ${error.message}`);

  const accountIds = (data ?? []).map((account) => account.id as string);
  if (accountId !== "ALL" && accountIds.length !== 1)
    throw new AnalyticsAccessError();
  return accountIds;
}

async function loadScopedEquityCurve(
  accountIds: string[],
  period: AnalyticsPeriod,
): Promise<EquityPoint[]> {
  if (accountIds.length === 0) return [];
  const supabase = createAdminClient();
  const start = getAnalyticsPeriodStart(period);
  let query = supabase
    .from("account_snapshots")
    .select("trading_account_id, balance, equity, captured_at")
    .in("trading_account_id", accountIds)
    .order("captured_at", { ascending: false })
    .limit(10_000);

  if (start) query = query.gte("captured_at", start.toISOString());
  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch equity curve: ${error.message}`);
  return mapScopedEquityCurve(
    (data ?? []) as SnapshotRow[],
    accountIds.length > 1,
  );
}

async function loadScopedSnapshotDrawdown(
  accountIds: string[],
  period: AnalyticsPeriod,
): Promise<number> {
  if (accountIds.length === 0) return 0;
  const supabase = createAdminClient();
  const start = getAnalyticsPeriodStart(period);
  let query = supabase
    .from("account_snapshots")
    .select("drawdown_percent")
    .in("trading_account_id", accountIds)
    .order("captured_at", { ascending: false })
    .limit(10_000);

  if (start) query = query.gte("captured_at", start.toISOString());

  const { data, error } = await query;
  if (error)
    throw new Error(
      `Failed to fetch live drawdown snapshots: ${error.message}`,
    );

  return Number(
    Math.max(
      0,
      ...(data ?? [])
        .map((row) => Number(row.drawdown_percent ?? 0))
        .filter(Number.isFinite),
    ).toFixed(2),
  );
}

const SUMMARY_TRADE_COLUMNS =
  "id, short_trade_id, trading_account_id, symbol, side, status, volume, open_price, close_price, profit, currency, opened_at, closed_at";
const SUMMARY_TRADE_PAGE_SIZE = 1000;
const SUMMARY_TRADE_MAX_ROWS = 10_000;

/**
 * Closed trades of the scope, newest first, read page by page.
 *
 * PostgREST (Supabase) caps every response at 1000 rows no matter what
 * `.limit()` asks for, so a single `.limit(10_000)` silently returned only the
 * newest 1000 trades and made profit / win rate wrong for busy accounts.
 */
async function loadScopedClosedTrades(
  accountIds: string[],
  start: Date | null,
): Promise<Array<Parameters<typeof mapTradeToDto>[0]>> {
  const supabase = createAdminClient();
  const rows: Array<Parameters<typeof mapTradeToDto>[0]> = [];
  for (let from = 0; from < SUMMARY_TRADE_MAX_ROWS; from += SUMMARY_TRADE_PAGE_SIZE) {
    let query = supabase
      .from("trades")
      .select(SUMMARY_TRADE_COLUMNS)
      .in("trading_account_id", accountIds)
      .eq("status", "CLOSED")
      .order("closed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + SUMMARY_TRADE_PAGE_SIZE - 1);
    if (start) query = query.gte("closed_at", start.toISOString());

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch trades: ${error.message}`);
    const page = (data ?? []) as unknown as Array<Parameters<typeof mapTradeToDto>[0]>;
    rows.push(...page);
    if (page.length < SUMMARY_TRADE_PAGE_SIZE) break;
  }
  return rows;
}

export async function getAnalyticsSummary(
  accountId: string,
  userId: string,
  role: UserRole,
  period: AnalyticsPeriod = "ALL_TIME",
): Promise<AnalyticsSummary> {
  const accountIds = await getScopedAccountIds(accountId, userId, role);
  if (accountIds.length === 0) {
    return { ...buildAnalyticsSummary(accountId, [], []), period };
  }

  const start = getAnalyticsPeriodStart(period);
  const [tradeRows, equityCurve, snapshotDrawdownPercent] = await Promise.all([
    loadScopedClosedTrades(accountIds, start),
    loadScopedEquityCurve(accountIds, period),
    loadScopedSnapshotDrawdown(accountIds, period),
  ]);

  const summary = buildAnalyticsSummary(accountId, tradeRows.map(mapTradeToDto), equityCurve);

  return {
    ...summary,
    maxDrawdownPercent: Math.max(
      summary.maxDrawdownPercent,
      snapshotDrawdownPercent,
    ),
    period,
  };
}

export async function getEquityCurve(
  accountId: string,
  userId: string,
  role: UserRole,
  period: AnalyticsPeriod = "ALL_TIME",
): Promise<EquityPoint[]> {
  const accountIds = await getScopedAccountIds(accountId, userId, role);
  return loadScopedEquityCurve(accountIds, period);
}
