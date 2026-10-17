import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapTradeToDto } from "@/lib/mappers/tradeMapper";
import { buildAnalyticsSummary } from "@/lib/domain/metrics";
import type { AnalyticsSummary, BrokerCashTransfer, BrokerPerformanceChart, EquityPoint } from "@/lib/domain/types";
import { isAdmin, type UserRole } from "@/lib/auth/rbac";
import { Api2TradeClient, loadApi2TradeConfig, type Api2TradeOrder } from "@/lib/broker/api2TradeClient";

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

function asIsoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = typeof value === "number"
    ? new Date(value > 100_000_000_000 ? value : value * 1_000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeBrokerEquityHistory(
  rows: Awaited<ReturnType<Api2TradeClient["equityHistory"]>>,
): EquityPoint[] {
  const unique = new Map<string, EquityPoint>();
  for (const row of rows) {
    const capturedAt = asIsoDate(row.time);
    const balance = Number(row.balance);
    const equity = Number(row.equity);
    if (!capturedAt || !Number.isFinite(balance) || !Number.isFinite(equity)) continue;
    unique.set(capturedAt, { capturedAt, balance, equity });
  }
  return [...unique.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

function normalizeBrokerCashTransfers(rows: Api2TradeOrder[]): BrokerCashTransfer[] {
  const transfers = new Map<string, BrokerCashTransfer>();
  for (const row of rows) {
    const operation = String(row.dealType ?? row.orderType ?? row.type ?? "").toLowerCase();
    const comment = String(row.comment ?? "").trim();
    const hasCashOperation = /balance|deposit|withdraw|withdrawal|cashout|transfer/.test(`${operation} ${comment.toLowerCase()}`);
    const amount = Number(row.profit ?? 0);
    const occurredAt = asIsoDate(row.closeTime ?? row.openTime ?? row.closeTimestampUTC ?? row.openTimestampUTC);
    if (!hasCashOperation || !occurredAt || !Number.isFinite(amount) || amount === 0) continue;
    const type = /withdraw|cashout/.test(`${operation} ${comment.toLowerCase()}`) || amount < 0
      ? "WITHDRAWAL"
      : "DEPOSIT";
    const id = String(row.ticket ?? row.id ?? row.orderId ?? `${occurredAt}:${amount}`);
    transfers.set(id, { id, occurredAt, amount: Math.abs(amount), type, comment: comment || null });
  }
  return [...transfers.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

async function loadBrokerCashTransferHistory(
  client: Api2TradeClient,
  params: { accountId: string; from: string; to: string },
): Promise<Api2TradeOrder[]> {
  const pageSize = 500;
  const maxPages = 20;
  const rows: Api2TradeOrder[] = [];
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await client.orderHistoryWithCashTransfers({ ...params, ordersPerPage: pageSize, pageNumber });
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

/**
 * Prefer API2Trade's authoritative chart and balance-operation history for a
 * single connected account. Local snapshots remain a truthful availability
 * fallback when the provider has no history yet or is temporarily unreachable.
 */
export async function getBrokerPerformanceChart(
  accountId: string,
  userId: string,
  role: UserRole,
  period: AnalyticsPeriod = "ALL_TIME",
): Promise<BrokerPerformanceChart> {
  const accountIds = await getScopedAccountIds(accountId, userId, role);
  if (accountIds.length !== 1) {
    return {
      equityCurve: await loadScopedEquityCurve(accountIds, period),
      cashTransfers: [],
      source: "SNAPSHOTS",
      refreshedAt: new Date().toISOString(),
    };
  }

  const supabase = createAdminClient();
  const { data: account, error } = await supabase
    .from("trading_accounts")
    .select("provider_account_id")
    .eq("id", accountIds[0])
    .maybeSingle();
  if (error) throw new Error(`Failed to load broker chart account: ${error.message}`);

  const config = loadApi2TradeConfig();
  const providerAccountId = typeof account?.provider_account_id === "string" ? account.provider_account_id.trim() : "";
  const fallback = () => loadScopedEquityCurve(accountIds, period).then((equityCurve) => ({
    equityCurve,
    cashTransfers: [],
    source: "SNAPSHOTS" as const,
    refreshedAt: new Date().toISOString(),
  }));
  if (!config || !providerAccountId) return fallback();

  const from = (getAnalyticsPeriodStart(period) ?? new Date(Date.UTC(2000, 0, 1))).toISOString();
  const to = new Date().toISOString();
  try {
    const client = new Api2TradeClient(config);
    const [equityResult, cashTransferResult] = await Promise.allSettled([
      client.equityHistory({ accountId: providerAccountId, from, excludeSameBars: true }),
      loadBrokerCashTransferHistory(client, { accountId: providerAccountId, from, to }),
    ]);
    if (equityResult.status !== "fulfilled") return fallback();
    const equityCurve = normalizeBrokerEquityHistory(equityResult.value);
    // A valid but empty provider history is not replaced with made-up points.
    if (equityCurve.length === 0) return fallback();
    return {
      equityCurve,
      cashTransfers: cashTransferResult.status === "fulfilled"
        ? normalizeBrokerCashTransfers(cashTransferResult.value)
        : [],
      source: "API2TRADE",
      refreshedAt: new Date().toISOString(),
    };
  } catch {
    return fallback();
  }
}
