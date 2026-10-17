import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin, type UserRole } from "@/lib/auth/rbac";
import { AnalyticsAccessError } from "@/lib/services/analyticsService";
import { BROKER_CLOCK_SKEW_MS, MIN_BROKER_INSTANT_MS } from "@/lib/broker/orderNormalization";
import { loadCashFlows } from "@/lib/services/accountCashFlowService";
import { chunkArray } from "@/lib/supabase/pagedSelect";
import {
  PROBE_SAMPLE_POINTS,
  RPC_SAMPLE_POINTS,
  buildLedger,
  buildProbeTimes,
  buildTradeProbeTimes,
  cashFlowsForWindow,
  dropGlitchSamples,
  fillSnapshotGaps,
  gapThresholdMs,
  historyStartFor,
  normalizeSamples,
  rangeDurationMs,
  reconstructEstimatedSamples,
  resolveWindow,
  sampleCountFor,
  sortedFlows,
  summarizeTrades,
  type PerformanceCashFlow,
  type PerformanceRange,
  type PerformanceSample,
  type PerformanceSeriesDto,
  type TradeLite,
} from "@/lib/charts/performanceSeries";

/**
 * Account performance history for the Myfxbook-style chart.
 *
 * Why this exists: the old chart read "the latest 1000 snapshots of the period"
 * (PostgREST caps every response at 1000 rows and the risk worker writes a
 * snapshot every few seconds), so it only ever saw the last hour or two. Here
 * the whole history is sampled evenly through the account's lifetime and closed
 * trades are read page by page, so nothing is silently truncated.
 *
 * Sampling has two paths. With migration 058 one RPC returns ~480 evenly spaced
 * samples (plus the instants around every closed trade) in a single round trip;
 * without it the service falls back to one indexed `limit 1` lookup per sample
 * (240). Either way every sample is a stored snapshot - nothing is invented.
 *
 * Calibration: a live account's window ends at "now"; once recording stopped it
 * ends at the last recorded data, so the curve fills the chart and the date axis
 * only spans days that have data. Stretches without snapshots are bridged with
 * flagged estimates built from the closed trades.
 *
 * Web-only module: it is never imported by the AWS workers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_CONCURRENCY = 12;
/** extra trade-edge instants per request: one RPC argument / one query each */
const RPC_MAX_EXTRA = 240;
const PROBE_MAX_EXTRA = 60;
const TRADE_PAGE_SIZE = 1000;
const MAX_TRADE_PAGES = 30;
/** the hourly combined curve (no migration 058) is cut by PostgREST at 1000 rows: about this many days */
const AGGREGATE_MAX_DAYS = 40;
/** samples x accounts a combined curve may cost the database (one lookup per account and sample) */
const AGGREGATE_LOOKUP_BUDGET = 60_000;
const AGGREGATE_MIN_POINTS = 120;
const CACHE_TTL_MS = 15_000;
const MARGIN_CHECK_TTL_MS = 5 * 60_000;
const RPC_CHECK_TTL_MS = 10 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure assembly (unit tested)
// ─────────────────────────────────────────────────────────────────────────────

export type SnapshotInput = {
  /** real capture time (epoch ms) */
  t: number;
  balance: number;
  equity: number;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
};

