import { beforeEach, describe, expect, test, vi } from "vitest";
import { deriveSeries } from "@/lib/charts/performanceSeries";
import {
  accountJoinFlows,
  assemblePerformanceDto,
  emptyPerformanceDto,
  flowsAfterAccountJoined,
  type SnapshotInput,
} from "@/lib/services/performanceService";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/services/analyticsService", () => {
  class AnalyticsAccessError extends Error {
    constructor(message = "Account not found or access denied") {
      super(message);
      this.name = "AnalyticsAccessError";
    }
  }
  return { AnalyticsAccessError };
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// A tiny in-memory stand-in for the parts of Supabase/PostgREST the service
// uses. It honours the 1000-row response cap that broke the old chart.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string };
type QueryResult = { data: unknown; error: DbError | null };

interface QueryLogEntry {
  table: string;
  columns: string[];
  filters: string[];
  range: [number, number] | null;
}

interface FakeOptions {
  /** does account_snapshots have the margin columns (migration 057)? */
  marginColumns: boolean;
  /** PostgREST response cap */
  maxRows: number;
  /** rows answered by the platform_equity_timeline RPC (hourly, always present) */
  timeline: Row[];
  /** migration 058 applied: account_snapshot_samples exists and is emulated */
  snapshotSamples: boolean;
  /** migration 058 applied: rows answered by platform_equity_samples (null = function missing) */
  aggregateSamples: Row[] | null;
  /** account_snapshot_samples fails with this error although it exists (e.g. a timeout) */
  rpcError: DbError | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

function comparable(value: unknown): number | string {
  if (typeof value === "number") return value;
  if (typeof value === "string") return ISO_DATE.test(value) ? Date.parse(value) : value;
  return String(value);
}

function compareValues(left: unknown, right: unknown): number {
  const a = comparable(left);
  const b = comparable(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

class FakeQuery implements PromiseLike<QueryResult> {
  private columns: string[] = [];
  private readonly predicates: Array<(row: Row) => boolean> = [];
  private readonly filters: string[] = [];
  private readonly orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private rangeBounds: [number, number] | null = null;
  private wantsSingle = false;

  constructor(
    private readonly table: string,
    private readonly db: FakeDb,
  ) {}

  select(columns: string): this {
    this.columns = columns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push(`eq:${column}`);
    this.predicates.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push(`in:${column}`);
    this.predicates.push((row) => values.includes(row[column]));
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push(`lte:${column}`);
    this.predicates.push((row) => compareValues(row[column], value) <= 0);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push(`gte:${column}`);
    this.predicates.push((row) => compareValues(row[column], value) >= 0);
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push(`gt:${column}`);
    this.predicates.push((row) => compareValues(row[column], value) > 0);
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this.filters.push(`not:${column}`);
    if (operator === "is" && value === null) {
      this.predicates.push((row) => row[column] !== null && row[column] !== undefined);
    }
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeBounds = [from, to];
    return this;
  }

  maybeSingle(): this {
    this.wantsSingle = true;
    this.limitCount = 1;
    return this;
  }

  private run(): QueryResult {
    this.db.log.push({
      table: this.table,
      columns: this.columns,
      filters: this.filters,
      range: this.rangeBounds,
    });

    if (this.table === "account_snapshots" && !this.db.options.marginColumns) {
      const missing = this.columns.find((column) =>
        ["margin", "free_margin", "margin_level"].includes(column),
      );
      if (missing) {
        return { data: null, error: { code: "42703", message: `column account_snapshots.${missing} does not exist` } };
      }
    }

    let rows = (this.db.tables[this.table] ?? []).filter((row) =>
      this.predicates.every((predicate) => predicate(row)),
    );
    rows = [...rows].sort((left, right) => {
      for (const order of this.orders) {
        const result = compareValues(left[order.column], right[order.column]);
        if (result !== 0) return order.ascending ? result : -result;
      }
      return 0;
    });
    if (this.rangeBounds) rows = rows.slice(this.rangeBounds[0], this.rangeBounds[1] + 1);
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    rows = rows.slice(0, this.db.options.maxRows);

    const projected =
      this.columns.length > 0
        ? rows.map((row) => Object.fromEntries(this.columns.map((column) => [column, row[column]])))
        : rows;
    return { data: this.wantsSingle ? (projected[0] ?? null) : projected, error: null };
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

class FakeDb {
  readonly log: QueryLogEntry[] = [];
  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  constructor(
    readonly tables: Record<string, Row[]>,
    readonly options: FakeOptions,
  ) {}

  from(table: string): FakeQuery {
    return new FakeQuery(table, this);
  }

  rpc(fn: string, args: Record<string, unknown>): Promise<QueryResult> {
    this.rpcCalls.push({ fn, args });
    if (fn === "platform_equity_timeline") {
      return Promise.resolve({ data: this.options.timeline, error: null });
    }
    if (fn === "platform_equity_samples" && this.options.aggregateSamples) {
      return Promise.resolve({ data: this.options.aggregateSamples, error: null });
    }
    if (fn === "account_snapshot_samples" && this.options.snapshotSamples) {
      if (this.options.rpcError) return Promise.resolve({ data: null, error: this.options.rpcError });
      return Promise.resolve({ data: this.emulateSnapshotSamples(args), error: null });
    }
    // what PostgREST answers for a function that was never created
    return Promise.resolve({
      data: null,
      error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` },
    });
  }

  /** Mirrors public.account_snapshot_samples (migration 058): latest stored row at or before each instant. */
  private emulateSnapshotSamples(args: Record<string, unknown>): Row[] {
    const start = Date.parse(String(args.p_start));
    const end = Date.parse(String(args.p_end));
    const points = Math.max(2, Math.min(Number(args.p_points ?? 480), 700));
    const extra = ((args.p_extra as string[] | undefined) ?? [])
      .map((value) => Date.parse(value))
      .filter((time) => time >= start && time <= end)
      .slice(0, 300);
    const instants = [
      ...Array.from({ length: points }, (_, index) => start + ((end - start) * index) / (points - 1)),
      ...extra,
    ];
    const rows = (this.tables.account_snapshots ?? [])
      .filter((row) => row.trading_account_id === args.p_account_id)
      .sort((left, right) => compareValues(left.captured_at, right.captured_at));
    const picked = new Map<string, Row>();
    for (const instant of instants) {
      let low = 0;
      let high = rows.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (Date.parse(rows[middle].captured_at as string) <= instant) {
          found = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (found >= 0) picked.set(String(rows[found].id), rows[found]);
    }
    return [...picked.values()].map((row) => {
      const copy: Row = { ...row };
      delete copy.trading_account_id;
      return copy;
    });
  }

  queries(table: string, predicate: (entry: QueryLogEntry) => boolean = () => true): QueryLogEntry[] {
    return this.log.filter((entry) => entry.table === table && predicate(entry));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function account(id: string, extra: Row = {}): Row {
  return {
    id,
    user_id: "user-1",
    currency: "USD",
    initial_balance: 1_000,
    status: "CONNECTED",
    equity_peak: 1_200,
    ...extra,
  };
}

function snapshots(
  accountId: string,
  firstAt: number,
  count: number,
  stepMs: number,
  build: (index: number) => { balance: number; equity: number } & Row,
  /** keeps ids unique when one account gets several runs of snapshots */
  tag = "s",
): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${accountId}-${tag}${String(index).padStart(6, "0")}`,
    trading_account_id: accountId,
    captured_at: new Date(firstAt + index * stepMs).toISOString(),
    ...build(index),
  }));
}

function closedTrades(
  accountId: string,
  firstAt: number,
  count: number,
  stepMs: number,
  build: (index: number) => { profit: number; volume: number },
): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${accountId}-t${String(index).padStart(6, "0")}`,
    trading_account_id: accountId,
    status: "CLOSED",
    closed_at: new Date(firstAt + index * stepMs).toISOString(),
    ...build(index),
  }));
}

async function setup(
  tables: Partial<Record<"trading_accounts" | "account_snapshots" | "trades" | "account_cash_flows", Row[]>>,
  options: Partial<FakeOptions> = {},
) {
  vi.resetModules();
  const db = new FakeDb(
    {
      trading_accounts: tables.trading_accounts ?? [],
      account_snapshots: tables.account_snapshots ?? [],
      trades: tables.trades ?? [],
      account_cash_flows: tables.account_cash_flows ?? [],
    },
    {
      marginColumns: false,
      maxRows: 1_000,
      timeline: [],
      snapshotSamples: false,
      aggregateSamples: null,
      rpcError: null,
      ...options,
    },
  );
  const adminModule = await import("@/lib/supabase/admin");
  const serverModule = await import("@/lib/supabase/server");
  vi.mocked(adminModule.createAdminClient).mockReturnValue(db as never);
  vi.mocked(serverModule.createClient).mockResolvedValue(db as never);
  const analytics = await import("@/lib/services/analyticsService");
  const service = await import("@/lib/services/performanceService");
  return { db, service, AnalyticsAccessError: analytics.AnalyticsAccessError };
}

const asTrader = { userId: "user-1", role: "TRADER" as const };
const asAdmin = { userId: "admin-1", role: "ADMIN" as const };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure assembly
// ─────────────────────────────────────────────────────────────────────────────

describe("assemblePerformanceDto", () => {
  function assemble(overrides: Partial<Parameters<typeof assemblePerformanceDto>[0]>) {
    return assemblePerformanceDto({
      accountId: "acc-1",
      currency: "USD",
      range: "ALL",
      start: 1_000,
      end: 5_000,
      snapshots: [],
      trades: [],
      tradesTruncated: false,
      firstSnapshotAt: null,
      lastSnapshotAt: null,
      initialBalance: null,
      equityPeak: null,
      marginSupported: true,
      aggregate: false,
      aggregateLimitedToDays: null,
      mixedCurrencies: false,
      allHistory: false,
      ...overrides,
    });
  }

  const snap = (
    t: number,
    balance: number,
    equity: number,
    extra: Partial<SnapshotInput> = {},
  ): SnapshotInput => ({ t, balance, equity, margin: null, freeMargin: null, marginLevel: null, ...extra });

  test("the value valid when the window opened anchors the left edge of a line that has real points", () => {
    const dto = assemble({
      snapshots: [snap(500, 900, 910), snap(1_500, 950, 960), snap(2_500, 970, 980)],
    });
    expect(dto.samples.map((sample) => [sample.t, sample.balance, sample.equity, sample.estimated])).toEqual([
      [1_000, 900, 910, false],
      [1_500, 950, 960, false],
      [2_500, 970, 980, false],
    ]);
    expect(dto.coverage.snapshotSamples).toBe(3);
    expect(dto.coverage.estimatedSamples).toBe(0);
  });

  test("a snapshot older than the window alone does not make a line", () => {
    const dto = assemble({ snapshots: [snap(500, 900, 910)] });
    expect(dto.samples).toEqual([]);
  });

  test("snapshots after the window are ignored and invalid rows are dropped", () => {
    const dto = assemble({
      snapshots: [snap(2_000, 1, 1), snap(9_000, 5, 5), snap(Number.NaN, 7, 7), snap(3_000, Number.NaN, 7)],
    });
    expect(dto.samples.map((sample) => sample.t)).toEqual([2_000]);
  });

  test("only trades inside the window count", () => {
    const dto = assemble({
      snapshots: [snap(2_000, 1_000, 1_000)],
      trades: [
        { t: 500, profit: 1_000, volume: 9 },
        { t: 2_000, profit: 40, volume: 0.1 },
        { t: 3_000, profit: -10, volume: 0.2 },
        { t: 9_000, profit: 1_000, volume: 9 },
      ],
    });
    expect(dto.stats.tradeCount).toBe(2);
    expect(dto.stats.totalProfit).toBe(30);
    expect(dto.coverage.closedTrades).toBe(2);
    expect(dto.ledger.reduce((sum, point) => sum + point.profit, 0)).toBe(30);
  });

  test("before the first snapshot the balance is rebuilt from closed trades and flagged as estimated", () => {
    const dto = assemble({
      snapshots: [snap(3_000, 1_000, 1_000)],
      trades: [
        { t: 1_500, profit: 50, volume: 1 },
        { t: 2_000, profit: -20, volume: 1 },
      ],
    });
    const estimated = dto.samples.filter((sample) => sample.estimated);
    expect(estimated.map((sample) => [sample.t, sample.balance])).toEqual([
      [1_000, 970],
      [1_500, 1_020],
      [2_000, 1_000],
    ]);
    expect(dto.samples[dto.samples.length - 1]).toMatchObject({ t: 3_000, estimated: false });
    expect(dto.coverage).toMatchObject({ snapshotSamples: 1, estimatedSamples: 3 });
  });

  test("with no snapshot at all the whole history is rebuilt forward from the initial balance", () => {
    const dto = assemble({
      trades: [
        { t: 1_500, profit: 50, volume: 1 },
        { t: 2_500, profit: -20, volume: 1 },
      ],
      initialBalance: 1_000,
      allHistory: true,
    });
    expect(dto.samples.length).toBeGreaterThan(0);
    expect(dto.samples.every((sample) => sample.estimated)).toBe(true);
    expect(dto.samples[dto.samples.length - 1]).toMatchObject({ t: 5_000, balance: 1_030 });
  });

  test("a combined curve is never rebuilt forward (its initial balance is unknown)", () => {
    const dto = assemble({
      trades: [{ t: 1_500, profit: 50, volume: 1 }],
      initialBalance: 1_000,
      allHistory: true,
      aggregate: true,
    });
    expect(dto.samples).toEqual([]);
  });

  test("margin is reported captured only when a returned sample has it", () => {
    const without = assemble({ snapshots: [snap(2_000, 1, 1)] });
    const withMargin = assemble({
      snapshots: [snap(2_000, 1, 1), snap(3_000, 1, 1, { margin: 10, freeMargin: 90, marginLevel: 1_000 })],
    });
    expect(without.coverage.marginCaptured).toBe(false);
    expect(withMargin.coverage.marginCaptured).toBe(true);
    expect(withMargin.samples[1]).toMatchObject({ margin: 10, freeMargin: 90, marginLevel: 1_000 });
  });

  test("window, flags and peak are passed through", () => {
    const dto = assemble({
      range: "1W",
      equityPeak: 1_234.5,
      tradesTruncated: true,
      mixedCurrencies: true,
      aggregateLimitedToDays: 40,
      firstSnapshotAt: 111,
      lastSnapshotAt: 222,
      marginSupported: false,
    });
    expect(dto).toMatchObject({ range: "1W", start: 1_000, end: 5_000, generatedAt: 5_000, currency: "USD" });
    expect(dto.coverage).toMatchObject({
      equityPeak: 1_234.5,
      tradesTruncated: true,
      mixedCurrencies: true,
      aggregateLimitedToDays: 40,
      firstSnapshotAt: 111,
      lastSnapshotAt: 222,
      marginSupported: false,
    });
  });

  test("generation time, data span and the stale flag are passed through and default to the snapshot span", () => {
    const plain = assemble({ firstSnapshotAt: 111, lastSnapshotAt: 222 });
    expect(plain.generatedAt).toBe(5_000);
    expect(plain.coverage).toMatchObject({ firstDataAt: 111, lastDataAt: 222, stale: false, gapCount: 0 });

    const calibrated = assemble({
      generatedAt: 9_000,
      firstSnapshotAt: 111,
      lastSnapshotAt: 222,
      firstDataAt: 100,
      lastDataAt: 4_000,
      stale: true,
    });
    expect(calibrated.generatedAt).toBe(9_000);
    expect(calibrated.coverage).toMatchObject({ firstDataAt: 100, lastDataAt: 4_000, stale: true });
  });

  test("a silence between recorded samples is bridged with flagged estimates that follow the closed trades", () => {
    const input = {
      start: 0,
      end: 10 * HOUR,
      snapshots: [snap(0, 1_000, 1_020), snap(6 * HOUR, 1_100, 1_100), snap(6 * HOUR + MINUTE, 1_100, 1_101)],
      trades: [
        { t: HOUR, profit: 50, volume: 1 },
        { t: 3 * HOUR, profit: 50, volume: 1 },
      ],
    };
    const bridged = assemble({ ...input, gapMs: 30 * MINUTE });
    expect(bridged.coverage).toMatchObject({ gapCount: 1, snapshotSamples: 3, estimatedSamples: 5 });
    const estimated = bridged.samples.filter((sample) => sample.estimated);
    expect(estimated.map((sample) => [sample.t, sample.balance, sample.equity])).toEqual([
      [1, 1_000, 1_020],
      [HOUR - 1, 1_000, 1_020],
      [HOUR, 1_050, 1_070],
      [3 * HOUR - 1, 1_050, 1_070],
      [3 * HOUR, 1_100, 1_120],
    ]);
    // recorded samples are never touched
    expect(bridged.samples.filter((sample) => !sample.estimated).map((sample) => [sample.t, sample.equity])).toEqual([
      [0, 1_020],
      [6 * HOUR, 1_100],
      [6 * HOUR + MINUTE, 1_101],
    ]);

    const untouched = assemble({ ...input, gapMs: null });
    expect(untouched.coverage).toMatchObject({ gapCount: 0, estimatedSamples: 0 });
    expect(untouched.samples).toHaveLength(3);
  });

  test("a window wider than the history keeps the chosen axis but estimates nothing before the first data", () => {
    // ten days chosen, the account has data for the last four
    const dto = assemble({
      start: 0,
      end: 10 * DAY,
      firstDataAt: 6 * DAY,
      firstSnapshotAt: 8 * DAY,
      lastSnapshotAt: 9 * DAY,
      snapshots: [snap(8 * DAY, 1_030, 1_030), snap(9 * DAY, 1_040, 1_040)],
      trades: [
        { t: 6 * DAY, profit: 50, volume: 1 },
        { t: 7 * DAY, profit: -20, volume: 1 },
      ],
    });
    expect(dto).toMatchObject({ start: 0, end: 10 * DAY });
    expect(dto.coverage.firstDataAt).toBe(6 * DAY);
    // the opening step sits one millisecond before the first closed trade - never at the window start
    expect(dto.samples[0].t).toBe(6 * DAY - 1);
    expect(dto.samples.filter((sample) => sample.estimated).map((sample) => [sample.t, sample.balance])).toEqual([
      [6 * DAY - 1, 1_000],
      [6 * DAY, 1_050],
      [7 * DAY, 1_030],
    ]);
  });

  test("a trade-only history in a wider window is rebuilt from its own first trade, not from the window start", () => {
    const dto = assemble({
      start: 0,
      end: 10 * DAY,
      firstDataAt: 6 * DAY,
      initialBalance: 1_000,
      allHistory: true,
      trades: [
        { t: 6 * DAY, profit: 50, volume: 1 },
        { t: 8 * DAY, profit: -20, volume: 1 },
      ],
    });
    expect(dto.samples.every((sample) => sample.estimated && sample.t >= 6 * DAY - 1)).toBe(true);
    expect(dto.samples[0]).toMatchObject({ t: 6 * DAY - 1, balance: 1_000 });
    expect(dto.samples[dto.samples.length - 1]).toMatchObject({ t: 10 * DAY, balance: 1_030 });
  });

  test("ledger buckets are counted from where the history begins, so a young account keeps its detail", () => {
    // 500 trades over three days, in a ten-day window that only has data from day six on
    const trades = Array.from({ length: 500 }, (_, index) => ({
      t: 6 * DAY + Math.round((index * 3 * DAY) / 499),
      profit: 1,
      volume: 0.1,
    }));
    const dto = assemble({ start: 0, end: 10 * DAY, firstDataAt: 6 * DAY, trades });
    // counted from the window start these would fall into ~120 buckets, from the first data into ~300
    expect(dto.ledger.length).toBeGreaterThan(280);
    expect(dto.ledger.reduce((sum, point) => sum + point.count, 0)).toBe(500);
  });

  test("account joins are counted apart from deposits and withdrawals", () => {
    const dto = assemble({
      snapshots: [snap(1_500, 1_000, 1_000), snap(4_000, 3_100, 3_100)],
      cashFlows: [
        { t: 2_000, amount: 100 },
        { t: 3_000, amount: 2_000, kind: "JOIN" },
        { t: 3_500, amount: -50 },
      ],
      cashFlowsSupported: true,
    });
    expect(dto.coverage).toMatchObject({ cashFlowCount: 2, accountJoinCount: 1, cashFlowsSupported: true });
    expect(dto.cashFlows?.map((flow) => flow.kind ?? "FLOW")).toEqual(["FLOW", "JOIN", "FLOW"]);
  });

  test("emptyPerformanceDto spans the range and has nothing in it", () => {
    const dto = emptyPerformanceDto({
      accountId: "ALL",
      currency: null,
      range: "1W",
      now: NOW,
      aggregate: true,
      mixedCurrencies: true,
      marginSupported: true,
    });
    expect(dto.start).toBe(NOW - 7 * DAY);
    expect(dto.end).toBe(NOW);
    expect(dto.samples).toEqual([]);
    expect(dto.coverage).toMatchObject({ aggregate: true, mixedCurrencies: true, closedTrades: 0 });
  });
});

describe("combined curve: money that moves the sum", () => {
  test("an account connected after the curve began is money that arrived, not performance", () => {
    const joins = accountJoinFlows(
      [
        { t: 1_000, balance: 5_000 }, // there when the curve began: part of its first reading
        { t: 4_000, balance: 2_000 },
        { t: 3_000, balance: 750 },
      ],
      1_000,
    );
    expect(joins).toEqual([
      { t: 3_000, amount: 750, kind: "JOIN" },
      { t: 4_000, amount: 2_000, kind: "JOIN" },
    ]);
  });

  test("an account that connected with nothing on it brings nothing", () => {
    expect(
      accountJoinFlows(
        [
          { t: 4_000, balance: 0 },
          { t: 5_000, balance: -3 },
        ],
        1_000,
      ),
    ).toEqual([]);
  });

  test("a deposit counts only from the moment its account was connected", () => {
    const flows = flowsAfterAccountJoined(
      [
        { t: 500, amount: 100, accountId: "a" }, // before it was connected: already inside its first reading
        { t: 2_000, amount: 100, accountId: "a" },
        { t: 2_500, amount: -40, accountId: "b" }, // b is connected at 2 600
        { t: 2_700, amount: -40, accountId: "b" },
        { t: 3_000, amount: 10 }, // no account: can not be placed
        { t: 3_500, amount: 10, accountId: "ghost" }, // an account without any reading
      ],
      new Map([
        ["a", 1_000],
        ["b", 2_600],
      ]),
    );
    expect(flows).toEqual([
      { t: 2_000, amount: 100 },
      { t: 2_700, amount: -40 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPerformanceSeries against the fake database
// ─────────────────────────────────────────────────────────────────────────────

describe("getPerformanceSeries - one account", () => {
  // 3 days of one snapshot per minute = 4320 rows, far more than one response can hold.
  const FIRST = NOW - 3 * DAY;
  const COUNT = 3 * 24 * 60;
  const history = (offset = 0) =>
    snapshots("acc-1", FIRST + offset, COUNT, MINUTE, (index) => ({
      balance: 1_000,
      equity: 1_000 + (100 * index) / (COUNT - 1),
    }));
  const lastSnapshotAt = FIRST + (COUNT - 1) * MINUTE;

  test("the whole history is sampled, not just the newest 1000 rows (the bug behind the flat chart)", async () => {
    const { db, service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: history() });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    const first = dto.samples[0];
    const last = dto.samples[dto.samples.length - 1];
    expect(first.t).toBe(FIRST);
    expect(last.t).toBe(lastSnapshotAt);
    expect(last.equity).toBeCloseTo(1_100, 6);
    // the newest 1000 rows would only reach back ~16.7 hours
    expect(last.t - first.t).toBeGreaterThan(2 * DAY + 20 * HOUR);

    // 240 evenly spaced look-ups over three days: one sample about every 18 minutes
    expect(dto.samples.length).toBeGreaterThanOrEqual(235);
    expect(dto.samples.length).toBeLessThanOrEqual(245);
    expect(dto.samples.every((sample) => !sample.estimated)).toBe(true);
    const gaps = dto.samples.slice(1).map((sample, index) => sample.t - dto.samples[index].t);
    expect(Math.max(...gaps)).toBeLessThan(25 * MINUTE);
    expect(Math.min(...gaps)).toBeGreaterThan(10 * MINUTE);

    expect(dto).toMatchObject({ start: FIRST, end: NOW, generatedAt: NOW });
    expect(dto.coverage).toMatchObject({
      firstSnapshotAt: FIRST,
      lastSnapshotAt,
      firstDataAt: FIRST,
      lastDataAt: lastSnapshotAt,
      stale: false,
      gapCount: 0,
      estimatedSamples: 0,
      equityPeak: 1_200,
      aggregate: false,
    });
    expect(dto.coverage.snapshotSamples).toBe(dto.samples.length);

    // migration 058 is tried first; without it: a bounded number of cheap indexed look-ups, not a scan
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(["account_snapshot_samples"]);
    expect(db.queries("account_snapshots", (entry) => entry.filters.includes("lte:captured_at"))).toHaveLength(240);
    expect(db.queries("account_snapshots").length).toBeLessThanOrEqual(250);
  });

  test("the derived curve shows the real growth over the whole period", async () => {
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: history() });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });
    const derived = deriveSeries(dto);

    expect(derived.base).toBe(1_000);
    expect(derived.equityGrowthPct).toBeCloseTo(10, 4);
    expect(derived.maxDrawdownPct).toBe(0);
    expect(derived.points.length).toBe(dto.samples.length);
  });

  test("a fixed range keeps only its window, anchored by the value valid when it opened", async () => {
    // snapshots sit 30 s off the minute grid, so none falls exactly on the window start
    const rows = history(30_000);
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: rows });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "1D", now: NOW, ...asTrader });

    expect(dto.start).toBe(NOW - DAY);
    expect(dto.end).toBe(NOW);
    expect(dto.samples[0]).toMatchObject({ t: NOW - DAY, estimated: false });
    expect(dto.samples.every((sample) => sample.t >= NOW - DAY && sample.t <= NOW)).toBe(true);
    expect(dto.samples.length).toBeGreaterThanOrEqual(100);
    // the anchor carries the equity of the last snapshot taken before the window opened
    const before = rows.filter((row) => Date.parse(row.captured_at as string) < NOW - DAY);
    expect(dto.samples[0].equity).toBe(before[before.length - 1].equity);
    expect(dto.samples[1].t).toBeGreaterThan(NOW - DAY);
  });

  test("a stopped worker ends the window at the last recorded data: no empty tail, nothing invented after it", async () => {
    const stopped = snapshots("acc-1", NOW - 2 * DAY, 600, MINUTE, (index) => ({
      balance: 1_000,
      equity: 1_000 + index / 10,
    }));
    const lastAt = NOW - 2 * DAY + 599 * MINUTE;
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: stopped });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.coverage).toMatchObject({ lastSnapshotAt: lastAt, lastDataAt: lastAt, stale: true });
    expect(dto.samples[dto.samples.length - 1].t).toBe(lastAt);
    expect(dto.samples.every((sample) => !sample.estimated)).toBe(true);
    expect(dto.start).toBe(NOW - 2 * DAY);
    expect(dto.end).toBe(lastAt);
    // the response is still stamped with the real time, so the page can say how long ago it stopped
    expect(dto.generatedAt).toBe(NOW);
    expect(dto.generatedAt - lastAt).toBeGreaterThan(30 * HOUR);
  });

  test("a snapshot a few minutes old still counts as live", async () => {
    const recent = snapshots("acc-1", NOW - 3 * HOUR, 170, MINUTE, () => ({ balance: 1_000, equity: 1_000 }));
    // last snapshot = NOW - 11 minutes
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: recent });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.coverage.stale).toBe(false);
    expect(dto.end).toBe(NOW);
  });

  test("a fixed range of a stale account is counted back from its last data, not from today", async () => {
    const minutes = 3 * 24 * 60;
    const rows = snapshots("acc-1", NOW - 8 * DAY, minutes, MINUTE, (index) => ({
      balance: 1_000,
      equity: 1_000 + index / 100,
    }));
    const lastAt = NOW - 8 * DAY + (minutes - 1) * MINUTE;
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: rows });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "1D", now: NOW, ...asTrader });

    // "1D" shows the last day the account has data for instead of an empty last day
    expect(dto.end).toBe(lastAt);
    expect(dto.start).toBe(lastAt - DAY);
    expect(dto.samples[0]).toMatchObject({ t: lastAt - DAY, estimated: false });
    expect(dto.samples[dto.samples.length - 1].t).toBe(lastAt);
    expect(dto.samples.every((sample) => sample.t >= dto.start && sample.t <= dto.end)).toBe(true);
    expect(dto.samples.length).toBeGreaterThan(200);
    expect(dto.coverage).toMatchObject({ stale: true, firstDataAt: NOW - 8 * DAY, lastDataAt: lastAt });
  });

  test("a short recording that stopped days ago keeps the chosen period, with its data at the right end", async () => {
    const stopped = snapshots("acc-1", NOW - 5 * DAY, 100, MINUTE, () => ({ balance: 1_000, equity: 1_000 }));
    const lastAt = NOW - 5 * DAY + 99 * MINUTE;
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: stopped });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "1D", now: NOW, ...asTrader });

    // "1D" is the last day up to the end of the recording; the hours before the first reading have no data
    expect(dto.start).toBe(lastAt - DAY);
    expect(dto.end).toBe(lastAt);
    expect(dto.samples[0].t).toBe(NOW - 5 * DAY);
    expect(dto.samples.length).toBeGreaterThan(50);
    expect(dto.coverage).toMatchObject({ stale: true, firstDataAt: NOW - 5 * DAY, lastSnapshotAt: lastAt });
  });

  test.each([
    ["1M", 30],
    ["3M", 90],
    ["6M", 182],
    ["1Y", 365],
  ] as const)("%s on a three-day-old account spans %i days; the data sits at its right end", async (range, days) => {
    const first = NOW - 3 * DAY;
    const rows = snapshots("acc-1", first, 3 * 24 * 60, MINUTE, (index) => ({
      balance: 1_000,
      equity: 1_000 + index / 100,
    }));
    const { db, service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: rows },
      { snapshotSamples: true },
    );
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range, now: NOW, ...asTrader });

    // the axis is the period that was chosen (the same account must not look alike in 1M, 3M, 6M and 1Y)...
    expect(dto.start).toBe(NOW - days * DAY);
    expect(dto.end).toBe(NOW);
    // ...the curve is only the stretch that has data: nothing is read, drawn or invented before it
    expect(dto.samples[0].t).toBe(first);
    expect(dto.samples.every((sample) => sample.t >= first && !sample.estimated)).toBe(true);
    expect(dto.coverage.firstDataAt).toBe(first);
    expect(db.rpcCalls[0].args.p_start).toBe(new Date(first).toISOString());

    const derived = deriveSeries(dto);
    expect(derived.historyStart).toBe(first);
    expect(derived.pnl[0].t).toBe(first);
  });

  test("a window wider than a trade-only history starts the rebuilt curve at its first trade", async () => {
    const trades = [
      { id: "t1", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - 20 * DAY).toISOString(), profit: 10, volume: 0.1 },
      { id: "t2", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - 10 * DAY).toISOString(), profit: -5, volume: 0.1 },
      { id: "t3", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - MINUTE).toISOString(), profit: 20, volume: 0.2 },
    ];
    const { service } = await setup({ trading_accounts: [account("acc-1", { initial_balance: 500 })], trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "1Y", now: NOW, ...asTrader });

    expect(dto.start).toBe(NOW - 365 * DAY);
    expect(dto.end).toBe(NOW);
    expect(dto.samples.every((sample) => sample.estimated)).toBe(true);
    expect(dto.samples[0].t).toBe(NOW - 20 * DAY - 1);
    expect(dto.samples[dto.samples.length - 1]).toMatchObject({ t: NOW, balance: 525 });
    expect(dto.ledger.map((point) => point.t)).toEqual([NOW - 20 * DAY, NOW - 10 * DAY, NOW - MINUTE]);
  });

  test("a closed trade newer than the last snapshot is data too: it ends a stale window", async () => {
    const rows = snapshots("acc-1", NOW - 4 * DAY, 300, MINUTE, () => ({ balance: 1_000, equity: 1_000 }));
    const lastSnap = NOW - 4 * DAY + 299 * MINUTE;
    const tradeAt = NOW - 2 * DAY;
    const trades = [
      { id: "late", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(tradeAt).toISOString(), profit: 12, volume: 0.1 },
    ];
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: rows, trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.end).toBe(tradeAt);
    expect(dto.coverage).toMatchObject({ lastSnapshotAt: lastSnap, lastDataAt: tradeAt, stale: true, closedTrades: 1 });
    expect(dto.samples[dto.samples.length - 1].t).toBe(lastSnap);
    expect(dto.ledger).toEqual([{ t: tradeAt, profit: 12, volume: 0.1, count: 1, wins: 1 }]);
  });

  test("an account with no history at all returns an empty window", async () => {
    const { service } = await setup({ trading_accounts: [account("acc-1")] });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.samples).toEqual([]);
    expect(dto.stats.tradeCount).toBe(0);
    expect(dto.start).toBe(NOW - DAY);
    expect(dto.coverage).toMatchObject({ firstSnapshotAt: null, lastSnapshotAt: null, snapshotSamples: 0 });
  });
});

describe("getPerformanceSeries - sampling and migration 058", () => {
  const FIRST = NOW - 3 * DAY;
  const COUNT = 3 * 24 * 60;
  const history = () =>
    snapshots("acc-1", FIRST, COUNT, MINUTE, (index) => ({
      balance: 1_000,
      equity: 1_000 + (100 * index) / (COUNT - 1),
    }));
  const lastSnapshotAt = FIRST + (COUNT - 1) * MINUTE;
  const isProbe = (entry: QueryLogEntry) => entry.filters.includes("lte:captured_at");
  const samplesCalls = (db: FakeDb) => db.rpcCalls.filter((call) => call.fn === "account_snapshot_samples");

  test("with the function in place the history is read in ONE call with twice the detail", async () => {
    const { db, service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: history() },
      { snapshotSamples: true },
    );
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    const calls = samplesCalls(db);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      p_account_id: "acc-1",
      p_start: new Date(FIRST).toISOString(),
      p_end: new Date(NOW).toISOString(),
      p_points: 480,
    });
    expect(db.queries("account_snapshots", isProbe)).toHaveLength(0);

    expect(dto.samples.length).toBeGreaterThanOrEqual(470);
    expect(dto.samples.length).toBeLessThanOrEqual(481);
    expect(dto.samples[0].t).toBe(FIRST);
    expect(dto.samples[dto.samples.length - 1].t).toBe(lastSnapshotAt);
    expect(dto.samples.every((sample) => !sample.estimated)).toBe(true);
    expect(dto.coverage.gapCount).toBe(0);
  });

  test.each([
    ["half an hour", 30, 48],
    ["three hours", 180, 180],
    ["three days", 3 * 24 * 60, 480],
  ])("%s of data ask for about one sample per minute, between 48 and 480", async (_label, minutes, expected) => {
    const rows = snapshots("acc-1", NOW - minutes * MINUTE, minutes, MINUTE, () => ({ balance: 1_000, equity: 1_000 }));
    const { db, service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: rows },
      { snapshotSamples: true },
    );
    await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(samplesCalls(db)[0].args.p_points).toBe(expected);
  });

  test("the instants right before and after every closed trade are asked for, so the balance step is sharp", async () => {
    const tradeAt = NOW - 2 * DAY + 30_000;
    const trades = closedTrades("acc-1", tradeAt, 1, MINUTE, () => ({ profit: 25, volume: 0.1 }));
    const { db, service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: history(), trades },
      { snapshotSamples: true },
    );
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(samplesCalls(db)[0].args.p_extra).toEqual([
      new Date(tradeAt - 2_000).toISOString(),
      new Date(tradeAt + 90_000).toISOString(),
    ]);
    // the stored rows around the close are part of the curve (whole minutes before / after it)
    const times = new Set(dto.samples.map((sample) => sample.t));
    expect(times.has(NOW - 2 * DAY)).toBe(true);
    expect(times.has(NOW - 2 * DAY + 2 * MINUTE)).toBe(true);
  });

  test("without the function the same edges are looked up one by one", async () => {
    const tradeAt = NOW - 2 * DAY + 30_000;
    const trades = closedTrades("acc-1", tradeAt, 1, MINUTE, () => ({ profit: 25, volume: 0.1 }));
    const { db, service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: history(), trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    // 240 evenly spaced instants + the two trade edges
    expect(db.queries("account_snapshots", isProbe)).toHaveLength(242);
    const times = new Set(dto.samples.map((sample) => sample.t));
    expect(times.has(NOW - 2 * DAY)).toBe(true);
    expect(times.has(NOW - 2 * DAY + 2 * MINUTE)).toBe(true);
  });

  test("a missing function is remembered: later requests skip it", async () => {
    const { db, service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: history() });
    await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });
    await service.getPerformanceSeries({ accountId: "acc-1", range: "1W", now: NOW, ...asTrader });

    expect(samplesCalls(db)).toHaveLength(1);
  });

  test("a function that exists but fails (timeout) only costs the slower path and is tried again next time", async () => {
    const { db, service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: history() },
      { snapshotSamples: true, rpcError: { code: "57014", message: "canceling statement due to statement timeout" } },
    );
    const first = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(first.samples.length).toBeGreaterThanOrEqual(235);
    expect(db.queries("account_snapshots", isProbe)).toHaveLength(240);

    await service.getPerformanceSeries({ accountId: "acc-1", range: "1W", now: NOW, ...asTrader });
    expect(samplesCalls(db)).toHaveLength(2);
  });

  describe.each([
    ["one lookup per sample", false],
    ["migration 058", true],
  ])("a recording gap (%s)", (_name, snapshotSamples) => {
    // 6 h of one snapshot per minute, 20 h of silence with a closed trade in the middle, 6 h again until now
    const aStart = NOW - 32 * HOUR;
    const bStart = NOW - 6 * HOUR;
    const lastA = aStart + 359 * MINUTE;
    const tradeAt = NOW - 12 * HOUR;
    const rows = () => [
      ...snapshots("acc-1", aStart, 360, MINUTE, () => ({ balance: 1_000, equity: 1_005 }), "a"),
      ...snapshots("acc-1", bStart, 360, MINUTE, () => ({ balance: 1_040, equity: 1_045 }), "b"),
    ];
    const trade = () => closedTrades("acc-1", tradeAt, 1, MINUTE, () => ({ profit: 40, volume: 0.1 }));

    test("is bridged with flagged estimates that follow the closed trade", async () => {
      const { service } = await setup(
        { trading_accounts: [account("acc-1")], account_snapshots: rows(), trades: trade() },
        { snapshotSamples },
      );
      const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

      expect(dto.coverage).toMatchObject({ gapCount: 1, estimatedSamples: 3, stale: false, closedTrades: 1 });
      const recorded = dto.samples.filter((sample) => !sample.estimated);
      const estimated = dto.samples.filter((sample) => sample.estimated);

      // the last recorded sample before the silence and the first one after it bound the estimates
      expect(recorded.some((sample) => sample.t === lastA)).toBe(true);
      const afterGap = recorded.find((sample) => sample.t > lastA);
      expect(afterGap).toBeDefined();
      expect(afterGap!.t).toBeGreaterThanOrEqual(bStart);
      expect(afterGap!.t).toBeLessThanOrEqual(bStart + 9 * MINUTE);
      expect(estimated.every((sample) => sample.t > lastA && sample.t < afterGap!.t)).toBe(true);

      expect(estimated.map((sample) => [sample.t, sample.balance, sample.equity])).toEqual([
        [lastA + 1, 1_000, 1_005],
        [tradeAt - 1, 1_000, 1_005],
        [tradeAt, 1_040, 1_045],
      ]);
    });

    test("is not invented when nothing is missing", async () => {
      const continuous = snapshots("acc-1", NOW - 3 * HOUR, 179, MINUTE, () => ({ balance: 1_000, equity: 1_005 }));
      const { service } = await setup(
        { trading_accounts: [account("acc-1")], account_snapshots: continuous },
        { snapshotSamples },
      );
      const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

      expect(dto.coverage).toMatchObject({ gapCount: 0, estimatedSamples: 0 });
    });
  });
});

describe("getPerformanceSeries - closed trades", () => {
  test("every closed trade is read, page by page, past the 1000-row cap", async () => {
    const trades = closedTrades("acc-1", NOW - 3 * DAY, 2_500, MINUTE, (index) => ({
      profit: index % 2 === 0 ? 1 : -0.5,
      volume: 0.01,
    }));
    const { db, service } = await setup({ trading_accounts: [account("acc-1")], trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.stats.tradeCount).toBe(2_500);
    expect(dto.stats.totalProfit).toBeCloseTo(1_250 * 1 - 1_250 * 0.5, 6);
    expect(dto.coverage).toMatchObject({ closedTrades: 2_500, tradesTruncated: false });
    expect(db.queries("trades", (entry) => entry.range !== null)).toHaveLength(4);
  });

  test("a lower server cap only means more pages", async () => {
    const trades = closedTrades("acc-1", NOW - DAY, 1_200, MINUTE / 2, () => ({ profit: 1, volume: 0.1 }));
    const { service } = await setup({ trading_accounts: [account("acc-1")], trades }, { maxRows: 500 });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.stats.tradeCount).toBe(1_200);
    expect(dto.stats.totalProfit).toBe(1_200);
  });

  test("without snapshots the curve is rebuilt from the trades and every sample is flagged estimated", async () => {
    const trades = [
      { id: "t1", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - 3 * DAY).toISOString(), profit: 10, volume: 0.1 },
      { id: "t2", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - 2 * DAY).toISOString(), profit: -5, volume: 0.1 },
      { id: "t3", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - DAY).toISOString(), profit: 20, volume: 0.2 },
    ];
    const { service } = await setup({ trading_accounts: [account("acc-1", { initial_balance: 500 })], trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.samples.length).toBeGreaterThan(0);
    expect(dto.samples.every((sample) => sample.estimated)).toBe(true);
    // trades are the only data, so the window ends at the last close instead of running on to "now"
    expect(dto.start).toBe(NOW - 3 * DAY);
    expect(dto.end).toBe(NOW - DAY);
    expect(dto.samples[dto.samples.length - 1]).toMatchObject({ t: NOW - DAY, balance: 525 });
    expect(dto.coverage).toMatchObject({ snapshotSamples: 0, closedTrades: 3, stale: true, lastDataAt: NOW - DAY });
    expect(dto.stats.totalProfit).toBe(25);
  });

  test("a trade-only account that closed a trade a minute ago is live: the window runs to now", async () => {
    const trades = [
      { id: "t1", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - 2 * DAY).toISOString(), profit: 10, volume: 0.1 },
      { id: "t2", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - MINUTE).toISOString(), profit: 5, volume: 0.1 },
    ];
    const { service } = await setup({ trading_accounts: [account("acc-1", { initial_balance: 500 })], trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.coverage.stale).toBe(false);
    expect(dto.end).toBe(NOW);
    expect(dto.samples[dto.samples.length - 1]).toMatchObject({ t: NOW, balance: 515, estimated: true });
  });

  test("placeholder dates, instants in the future and lot-size-0 balance rows never shape the chart", async () => {
    const snaps = snapshots("acc-1", NOW - 6 * HOUR, 6 * 60, MINUTE, () => ({ balance: 1_000, equity: 1_000 }));
    const trade = (id: string, closedAt: string, extra: Row = {}) => ({
      id,
      trading_account_id: "acc-1",
      status: "CLOSED",
      closed_at: closedAt,
      profit: 10,
      volume: 0.1,
      ...extra,
    });
    const trades = [
      trade("real", new Date(NOW - 2 * HOUR).toISOString()),
      // "no close time" placeholders some bridges send: they used to pull the window back to year 1
      trade("epoch-zero", "1970-01-01T00:00:00.000Z"),
      trade("year-one", "0001-01-01T00:00:00.000Z"),
      // server time read as UTC puts a fresh close hours ahead of the real clock
      trade("future", new Date(NOW + 3 * HOUR).toISOString()),
      // a deposit stored as a "trade": no lot size
      trade("deposit", new Date(NOW - 5 * HOUR).toISOString(), { profit: 5_000, volume: 0 }),
    ];
    const { service } = await setup({ trading_accounts: [account("acc-1")], account_snapshots: snaps, trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.stats.tradeCount).toBe(1);
    expect(dto.stats.totalProfit).toBe(10);
    expect(dto.ledger).toEqual([{ t: NOW - 2 * HOUR, profit: 10, volume: 0.1, count: 1, wins: 1 }]);
    // the window is the recorded span, not 2000 years wide and not running into the future
    expect(dto.start).toBe(NOW - 6 * HOUR);
    expect(dto.end).toBe(NOW);
    expect(dto.coverage).toMatchObject({ firstDataAt: NOW - 6 * HOUR, closedTrades: 1 });
    expect(dto.coverage.lastDataAt!).toBeLessThanOrEqual(NOW);
  });

  test("open and null-dated trades are not read", async () => {
    const trades = [
      { id: "open", trading_account_id: "acc-1", status: "OPEN", closed_at: null, profit: 500, volume: 1 },
      { id: "odd", trading_account_id: "acc-1", status: "CLOSED", closed_at: null, profit: 500, volume: 1 },
      { id: "done", trading_account_id: "acc-1", status: "CLOSED", closed_at: new Date(NOW - HOUR).toISOString(), profit: 7, volume: 1 },
    ];
    const { service } = await setup({ trading_accounts: [account("acc-1")], trades });
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.stats.tradeCount).toBe(1);
    expect(dto.stats.totalProfit).toBe(7);
  });
});

describe("getPerformanceSeries - margin", () => {
  const rows = (withMargin: boolean) =>
    snapshots("acc-1", NOW - 2 * HOUR, 120, MINUTE, (index) => ({
      balance: 1_000,
      equity: 1_000 + index,
      ...(withMargin ? { margin: "250.00", free_margin: 750 + index, margin_level: 400 } : {}),
    }));

  test("without migration 057 the chart still works and says margin is not stored", async () => {
    const { service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: rows(false) },
      { marginColumns: false },
    );
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.samples.length).toBeGreaterThan(50);
    expect(dto.coverage).toMatchObject({ marginSupported: false, marginCaptured: false });
    expect(dto.samples.every((sample) => sample.margin === null && sample.freeMargin === null)).toBe(true);
  });

  test("with the columns present margin is returned as numbers", async () => {
    const { service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: rows(true) },
      { marginColumns: true },
    );
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.coverage).toMatchObject({ marginSupported: true, marginCaptured: true });
    const last = dto.samples[dto.samples.length - 1];
    expect(last).toMatchObject({ margin: 250, marginLevel: 400 });
    expect(last.freeMargin).toBe(750 + 119);
  });

  test("columns exist but nothing was stored yet: supported, not captured", async () => {
    const { service } = await setup(
      { trading_accounts: [account("acc-1")], account_snapshots: rows(false) },
      { marginColumns: true },
    );
    const dto = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });

    expect(dto.coverage).toMatchObject({ marginSupported: true, marginCaptured: false });
  });
});

describe("getPerformanceSeries - access", () => {
  test("a trader cannot read somebody else's account", async () => {
    const { service, AnalyticsAccessError } = await setup({
      trading_accounts: [account("acc-2", { user_id: "user-2" })],
    });
    await expect(
      service.getPerformanceSeries({ accountId: "acc-2", range: "ALL", now: NOW, ...asTrader }),
    ).rejects.toBeInstanceOf(AnalyticsAccessError);
  });

  test("an unknown account is rejected the same way", async () => {
    const { service, AnalyticsAccessError } = await setup({ trading_accounts: [account("acc-1")] });
    await expect(
      service.getPerformanceSeries({ accountId: "nope", range: "ALL", now: NOW, ...asTrader }),
    ).rejects.toBeInstanceOf(AnalyticsAccessError);
  });

  test("an admin can read any account", async () => {
    const { service } = await setup({
      trading_accounts: [account("acc-2", { user_id: "user-2" })],
      account_snapshots: snapshots("acc-2", NOW - HOUR, 30, MINUTE, () => ({ balance: 10, equity: 10 })),
    });
    const dto = await service.getPerformanceSeries({ accountId: "acc-2", range: "ALL", now: NOW, ...asAdmin });
    expect(dto.accountId).toBe("acc-2");
    expect(dto.samples.length).toBeGreaterThan(1);
  });
});

describe("getPerformanceSeries - combined curve (ALL)", () => {
  const timeline = (start: number) => [
    { captured_at: new Date(start - 30 * MINUTE).toISOString(), balance: "1", equity: "1" },
    { captured_at: new Date(start + 30 * MINUTE).toISOString(), balance: "3000.5", equity: "3010.25" },
    { captured_at: new Date(start + 90 * MINUTE).toISOString(), balance: "3100", equity: "3200" },
    { captured_at: new Date(NOW).toISOString(), balance: "3100", equity: "3300" },
  ];
  const accounts = [
    account("acc-1"),
    account("acc-2"),
    account("acc-3", { status: "DISCONNECTED" }),
    account("acc-4", { user_id: "user-9" }),
  ];
  const firstSnapshots = [
    ...snapshots("acc-1", NOW - 10 * DAY, 5, MINUTE, () => ({ balance: 1_000, equity: 1_000 })),
    ...snapshots("acc-2", NOW - 5 * DAY, 5, MINUTE, () => ({ balance: 2_000, equity: 2_000 })),
    // both accounts are still recorded: their newest snapshots are a minute old
    ...snapshots("acc-1", NOW - MINUTE, 1, MINUTE, () => ({ balance: 1_100, equity: 1_200 }), "live"),
    ...snapshots("acc-2", NOW - MINUTE, 1, MINUTE, () => ({ balance: 2_000, equity: 2_100 }), "live"),
  ];

  test("an admin gets one curve over all connected accounts, from the day the oldest account has data", async () => {
    // acc-1 has been recorded for 10 days, acc-2 for 5: the curve is 10 days long, not 5
    const start = NOW - 10 * DAY;
    const { db, service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots },
      { timeline: timeline(start) },
    );
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asAdmin });

    // the finer curve of migration 058 is tried first, the hourly one answers when it is missing
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(["platform_equity_samples", "platform_equity_timeline"]);
    const hourly = db.rpcCalls[1];
    expect([...(hourly.args.p_account_ids as string[])].sort()).toEqual(["acc-1", "acc-2", "acc-4"]);
    expect(hourly.args.p_start).toBe(new Date(start).toISOString());

    expect(dto.accountId).toBe("ALL");
    expect(dto.start).toBe(start);
    expect(dto.end).toBe(NOW);
    expect(dto.samples.map((sample) => sample.equity)).toEqual([3_010.25, 3_200, 3_300]);
    expect(dto.coverage).toMatchObject({
      aggregate: true,
      // ten days fit into what the hourly query returns: nothing is cut
      aggregateLimitedToDays: null,
      firstSnapshotAt: start,
      lastSnapshotAt: NOW - MINUTE,
      firstDataAt: start,
      lastDataAt: NOW - MINUTE,
      stale: false,
      mixedCurrencies: false,
    });
  });

  test("with migration 058 the combined curve is read evenly spaced and the hourly one is not needed", async () => {
    const oldest = NOW - 10 * DAY;
    const aggregateSamples = [
      { captured_at: new Date(oldest).toISOString(), balance: "1000", equity: "1000" },
      { captured_at: new Date(NOW - 5 * DAY).toISOString(), balance: "3050", equity: "3120.5" },
      { captured_at: new Date(NOW).toISOString(), balance: "3100", equity: "3300" },
    ];
    const { db, service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots },
      { aggregateSamples },
    );
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asAdmin });

    expect(db.rpcCalls.map((call) => call.fn)).toEqual(["platform_equity_samples"]);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_start: new Date(oldest).toISOString(),
      p_end: new Date(NOW).toISOString(),
      p_points: 480,
    });
    expect(dto.samples.map((sample) => sample.equity)).toEqual([1_000, 3_120.5, 3_300]);
    expect(dto.samples[0].t).toBe(oldest);
    expect(dto.coverage.aggregateLimitedToDays).toBeNull();
  });

  test("a fixed range spans the period that was chosen, the combined curve only the days with data", async () => {
    const oldest = NOW - 10 * DAY;
    const aggregateSamples = [
      { captured_at: new Date(oldest).toISOString(), balance: "1000", equity: "1000" },
      { captured_at: new Date(NOW).toISOString(), balance: "1100", equity: "1200" },
    ];
    const { db, service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots },
      { aggregateSamples },
    );
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "6M", now: NOW, ...asAdmin });

    expect(dto.start).toBe(NOW - 182 * DAY);
    expect(dto.end).toBe(NOW);
    expect(db.rpcCalls[0].args.p_start).toBe(new Date(oldest).toISOString());
    expect(dto.samples[0].t).toBe(oldest);
    expect(dto.coverage.firstDataAt).toBe(oldest);
  });

  test("an account connected after the curve began joins as money that arrived, not as performance", async () => {
    const oldest = NOW - 10 * DAY;
    const aggregateSamples = [
      { captured_at: new Date(oldest).toISOString(), balance: "1000", equity: "1000" },
      // acc-2 (2000 on its first reading) was connected here: the sum steps up
      { captured_at: new Date(NOW - 5 * DAY).toISOString(), balance: "3000", equity: "3000" },
      { captured_at: new Date(NOW).toISOString(), balance: "3100", equity: "3300" },
    ];
    const { service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots },
      { aggregateSamples },
    );
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asAdmin });

    expect(dto.cashFlows).toEqual([{ t: NOW - 5 * DAY, amount: 2_000, kind: "JOIN" }]);
    expect(dto.coverage).toMatchObject({ accountJoinCount: 1, cashFlowCount: 0 });

    const derived = deriveSeries(dto);
    expect(derived.joinedAccounts).toBe(1);
    expect(derived.joinedAmount).toBe(2_000);
    // the step from 1000 to 3000 is the new account's money; the growth is the +10 % of the last stretch only
    expect(derived.equityGrowthPct).toBeCloseTo(10, 6);
    expect(derived.pnlBase).toBe(3_000);
  });

  test("a deposit counts in the combined curve only after its account was connected", async () => {
    const oldest = NOW - 10 * DAY;
    const aggregateSamples = [
      { captured_at: new Date(oldest).toISOString(), balance: "1000", equity: "1000" },
      { captured_at: new Date(NOW - 5 * DAY).toISOString(), balance: "3000", equity: "3000" },
      { captured_at: new Date(NOW).toISOString(), balance: "3600", equity: "3600" },
    ];
    const cashFlowRows = [
      // acc-2 deposits 500 two days before it is connected: that money is inside its first reading
      { id: "cf-1", trading_account_id: "acc-2", amount: 500, occurred_at: new Date(NOW - 7 * DAY).toISOString() },
      // and 600 two days after: that one moved the sum
      { id: "cf-2", trading_account_id: "acc-2", amount: 600, occurred_at: new Date(NOW - 3 * DAY).toISOString() },
    ];
    const { service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots, account_cash_flows: cashFlowRows },
      { aggregateSamples },
    );
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asAdmin });

    expect(dto.cashFlows).toEqual([
      { t: NOW - 5 * DAY, amount: 2_000, kind: "JOIN" },
      { t: NOW - 3 * DAY, amount: 600 },
    ]);
    expect(dto.coverage).toMatchObject({ accountJoinCount: 1, cashFlowCount: 1 });
  });

  test("without migration 058 a long history is cut to the 40 days one hourly query returns - and says so", async () => {
    const long = [
      ...snapshots("acc-1", NOW - 100 * DAY, 5, MINUTE, () => ({ balance: 1_000, equity: 1_000 })),
      ...snapshots("acc-2", NOW - 100 * DAY, 5, MINUTE, () => ({ balance: 2_000, equity: 2_000 })),
      ...snapshots("acc-1", NOW - MINUTE, 1, MINUTE, () => ({ balance: 1_100, equity: 1_200 }), "live"),
      ...snapshots("acc-2", NOW - MINUTE, 1, MINUTE, () => ({ balance: 2_000, equity: 2_100 }), "live"),
    ];
    const cutAt = NOW - 40 * DAY;
    const hourlyRows = [
      { captured_at: new Date(cutAt).toISOString(), balance: "3000", equity: "3000" },
      { captured_at: new Date(cutAt + DAY).toISOString(), balance: "3000", equity: "3030" },
      { captured_at: new Date(NOW).toISOString(), balance: "3100", equity: "3300" },
    ];
    const { db, service } = await setup(
      { trading_accounts: accounts, account_snapshots: long },
      { timeline: hourlyRows },
    );
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asAdmin });

    // the window is the whole history, the curve covers the last 40 days of it
    expect(dto.start).toBe(NOW - 100 * DAY);
    expect(db.rpcCalls[1].args.p_start).toBe(new Date(cutAt).toISOString());
    expect(dto.coverage).toMatchObject({ aggregateLimitedToDays: 40, firstDataAt: cutAt });
    expect(dto.samples[0].t).toBe(cutAt);
  });

  test("a missing function is remembered: the next request goes straight to the hourly curve", async () => {
    const { db, service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots },
      { timeline: timeline(NOW - 5 * DAY) },
    );
    await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asAdmin });
    await service.getPerformanceSeries({ accountId: "ALL", range: "1W", now: NOW, ...asAdmin });

    expect(db.rpcCalls.filter((call) => call.fn === "platform_equity_samples")).toHaveLength(1);
    expect(db.rpcCalls.filter((call) => call.fn === "platform_equity_timeline")).toHaveLength(2);
  });

  test("when every account went quiet the window ends at the last data and the hourly rows after it are dropped", async () => {
    const quietAt = NOW - 3 * DAY;
    const quiet = [
      ...snapshots("acc-1", NOW - 6 * DAY, 5, MINUTE, () => ({ balance: 1_000, equity: 1_000 })),
      ...snapshots("acc-2", NOW - 6 * DAY, 5, MINUTE, () => ({ balance: 2_000, equity: 2_000 })),
      ...snapshots("acc-1", quietAt, 1, MINUTE, () => ({ balance: 1_000, equity: 1_010 }), "late"),
      ...snapshots("acc-2", quietAt, 1, MINUTE, () => ({ balance: 2_000, equity: 2_020 }), "late"),
    ];
    // the hourly function keeps repeating the last known value up to the present
    const hourly = Array.from({ length: 6 * 24 + 1 }, (_, index) => ({
      captured_at: new Date(NOW - 6 * DAY + index * HOUR).toISOString(),
      balance: "3000",
      equity: index <= 3 * 24 ? "3000" : "3030",
    }));
    const { service } = await setup({ trading_accounts: accounts, account_snapshots: quiet }, { timeline: hourly });
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asAdmin });

    expect(dto).toMatchObject({ start: NOW - 6 * DAY, end: quietAt, generatedAt: NOW });
    expect(dto.coverage).toMatchObject({ stale: true, lastDataAt: quietAt, firstDataAt: NOW - 6 * DAY });
    expect(dto.samples.length).toBeGreaterThan(50);
    expect(dto.samples.every((sample) => sample.t >= dto.start && sample.t <= quietAt)).toBe(true);
    expect(dto.samples.every((sample) => sample.equity === 3_000)).toBe(true);
  });

  test("a trader only gets the accounts that belong to them", async () => {
    const start = NOW - 5 * DAY;
    const { db, service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots },
      { timeline: timeline(start) },
    );
    await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asTrader });

    expect([...(db.rpcCalls[0].args.p_account_ids as string[])].sort()).toEqual(["acc-1", "acc-2"]);
  });

  test("accounts in different currencies are not added together", async () => {
    const { db, service } = await setup({
      trading_accounts: [account("acc-1"), account("acc-2", { currency: "EUR" })],
      account_snapshots: firstSnapshots,
    });
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asTrader });

    expect(dto.samples).toEqual([]);
    expect(dto.currency).toBeNull();
    expect(dto.coverage.mixedCurrencies).toBe(true);
    expect(db.rpcCalls).toHaveLength(0);
  });

  test("no connected account gives an empty window", async () => {
    const { service } = await setup({ trading_accounts: [account("acc-3", { status: "DISCONNECTED" })] });
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "ALL", now: NOW, ...asTrader });

    expect(dto.samples).toEqual([]);
    expect(dto.coverage.aggregate).toBe(true);
  });

  test("a short range is not reported as limited", async () => {
    const { service } = await setup(
      { trading_accounts: accounts, account_snapshots: firstSnapshots },
      { timeline: timeline(NOW - 5 * DAY) },
    );
    const dto = await service.getPerformanceSeries({ accountId: "ALL", range: "1W", now: NOW, ...asAdmin });
    expect(dto.coverage.aggregateLimitedToDays).toBeNull();
  });
});

describe("getPerformanceSeries - cache", () => {
  test("a second request within 15 seconds is answered without touching the database", async () => {
    const { db, service } = await setup({
      trading_accounts: [account("acc-1")],
      account_snapshots: snapshots("acc-1", NOW - HOUR, 30, MINUTE, () => ({ balance: 10, equity: 10 })),
    });
    const params = { accountId: "acc-1", range: "ALL" as const, ...asTrader };
    const first = await service.getPerformanceSeries({ ...params, now: NOW });
    const queriesAfterFirst = db.log.length;

    const second = await service.getPerformanceSeries({ ...params, now: NOW + 10_000 });
    expect(second).toBe(first);
    expect(db.log.length).toBe(queriesAfterFirst);

    const third = await service.getPerformanceSeries({ ...params, now: NOW + 16_000 });
    expect(third).not.toBe(first);
    expect(db.log.length).toBeGreaterThan(queriesAfterFirst);
  });

  test("different ranges and different users are cached separately", async () => {
    const { service } = await setup({
      trading_accounts: [account("acc-1")],
      account_snapshots: snapshots("acc-1", NOW - 2 * DAY, 200, MINUTE, () => ({ balance: 10, equity: 10 })),
    });
    const all = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asTrader });
    const day = await service.getPerformanceSeries({ accountId: "acc-1", range: "1D", now: NOW, ...asTrader });
    const admin = await service.getPerformanceSeries({ accountId: "acc-1", range: "ALL", now: NOW, ...asAdmin });

    expect(day).not.toBe(all);
    expect(admin).not.toBe(all);
  });
});