export function assemblePerformanceDto(input: {
  accountId: string;
  currency: string | null;
  range: PerformanceRange;
  start: number;
  end: number;
  /** when the response is built; defaults to `end` (they differ for a stale account) */
  generatedAt?: number;
  snapshots: SnapshotInput[];
  trades: TradeLite[];
  tradesTruncated: boolean;
  firstSnapshotAt: number | null;
  lastSnapshotAt: number | null;
  /** first / last instant with any data (snapshot or closed trade); default: the snapshot times */
  firstDataAt?: number | null;
  lastDataAt?: number | null;
  /** the window ends at the last data because recording stopped */
  stale?: boolean;
  /** silence between recorded samples that gets bridged with estimates; omit / null = never */
  gapMs?: number | null;
  initialBalance: number | null;
  equityPeak: number | null;
  marginSupported: boolean;
  aggregate: boolean;
  aggregateLimitedToDays: number | null;
  mixedCurrencies: boolean;
  allHistory: boolean;
  /** every deposit / withdrawal known up to `end` (also those before `start`) */
  cashFlows?: ReadonlyArray<PerformanceCashFlow>;
  /** false when the table of deposits / withdrawals does not exist yet (migration 059) */
  cashFlowsSupported?: boolean;
}): PerformanceSeriesDto {
  const { start, end } = input;

  // A stored reading that can not be real (equity 0 next to a positive balance,
  // one isolated balance spike) is left out instead of drawn as a crash.
  const cleaned = dropGlitchSamples(
    [...input.snapshots]
      .filter(
        (row) => Number.isFinite(row.t) && Number.isFinite(row.balance) && Number.isFinite(row.equity),
      )
      .sort((left, right) => left.t - right.t),
  );
  const sortedSnapshots = cleaned.kept;
  const flows = sortedFlows(input.cashFlows).filter((flow) => flow.t <= end);
  const inWindow = sortedSnapshots.filter((row) => row.t >= start && row.t <= end);
  const carry = [...sortedSnapshots].reverse().find((row) => row.t < start) ?? null;

  const real: PerformanceSample[] = inWindow.map((row) => ({
    t: row.t,
    balance: row.balance,
    equity: row.equity,
    margin: row.margin,
    freeMargin: row.freeMargin,
    marginLevel: row.marginLevel,
    estimated: false,
  }));
  // The value that was valid when the window opened is the last snapshot taken
  // before it - used only as the left anchor of a line that has real points.
  if (real.length > 0 && carry) {
    real.unshift({
      t: start,
      balance: carry.balance,
      equity: carry.equity,
      margin: carry.margin,
      freeMargin: carry.freeMargin,
      marginLevel: carry.marginLevel,
      estimated: false,
    });
  }

  const tradesInWindow = input.trades.filter((trade) => trade.t >= start && trade.t <= end);
  const firstDataAt = input.firstDataAt === undefined ? input.firstSnapshotAt : input.firstDataAt;
  // The window can be wider than the account's history (1Y chosen on a young
  // account): everything below that is built from data begins where the data does.
  const historyStart = historyStartFor(start, end, firstDataAt);
  const anchor = real[0] ? { t: real[0].t, balance: real[0].balance } : null;
  // A combined curve is read from the stored sums; it is never rebuilt from trades
  // (the trades of accounts that were not connected yet would not belong to it).
  const estimated = input.aggregate
    ? []
    : reconstructEstimatedSamples({
        start,
        end,
        anchor,
        initialBalance: input.initialBalance,
        trades: tradesInWindow,
        allHistory: input.allHistory,
        flows,
        historyStart: firstDataAt,
      });

  // Recording gaps: bridge them with flagged estimates instead of one solid line.
  let gapSamples: PerformanceSample[] = [];
  let gapCount = 0;
  if (typeof input.gapMs === "number" && real.length >= 2) {
    const filled = fillSnapshotGaps({ samples: real, trades: tradesInWindow, gapMs: input.gapMs, flows });
    gapSamples = filled.samples;
    gapCount = filled.gapCount;
  }

  const samples = normalizeSamples([...estimated, ...real, ...gapSamples]);
  const stats = summarizeTrades(tradesInWindow);
  // buckets (when there are many trades) are counted from where the history begins
  const ledger = buildLedger(tradesInWindow, historyStart, end);
  const realCount = samples.filter((sample) => !sample.estimated).length;
  const windowFlows = flows.filter((flow) => flow.t >= start);

  return {
    accountId: input.accountId,
    currency: input.currency,
    range: input.range,
    generatedAt: input.generatedAt ?? end,
    start,
    end,
    samples,
    ledger,
    stats,
    cashFlows: cashFlowsForWindow(flows, samples, start, end),
    coverage: {
      firstSnapshotAt: input.firstSnapshotAt,
      lastSnapshotAt: input.lastSnapshotAt,
      firstDataAt,
      lastDataAt: input.lastDataAt === undefined ? input.lastSnapshotAt : input.lastDataAt,
      stale: input.stale ?? false,
      snapshotSamples: realCount,
      estimatedSamples: samples.length - realCount,
      gapCount,
      closedTrades: stats.tradeCount,
      tradesTruncated: input.tradesTruncated,
      marginCaptured: samples.some(
        (sample) =>
          sample.margin !== null || sample.freeMargin !== null || sample.marginLevel !== null,
      ),
      marginSupported: input.marginSupported,
      mixedCurrencies: input.mixedCurrencies,
      aggregate: input.aggregate,
      aggregateLimitedToDays: input.aggregateLimitedToDays,
      equityPeak: input.equityPeak,
      cashFlowCount: windowFlows.filter((flow) => flow.kind !== "JOIN").length,
      accountJoinCount: windowFlows.filter((flow) => flow.kind === "JOIN").length,
      cashFlowsSupported: input.cashFlowsSupported ?? false,
      glitchSamplesDropped: cleaned.dropped,
    },
  };
}

export function emptyPerformanceDto(input: {
  accountId: string;
  currency: string | null;
  range: PerformanceRange;
  now: number;
  aggregate: boolean;
  mixedCurrencies: boolean;
  marginSupported: boolean;
}): PerformanceSeriesDto {
  const duration = rangeDurationMs(input.range) ?? DAY_MS;
  return assemblePerformanceDto({
    accountId: input.accountId,
    currency: input.currency,
    range: input.range,
    start: input.now - duration,
    end: input.now,
    snapshots: [],
    trades: [],
    tradesTruncated: false,
    firstSnapshotAt: null,
    lastSnapshotAt: null,
    initialBalance: null,
    equityPeak: null,
    marginSupported: input.marginSupported,
    aggregate: input.aggregate,
    aggregateLimitedToDays: null,
    mixedCurrencies: input.mixedCurrencies,
    allHistory: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Database access
// ─────────────────────────────────────────────────────────────────────────────

type AdminDb = ReturnType<typeof createAdminClient>;

type ScopedAccount = {
  id: string;
  currency: string;
  initialBalance: number | null;
};

type SnapshotRow = {
  id?: string;
  captured_at: string;
  balance: number | string;
  equity: number | string;
  margin?: number | string | null;
  free_margin?: number | string | null;
  margin_level?: number | string | null;
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSnapshotInput(row: SnapshotRow): SnapshotInput | null {
  const t = new Date(row.captured_at).getTime();
  const balance = Number(row.balance);
  const equity = Number(row.equity);
  if (!Number.isFinite(t) || !Number.isFinite(balance) || !Number.isFinite(equity)) return null;
  return {
    t,
    balance,
    equity,
    margin: numberOrNull(row.margin),
    freeMargin: numberOrNull(row.free_margin),
    marginLevel: numberOrNull(row.margin_level),
  };
}

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /column .* does not exist|could not find the .* column/i.test(error.message ?? "");
}

let marginSupportCache: { supported: boolean; checkedAt: number } | null = null;

/** True when `account_snapshots` has the margin columns (migration 057). */
async function marginColumnsSupported(db: AdminDb): Promise<boolean> {
  const now = Date.now();
  if (marginSupportCache && now - marginSupportCache.checkedAt < MARGIN_CHECK_TTL_MS) {
    return marginSupportCache.supported;
  }
  const { error } = await db
    .from("account_snapshots")
    .select("margin, free_margin, margin_level")
    .limit(1);
  if (error && !isMissingColumnError(error)) {
    // transient problem: do not cache a verdict
    return false;
  }
  marginSupportCache = { supported: !error, checkedAt: now };
  return !error;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function resolveScope(
  accountId: string,
  userId: string,
  role: UserRole,
): Promise<{ accounts: ScopedAccount[]; aggregate: boolean }> {
  const supabase = isAdmin(role) ? createAdminClient() : await createClient();
  let query = supabase.from("trading_accounts").select("id, currency, initial_balance, status");
  if (!isAdmin(role)) query = query.eq("user_id", userId);
  if (accountId === "ALL") query = query.eq("status", "CONNECTED");
  else query = query.eq("id", accountId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to scope performance accounts: ${error.message}`);

  const accounts: ScopedAccount[] = (data ?? []).map(
    (row: { id: string; currency?: string | null; initial_balance?: number | string | null }) => ({
      id: row.id,
      currency: row.currency?.trim() || "USD",
      initialBalance: numberOrNull(row.initial_balance),
    }),
  );
  if (accountId !== "ALL" && accounts.length !== 1) throw new AnalyticsAccessError();
  return { accounts, aggregate: accountId === "ALL" };
}

async function loadEquityPeak(db: AdminDb, accountId: string): Promise<number | null> {
  try {
    const { data, error } = await db
      .from("trading_accounts")
      .select("equity_peak")
      .eq("id", accountId)
      .maybeSingle();
    if (error) return null;
    return numberOrNull((data as { equity_peak?: unknown } | null)?.equity_peak);
  } catch {
    return null;
  }
}

/** The very first stored reading of an account: when it was connected and what it held then. */
async function firstSnapshotOf(
  db: AdminDb,
  accountId: string,
): Promise<{ t: number; balance: number } | null> {
  const { data, error } = await db
    .from("account_snapshots")
    .select("captured_at, balance")
    .eq("trading_account_id", accountId)
    .order("captured_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`Failed to read first snapshot: ${error.message}`);
  const row = (data as Array<{ captured_at: string; balance: number | string }> | null)?.[0];
  const time = row?.captured_at ? new Date(row.captured_at).getTime() : NaN;
  if (!Number.isFinite(time)) return null;
  const balance = Number(row?.balance);
  return { t: time, balance: Number.isFinite(balance) ? balance : 0 };
}

async function firstSnapshotAt(db: AdminDb, accountId: string): Promise<number | null> {
  return (await firstSnapshotOf(db, accountId))?.t ?? null;
}

/**
 * The accounts of a combined curve that were connected after it began, as the
 * money they brought: from the combined curve's point of view their first
 * reading is a deposit. Taken out of growth and drawdown like one, and reported
 * separately (`kind: "JOIN"`). Accounts that already had data when the curve
 * began are part of its first reading and are not listed.
 */
export function accountJoinFlows(
  firstReadings: ReadonlyArray<{ t: number; balance: number }>,
  curveBeginsAt: number,
): PerformanceCashFlow[] {
  return firstReadings
    .filter((reading) => reading.t > curveBeginsAt && reading.balance > 0)
    .map((reading): PerformanceCashFlow => ({ t: reading.t, amount: reading.balance, kind: "JOIN" }))
    .sort((left, right) => left.t - right.t);
}

/**
 * Deposits and withdrawals of a combined curve: only those from the moment the
 * account they belong to was connected. What happened before that is not in the
 * sum (the account's whole first reading is, as a "join").
 */
export function flowsAfterAccountJoined(
  flows: ReadonlyArray<{ t: number; amount: number; accountId?: string }>,
  firstReadingAt: ReadonlyMap<string, number>,
): PerformanceCashFlow[] {
  return flows
    .filter((flow) => {
      if (!flow.accountId) return false;
      const joinedAt = firstReadingAt.get(flow.accountId);
      return joinedAt !== undefined && flow.t > joinedAt;
    })
    .map((flow) => ({ t: flow.t, amount: flow.amount }));
}

async function latestSnapshotAt(db: AdminDb, accountId: string): Promise<number | null> {
  const { data, error } = await db
    .from("account_snapshots")
    .select("captured_at")
    .eq("trading_account_id", accountId)
    .order("captured_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Failed to read latest snapshot time: ${error.message}`);
  const raw = (data as Array<{ captured_at: string }> | null)?.[0]?.captured_at;
  const time = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

async function latestSnapshot(
  db: AdminDb,
  accountId: string,
  columns: string,
): Promise<SnapshotInput | null> {
  const { data, error } = await db
    .from("account_snapshots")
    .select(columns)
    .eq("trading_account_id", accountId)
    .order("captured_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Failed to read latest snapshot: ${error.message}`);
  const row = (data as unknown as SnapshotRow[] | null)?.[0];
  return row ? toSnapshotInput(row) : null;
}

/**
 * Which stored closed trades may shape the chart. A trade time is only believed
 * when it is a real date (not the epoch-0 / year-1 placeholder some bridges send)
 * that is not in the future, and when the row has a size: deposits and other
 * balance rows synced as "trades" have lot size 0 and are not trades.
 */
function closedTradeBounds(now: number, since: number | null = null): { fromIso: string; toIso: string } {
  const lowest = since === null ? MIN_BROKER_INSTANT_MS : Math.max(since, MIN_BROKER_INSTANT_MS);
  return {
    fromIso: new Date(lowest).toISOString(),
    toIso: new Date(now + BROKER_CLOCK_SKEW_MS).toISOString(),
  };
}

/** The earliest (`ascending`) or latest closed-trade time of the accounts; long id lists are read in chunks. */
async function edgeClosedTradeAt(
  db: AdminDb,
  accountIds: string[],
  now: number,
  ascending: boolean,
): Promise<number | null> {
  const { fromIso, toIso } = closedTradeBounds(now);
  const edges = await mapPool(chunkArray(accountIds), 4, async (idChunk) => {
    const { data, error } = await db
      .from("trades")
      .select("closed_at")
      .in("trading_account_id", idChunk)
      .eq("status", "CLOSED")
      .not("closed_at", "is", null)
      .gt("volume", 0)
      .gte("closed_at", fromIso)
      .lte("closed_at", toIso)
      .order("closed_at", { ascending })
      .limit(1);
    if (error) {
      throw new Error(`Failed to read ${ascending ? "first" : "last"} closed trade: ${error.message}`);
    }
    const raw = (data as Array<{ closed_at: string }> | null)?.[0]?.closed_at;
    const time = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(time) ? time : null;
  });
  const times = edges.filter((time): time is number => time !== null);
  if (times.length === 0) return null;
  return ascending ? Math.min(...times) : Math.max(...times);
}

async function firstClosedTradeAt(db: AdminDb, accountIds: string[], now: number): Promise<number | null> {
  return edgeClosedTradeAt(db, accountIds, now, true);
}

async function lastClosedTradeAt(db: AdminDb, accountIds: string[], now: number): Promise<number | null> {
  return edgeClosedTradeAt(db, accountIds, now, false);
}

async function loadClosedTrades(
  db: AdminDb,
  accountIds: string[],
  since: number | null,
  now: number,
): Promise<{ trades: TradeLite[]; truncated: boolean }> {
  const trades: TradeLite[] = [];
  const { fromIso, toIso } = closedTradeBounds(now, since);
  let truncated = false;
  let pagesLeft = MAX_TRADE_PAGES;

  // PostgREST rejects very long `in (...)` URLs: many accounts are read in chunks.
  for (const idChunk of chunkArray(accountIds)) {
    let from = 0;
    while (true) {
      if (pagesLeft <= 0) {
        truncated = true;
        break;
      }
      pagesLeft -= 1;
      const { data, error } = await db
        .from("trades")
        .select("closed_at, profit, volume")
        .in("trading_account_id", idChunk)
        .eq("status", "CLOSED")
        .not("closed_at", "is", null)
        .gt("volume", 0)
        .gte("closed_at", fromIso)
        .lte("closed_at", toIso)
        .order("closed_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + TRADE_PAGE_SIZE - 1);
      if (error) throw new Error(`Failed to read closed trades: ${error.message}`);
      const rows = (data ?? []) as Array<{
        closed_at: string;
        profit: number | string;
        volume: number | string;
      }>;
      // A server may answer with fewer rows than asked for: only an empty page is the end.
      if (rows.length === 0) break;
      for (const row of rows) {
        const t = new Date(row.closed_at).getTime();
        const profit = Number(row.profit);
        const volume = Number(row.volume);
        if (Number.isFinite(t) && Number.isFinite(profit)) {
          trades.push({ t, profit, volume: Number.isFinite(volume) ? volume : 0 });
        }
      }
      from += rows.length;
    }
    if (truncated) break;
  }
  // chunks are each ordered by time; the chart wants one ordered list
  trades.sort((left, right) => left.t - right.t);
  return { trades, truncated };
}

/** Distinct, valid snapshots out of raw rows (several sample instants can hit the same row). */
function rowsToSnapshots(rows: Array<SnapshotRow | null>): SnapshotInput[] {
  const seen = new Set<string>();
  const result: SnapshotInput[] = [];
  for (const row of rows) {
    if (!row) continue;
    const key = row.id ?? row.captured_at;
    if (seen.has(key)) continue;
    seen.add(key);
    const input = toSnapshotInput(row);
    if (input) result.push(input);
  }
  return result;
}

async function probeSnapshots(
  db: AdminDb,
  accountId: string,
  times: number[],
  columns: string,
): Promise<SnapshotInput[]> {
  const rows = await mapPool(times, PROBE_CONCURRENCY, async (time) => {
    const { data, error } = await db
      .from("account_snapshots")
      .select(columns)
      .eq("trading_account_id", accountId)
      .lte("captured_at", new Date(time).toISOString())
      .order("captured_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`Failed to sample account history: ${error.message}`);
    return ((data as unknown as SnapshotRow[] | null)?.[0] ?? null) as SnapshotRow | null;
  });
  return rowsToSnapshots(rows);
}

// ── optional RPCs (migration 058) ────────────────────────────────────────────

function isMissingFunctionError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

const rpcVerdicts = new Map<string, { supported: boolean; checkedAt: number }>();

/**
 * Calls an RPC that may not exist yet (it ships with an optional migration).
 * Returns null when it is missing or fails - the caller then uses the slower
 * path - so a database without the migration keeps working exactly as before.
 * A "missing function" verdict is remembered for ten minutes.
 */
async function callOptionalRpc<T>(
  db: AdminDb,
  name: string,
  args: Record<string, unknown>,
): Promise<T[] | null> {
  const clock = Date.now();
  const verdict = rpcVerdicts.get(name);
  if (verdict && !verdict.supported && clock - verdict.checkedAt < RPC_CHECK_TTL_MS) return null;
  try {
    const { data, error } = await db.rpc(name, args);
    if (error) {
      if (isMissingFunctionError(error)) rpcVerdicts.set(name, { supported: false, checkedAt: clock });
      return null;
    }
    rpcVerdicts.set(name, { supported: true, checkedAt: clock });
    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return null;
  }
}

/**
 * Evenly spaced stored snapshots over [start, end] plus the instants around
 * closed trades (just before and shortly after each close, so balance steps are
 * sharp). One RPC round trip when migration 058 exists, otherwise one indexed
 * lookup per instant. `stepMs` is the spacing of the even grid.
 */
async function sampleSnapshots(
  db: AdminDb,
  accountId: string,
  start: number,
  end: number,
  trades: ReadonlyArray<{ t: number }>,
  columns: string,
): Promise<{ snapshots: SnapshotInput[]; stepMs: number }> {
  const span = Math.max(1, end - start);

  const rpcPoints = sampleCountFor(span, RPC_SAMPLE_POINTS);
  const viaRpc = await callOptionalRpc<SnapshotRow>(db, "account_snapshot_samples", {
    p_account_id: accountId,
    p_start: new Date(start).toISOString(),
    p_end: new Date(end).toISOString(),
    p_points: rpcPoints,
    p_extra: buildTradeProbeTimes(trades, start, end, { maxTrades: RPC_MAX_EXTRA / 2 }).map((time) =>
      new Date(time).toISOString(),
    ),
  });
  if (viaRpc) {
    return { snapshots: rowsToSnapshots(viaRpc), stepMs: span / Math.max(1, rpcPoints - 1) };
  }

  // Every probe is a query: fewer trade edges, spread evenly over the history.
  const probePoints = sampleCountFor(span, PROBE_SAMPLE_POINTS);
  const grid = buildProbeTimes(start, end, probePoints);
  const edges = buildTradeProbeTimes(trades, start, end, { maxTrades: PROBE_MAX_EXTRA / 2 });
  const times = [...new Set([...grid, ...edges])].sort((left, right) => left - right);
  return {
    snapshots: await probeSnapshots(db, accountId, times, columns),
    stepMs: span / Math.max(1, probePoints - 1),
  };
}

async function buildSingleAccountDto(
  account: ScopedAccount,
  range: PerformanceRange,
  now: number,
): Promise<PerformanceSeriesDto> {
  const db = createAdminClient();
  const marginSupported = await marginColumnsSupported(db);
  const columns = marginSupported
    ? "id, captured_at, balance, equity, margin, free_margin, margin_level"
    : "id, captured_at, balance, equity";

  const [firstSnap, lastSnap, firstTradeAt, lastTradeAt, equityPeak] = await Promise.all([
    firstSnapshotAt(db, account.id),
    latestSnapshot(db, account.id, columns),
    firstClosedTradeAt(db, [account.id], now),
    lastClosedTradeAt(db, [account.id], now),
    loadEquityPeak(db, account.id),
  ]);

  const firstDataAt =
    firstSnap !== null && firstTradeAt !== null
      ? Math.min(firstSnap, firstTradeAt)
      : (firstSnap ?? firstTradeAt);
  const lastDataAt =
    lastSnap !== null && lastTradeAt !== null
      ? Math.max(lastSnap.t, lastTradeAt)
      : (lastSnap?.t ?? lastTradeAt);

  // Calibrated window: up to "now" while the account is recorded live, up to the
  // last recorded data once recording stopped.
  const { start, end, stale } = resolveWindow({ range, now, firstDataAt, lastDataAt });
  const fixedRange = rangeDurationMs(range) !== null;
  const allHistory = !fixedRange || firstDataAt === null || firstDataAt >= start;

  // Closed trades first: they also tell where the balance steps are, so the
  // sampler can look the account up right before and after each close.
  const [{ trades, truncated }, cash] = await Promise.all([
    loadClosedTrades(db, [account.id], fixedRange ? start : null, now),
    loadCashFlows(db, [account.id], 0, end, now),
  ]);

  // Sample only where snapshots can exist: [max(start, first snapshot), end].
  let snapshots: SnapshotInput[] = [];
  let gapMs: number | null = null;
  if (firstSnap !== null && lastSnap !== null && lastSnap.t >= start) {
    const sampleStart = Math.max(start, firstSnap);
    // The first instant is `start` when snapshots exist before the window (it
    // finds the value that was valid when the window opened) or the first
    // snapshot itself otherwise.
    const sampled = await sampleSnapshots(db, account.id, sampleStart, end, trades, columns);
    snapshots = [...sampled.snapshots, lastSnap];
    gapMs = gapThresholdMs(
      snapshots.map((snapshot) => snapshot.t),
      sampled.stepMs,
    );
  }

  return assemblePerformanceDto({
    accountId: account.id,
    currency: account.currency,
    range,
    start,
    end,
    generatedAt: now,
    snapshots,
    trades,
    tradesTruncated: truncated,
    firstSnapshotAt: firstSnap,
    lastSnapshotAt: lastSnap?.t ?? null,
    firstDataAt,
    lastDataAt,
    stale,
    gapMs,
    initialBalance: account.initialBalance,
    equityPeak,
    marginSupported,
    aggregate: false,
    aggregateLimitedToDays: null,
    mixedCurrencies: false,
    allHistory,
    cashFlows: cash.flows,
    cashFlowsSupported: cash.supported,
  });
}

async function buildAggregateDto(
  accounts: ScopedAccount[],
  range: PerformanceRange,
  now: number,
): Promise<PerformanceSeriesDto> {
  const db = createAdminClient();
  const currencies = [...new Set(accounts.map((account) => account.currency))];
  const currency = currencies.length === 1 ? currencies[0] : null;
  const mixedCurrencies = currencies.length > 1;
  const marginSupported = await marginColumnsSupported(db);

  if (accounts.length === 0 || mixedCurrencies) {
    return emptyPerformanceDto({
      accountId: "ALL",
      currency,
      range,
      now,
      aggregate: true,
      mixedCurrencies,
      marginSupported,
    });
  }

  const accountIds = accounts.map((account) => account.id);
  const [firstReadings, lastTimes, firstTradeAt, lastTradeAt] = await Promise.all([
    mapPool(accountIds, PROBE_CONCURRENCY, (id) => firstSnapshotOf(db, id)),
    mapPool(accountIds, PROBE_CONCURRENCY, (id) => latestSnapshotAt(db, id)),
    firstClosedTradeAt(db, accountIds, now),
    lastClosedTradeAt(db, accountIds, now),
  ]);
  const firsts: Array<{ id: string; t: number; balance: number }> = [];
  firstReadings.forEach((reading, index) => {
    if (reading) firsts.push({ id: accountIds[index], t: reading.t, balance: reading.balance });
  });
  const lastSnaps = lastTimes.filter((time): time is number => time !== null);

  // The combined curve runs from the moment ANY account has data - not from the
  // moment every account has (the newest connection), which kept the chart a few
  // days long however long the platform has been recording. An account that is
  // connected later makes the sum step up; that step is the account's money
  // arriving, not performance, so it is passed on as a "join" and taken out of
  // growth and drawdown exactly like a deposit.
  const firstSnapAt = firsts.length > 0 ? Math.min(...firsts.map((first) => first.t)) : null;
  const lastSnapAt = lastSnaps.length > 0 ? Math.max(...lastSnaps) : null;
  const firstDataAt =
    firstSnapAt !== null && firstTradeAt !== null
      ? Math.min(firstSnapAt, firstTradeAt)
      : (firstSnapAt ?? firstTradeAt);
  const lastDataAt =
    lastSnapAt !== null && lastTradeAt !== null
      ? Math.max(lastSnapAt, lastTradeAt)
      : (lastSnapAt ?? lastTradeAt);

  // Same calibration as a single account: while any account is recorded live the
  // window runs to "now", once everything went quiet it ends at the last data; a
  // fixed range always spans the period that was chosen.
  const { start, end, stale } = resolveWindow({ range, now, firstDataAt, lastDataAt });

  let snapshots: SnapshotInput[] = [];
  let limitedToDays: number | null = null;
  // where the combined curve really begins (later than `firstDataAt` when it is cut)
  let curveFrom = start;
  if (firstSnapAt !== null && lastSnapAt !== null && lastSnapAt >= start) {
    type TimelineRow = { captured_at: string; balance: number | string; equity: number | string };
    // Only where snapshots can exist: the samples are not spread over time before the first one.
    const sampleFrom = Math.max(start, firstSnapAt);
    curveFrom = sampleFrom;
    // Every sample costs one lookup per account: many accounts get fewer samples.
    const points = Math.min(
      RPC_SAMPLE_POINTS,
      Math.max(AGGREGATE_MIN_POINTS, Math.floor(AGGREGATE_LOOKUP_BUDGET / accountIds.length)),
    );
    // Evenly spaced curve over the whole period when migration 058 exists...
    let rows = await callOptionalRpc<TimelineRow>(db, "platform_equity_samples", {
      p_account_ids: accountIds,
      p_start: new Date(sampleFrom).toISOString(),
      p_end: new Date(end).toISOString(),
      p_points: sampleCountFor(Math.max(1, end - sampleFrom), points),
    });
    if (!rows) {
      // ...otherwise the original hourly curve, which PostgREST cuts at 1000 rows
      // (about 40 days): the period is still the one that was chosen, the curve
      // covers what the database returns and says so.
      const hourlyFrom = Math.max(sampleFrom, end - AGGREGATE_MAX_DAYS * DAY_MS);
      if (hourlyFrom > sampleFrom) limitedToDays = AGGREGATE_MAX_DAYS;
      curveFrom = hourlyFrom;
      const { data, error } = await db.rpc("platform_equity_timeline", {
        p_account_ids: accountIds,
        p_start: new Date(hourlyFrom).toISOString(),
      });
      if (error) throw new Error(`Failed to load combined equity history: ${error.message}`);
      rows = (data ?? []) as TimelineRow[];
    }
    snapshots = rows
      .map((row) =>
        toSnapshotInput({
          captured_at: row.captured_at,
          balance: row.balance,
          equity: row.equity,
        }),
      )
      .filter((row): row is SnapshotInput => row !== null)
      // the hourly fallback runs to the present; nothing after the last data is real
      .filter((row) => row.t >= start && row.t <= end);
  }

  const [{ trades, truncated }, cash] = await Promise.all([
    loadClosedTrades(db, accountIds, curveFrom, now),
    loadCashFlows(db, accountIds, 0, end, now, { withAccount: true }),
  ]);

  // Money that moved the sum: deposits / withdrawals made after their account was
  // connected, and the accounts that were connected after the curve began.
  const firstReadingAt = new Map(firsts.map((first) => [first.id, first.t] as const));
  const firstSampleAt = snapshots.length > 0 ? Math.min(...snapshots.map((row) => row.t)) : null;
  const cashFlows: PerformanceCashFlow[] = [
    ...flowsAfterAccountJoined(cash.flows, firstReadingAt),
    ...(firstSampleAt === null ? [] : accountJoinFlows(firsts, firstSampleAt)),
  ];

  return assemblePerformanceDto({
    accountId: "ALL",
    currency,
    range,
    start,
    end,
    generatedAt: now,
    snapshots,
    trades,
    tradesTruncated: truncated,
    firstSnapshotAt: firstSnapAt,
    lastSnapshotAt: lastSnapAt,
    // a cut hourly curve does not reach back to the first data: the time before it is "no data"
    firstDataAt: limitedToDays !== null ? curveFrom : firstDataAt,
    lastDataAt,
    stale,
    initialBalance: null,
    equityPeak: null,
    marginSupported,
    aggregate: true,
    aggregateLimitedToDays: limitedToDays,
    mixedCurrencies: false,
    allHistory: false,
    cashFlows,
    cashFlowsSupported: cash.supported,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

const responseCache = new Map<string, { expiresAt: number; value: PerformanceSeriesDto }>();

export async function getPerformanceSeries(params: {
  accountId: string;
  userId: string;
  role: UserRole;
  range: PerformanceRange;
  now?: number;
}): Promise<PerformanceSeriesDto> {
  const now = params.now ?? Date.now();
  const cacheKey = `${params.userId}|${params.role}|${params.accountId}|${params.range}`;
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const scope = await resolveScope(params.accountId, params.userId, params.role);
  const value = scope.aggregate
    ? await buildAggregateDto(scope.accounts, params.range, now)
    : await buildSingleAccountDto(scope.accounts[0], params.range, now);

  if (responseCache.size > 200) {
    for (const [key, entry] of responseCache) {
      if (entry.expiresAt <= now) responseCache.delete(key);
    }
    if (responseCache.size > 200) responseCache.clear();
  }
  responseCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}
