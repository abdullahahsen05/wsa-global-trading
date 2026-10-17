import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cashFlowsForWindow,
  deriveSeries,
  dropGlitchSamples,
  fillSnapshotGaps,
  reconstructEstimatedSamples,
  summarizeTrades,
  type PerformanceCashFlow,
  type PerformanceSample,
  type PerformanceSeriesDto,
} from "@/lib/charts/performanceSeries";
import { assemblePerformanceDto } from "@/lib/services/performanceService";
import { extractCashFlows, orderNetProfit } from "@/lib/broker/orderNormalization";
import { IncompleteAccountSummaryError, readAccountFigures } from "@/lib/broker/accountFigures";
import { dedupeTradeRows, tradeRowChanged } from "@/lib/services/brokerSyncService";
import {
  loadCashFlows,
  recordCashFlows,
  resetCashFlowTableState,
} from "@/lib/services/accountCashFlowService";
import { recordAccountSnapshot, resetAccountSnapshotWriterState } from "@/lib/services/accountSnapshotService";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function sample(
  t: number,
  balance: number,
  equity: number,
  extra: Partial<PerformanceSample> = {},
): PerformanceSample {
  return { t, balance, equity, margin: null, freeMargin: null, marginLevel: null, estimated: false, ...extra };
}

function dtoWith(input: Partial<PerformanceSeriesDto> & Pick<PerformanceSeriesDto, "samples">): PerformanceSeriesDto {
  return {
    accountId: "acc-1",
    currency: "USD",
    range: "ALL",
    generatedAt: 5000,
    start: 1000,
    end: 5000,
    ledger: [],
    stats: summarizeTrades([]),
    coverage: {
      firstSnapshotAt: null,
      lastSnapshotAt: null,
      firstDataAt: null,
      lastDataAt: null,
      stale: false,
      snapshotSamples: input.samples.length,
      estimatedSamples: 0,
      gapCount: 0,
      closedTrades: 0,
      tradesTruncated: false,
      marginCaptured: false,
      marginSupported: true,
      mixedCurrencies: false,
      aggregate: false,
      aggregateLimitedToDays: null,
      equityPeak: null,
    },
    ...input,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker ingestion
// ─────────────────────────────────────────────────────────────────────────────

describe("orderNetProfit", () => {
  test("is profit plus commission, swap and fee (charges are negative)", () => {
    expect(orderNetProfit({ profit: 100, commission: -3.5, swap: -1.25, fee: -0.25 })).toBe(95);
  });

  test("accepts numeric text and ignores anything that is not a number", () => {
    expect(orderNetProfit({ profit: "12.5", commission: "-0.5" })).toBe(12);
    expect(orderNetProfit({ profit: Number.NaN, swap: 2, fee: "abc" })).toBe(2);
    expect(orderNetProfit({})).toBe(0);
  });
});

describe("extractCashFlows", () => {
  const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  test("finds deposits and withdrawals only, with a stable id", () => {
    const flows = extractCashFlows(
      [
        { ticket: 11, type: "Balance", profit: 1000, closeTimestampUTC: seconds("2026-09-01T10:00:00Z"), comment: "Deposit" },
        { ticket: 12, type: "Balance", profit: -250.456, closeTimestampUTC: seconds("2026-09-20T10:00:00Z") },
        { ticket: 13, type: "Buy", profit: 40, closeTimestampUTC: seconds("2026-09-21T10:00:00Z") },
        { ticket: 14, type: "Credit", profit: 100, closeTimestampUTC: seconds("2026-09-22T10:00:00Z") },
        { ticket: 15, type: "Balance", profit: 0, closeTimestampUTC: seconds("2026-09-23T10:00:00Z") },
      ],
      { now: NOW },
    );
    expect(flows.map((flow) => [flow.externalId, flow.amount, flow.kind])).toEqual([
      ["bal-11", 1000, "DEPOSIT"],
      ["bal-12", -250.46, "WITHDRAWAL"],
    ]);
    expect(flows[0].t).toBe(Date.parse("2026-09-01T10:00:00Z"));
    expect(flows[0].comment).toBe("Deposit");
  });

  test("reads the same operation twice as one, sorted by time", () => {
    const row = { ticket: 7, orderType: "Balance", profit: 500, closeTimestampUTC: seconds("2026-09-05T08:00:00Z") };
    const earlier = { ticket: 6, dealType: "DEAL_TYPE_BALANCE", profit: 100, closeTimestampUTC: seconds("2026-09-01T08:00:00Z") };
    const flows = extractCashFlows([row, earlier, { ...row }], { now: NOW });
    expect(flows.map((flow) => flow.externalId)).toEqual(["bal-6", "bal-7"]);
  });

  test("a row without a ticket gets an id from its time and amount; future and placeholder times are dropped", () => {
    const flows = extractCashFlows(
      [
        { type: "Balance", profit: 300, closeTimestampUTC: seconds("2026-09-05T08:00:00Z") },
        { ticket: 9, type: "Balance", profit: 300, closeTimestampUTC: seconds("2027-09-05T08:00:00Z") },
        { ticket: 10, type: "Balance", profit: 300, closeTimestampUTC: 0 },
      ],
      { now: NOW },
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].externalId).toBe(`bal-${Date.parse("2026-09-05T08:00:00Z")}-300`);
  });
});

describe("readAccountFigures", () => {
  test("a complete summary is read as it is", () => {
    expect(readAccountFigures({ balance: 1000, equity: 1020.5 })).toEqual({
      balance: 1000,
      equity: 1020.5,
      floating: null,
    });
  });

  test("a missing equity is balance + credit + floating P&L, or the balance", () => {
    expect(readAccountFigures({ balance: "1000", profit: "-20", credit: 5 })).toEqual({
      balance: 1000,
      equity: 985,
      floating: -20,
    });
    expect(readAccountFigures({ balance: 1000 }).equity).toBe(1000);
  });

  test("a half-loaded answer is an error, never a snapshot", () => {
    expect(() => readAccountFigures({ equity: 900 })).toThrow(IncompleteAccountSummaryError);
    expect(() => readAccountFigures({ balance: Number.NaN, equity: 900 })).toThrow(IncompleteAccountSummaryError);
    expect(() => readAccountFigures({ balance: 1000, equity: 0 })).toThrow(IncompleteAccountSummaryError);
  });

  test("an empty account (balance 0, equity 0) is a real reading", () => {
    expect(readAccountFigures({ balance: 0, equity: 0 })).toEqual({ balance: 0, equity: 0, floating: null });
  });
});

describe("trade sync helpers", () => {
  const stored = {
    id: "row-1",
    external_trade_id: "t1",
    symbol: "EURUSD",
    side: "BUY",
    status: "CLOSED",
    volume: "1.0000",
    open_price: "1.080000",
    close_price: "1.090000",
    profit: "100.00",
    currency: "USD",
    opened_at: "2026-10-01T10:00:00+00:00",
    closed_at: "2026-10-01T11:00:00+00:00",
  };
  const same = {
    trading_account_id: "acc-1",
    external_trade_id: "t1",
    symbol: "EURUSD",
    side: "BUY",
    status: "CLOSED",
    volume: 1,
    open_price: 1.08,
    close_price: 1.09,
    profit: 100,
    currency: "USD",
    opened_at: "2026-10-01T10:00:00.000Z",
    closed_at: "2026-10-01T11:00:00.000Z",
  } as unknown as Parameters<typeof tradeRowChanged>[1];

  test("database rounding never makes an unchanged trade look changed", () => {
    expect(tradeRowChanged(stored, same)).toBe(false);
  });

  test("a real change is noticed", () => {
    expect(tradeRowChanged(stored, { ...same, profit: 99.5 })).toBe(true);
    expect(tradeRowChanged(stored, { ...same, close_price: 1.0901 })).toBe(true);
    expect(tradeRowChanged(stored, { ...same, status: "OPEN", closed_at: null })).toBe(true);
    expect(tradeRowChanged(stored, { ...same, closed_at: "2026-10-01T11:00:01.000Z" })).toBe(true);
  });

  test("one row per broker id and a closed version wins over an open one", () => {
    type SyncRow = Parameters<typeof dedupeTradeRows>[0][number];
    const variant = (overrides: Record<string, unknown>) => ({ ...same, ...overrides }) as unknown as SyncRow;
    const open = variant({ external_trade_id: "a", status: "OPEN", closed_at: null });
    const closed = variant({ external_trade_id: "a", status: "CLOSED" });
    const other = variant({ external_trade_id: "b" });
    const noId = variant({ external_trade_id: "" });
    expect(dedupeTradeRows([open, closed, other, noId]).map((row) => [row.external_trade_id, row.status])).toEqual([
      ["a", "CLOSED"],
      ["b", "CLOSED"],
    ]);
    expect(dedupeTradeRows([closed, open]).map((row) => row.status)).toEqual(["CLOSED"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot and cash-flow storage
// ─────────────────────────────────────────────────────────────────────────────

describe("recordAccountSnapshot - values that are not numbers", () => {
  beforeEach(() => resetAccountSnapshotWriterState());

  test("is refused before any database call", async () => {
    const rpc = vi.fn();
    for (const [balance, equity] of [
      [Number.NaN, 100],
      [100, Number.POSITIVE_INFINITY],
    ]) {
      const result = await recordAccountSnapshot({ rpc }, { accountId: "a", balance, equity });
      expect(result.error?.message).toMatch(/finite/);
      expect(result.marginRecorded).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

type CashFlowRow = { trading_account_id: string; occurred_at: string; amount: number | string; id?: string };

function fakeCashFlowDb(options: {
  rows?: CashFlowRow[];
  upsertError?: { code?: string; message: string };
  selectError?: { code?: string; message: string };
}) {
  const upserts: Array<{ table: string; rows: Array<Record<string, unknown>>; onConflict?: string }> = [];
  const db = {
    from(table: string) {
      const filter: { ids: string[]; from: string; to: string } = { ids: [], from: "", to: "" };
      const query = {
        upsert(rows: Array<Record<string, unknown>>, config?: { onConflict?: string }) {
          upserts.push({ table, rows, onConflict: config?.onConflict });
          return Promise.resolve({ error: options.upsertError ?? null });
        },
        select() {
          return query;
        },
        in(_column: string, ids: string[]) {
          filter.ids = ids;
          return query;
        },
        gte(_column: string, value: string) {
          filter.from = value;
          return query;
        },
        lte(_column: string, value: string) {
          filter.to = value;
          return query;
        },
        order() {
          return query;
        },
        range(from: number, to: number) {
          if (options.selectError) return Promise.resolve({ data: null, error: options.selectError });
          const rows = (options.rows ?? [])
            .filter(
              (row) =>
                filter.ids.includes(row.trading_account_id) &&
                row.occurred_at >= filter.from &&
                row.occurred_at <= filter.to,
            )
            .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };
  return { db: db as unknown as Parameters<typeof recordCashFlows>[0], upserts };
}

describe("recordCashFlows", () => {
  const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
  const flow = (index: number) => ({
    externalId: `bal-${index}`,
    t: NOW - index * HOUR,
    amount: 100,
    kind: "DEPOSIT" as const,
    comment: null,
  });

  beforeEach(() => resetCashFlowTableState());
  afterEach(() => vi.restoreAllMocks());

  test("stores in chunks, keyed by account and broker ticket", async () => {
    const { db, upserts } = fakeCashFlowDb({});
    const result = await recordCashFlows(db, "acc-1", Array.from({ length: 450 }, (_, i) => flow(i + 1)), "USD", NOW);
    expect(result).toEqual({ stored: 450, supported: true });
    expect(upserts.map((entry) => entry.rows.length)).toEqual([200, 200, 50]);
    expect(upserts[0].table).toBe("account_cash_flows");
    expect(upserts[0].onConflict).toBe("trading_account_id,external_id");
    expect(upserts[0].rows[0]).toMatchObject({
      trading_account_id: "acc-1",
      external_id: "bal-1",
      kind: "DEPOSIT",
      amount: 100,
      currency: "USD",
    });
  });

  test("nothing to store is not a database call", async () => {
    const { db, upserts } = fakeCashFlowDb({});
    expect(await recordCashFlows(db, "acc-1", [], "USD", NOW)).toEqual({ stored: 0, supported: true });
    expect(upserts).toHaveLength(0);
  });

  test("a missing table (migration 059 not applied) is remembered for ten minutes", async () => {
    const { db, upserts } = fakeCashFlowDb({
      upsertError: { code: "42P01", message: 'relation "public.account_cash_flows" does not exist' },
    });
    expect(await recordCashFlows(db, "acc-1", [flow(1)], "USD", NOW)).toEqual({ stored: 0, supported: false });
    expect(await recordCashFlows(db, "acc-1", [flow(1)], "USD", NOW + 5 * MINUTE)).toEqual({
      stored: 0,
      supported: false,
    });
    expect(upserts).toHaveLength(1);
    await recordCashFlows(db, "acc-1", [flow(1)], "USD", NOW + 11 * MINUTE);
    expect(upserts).toHaveLength(2);
  });

  test("any other database problem is a warning, never an exception", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = fakeCashFlowDb({ upsertError: { message: "boom" } });
    expect(await recordCashFlows(db, "acc-1", [flow(1)], "USD", NOW)).toEqual({ stored: 0, supported: true });
    expect(warn).toHaveBeenCalled();
  });
});

describe("loadCashFlows", () => {
  const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
  const row = (account: string, iso: string, amount: number | string): CashFlowRow => ({
    trading_account_id: account,
    occurred_at: iso,
    amount,
  });

  beforeEach(() => resetCashFlowTableState());
  afterEach(() => vi.restoreAllMocks());

  test("returns the deposits and withdrawals of the asked accounts and window, oldest first", async () => {
    const { db } = fakeCashFlowDb({
      rows: [
        row("acc-1", "2026-09-20T10:00:00.000Z", "-250.50"),
        row("acc-1", "2026-09-01T10:00:00.000Z", 1000),
        row("acc-2", "2026-09-10T10:00:00.000Z", 700),
        row("acc-3", "2026-09-10T10:00:00.000Z", 900),
        row("acc-1", "2026-09-11T10:00:00.000Z", 0),
        row("acc-1", "2026-09-12T10:00:00.000Z", "not a number"),
        row("acc-1", "2026-11-01T10:00:00.000Z", 50),
      ],
    });
    const result = await loadCashFlows(db, ["acc-1", "acc-2"], 0, NOW, NOW);
    expect(result.supported).toBe(true);
    expect(result.flows).toEqual([
      { t: Date.parse("2026-09-01T10:00:00.000Z"), amount: 1000 },
      { t: Date.parse("2026-09-10T10:00:00.000Z"), amount: 700 },
      { t: Date.parse("2026-09-20T10:00:00.000Z"), amount: -250.5 },
    ]);
  });

  test("on request every flow says which account it belongs to (a combined curve needs it)", async () => {
    const { db } = fakeCashFlowDb({
      rows: [row("acc-2", "2026-09-10T10:00:00.000Z", 700), row("acc-1", "2026-09-01T10:00:00.000Z", 1000)],
    });
    const result = await loadCashFlows(db, ["acc-1", "acc-2"], 0, NOW, NOW, { withAccount: true });
    expect(result.flows).toEqual([
      { t: Date.parse("2026-09-01T10:00:00.000Z"), amount: 1000, accountId: "acc-1" },
      { t: Date.parse("2026-09-10T10:00:00.000Z"), amount: 700, accountId: "acc-2" },
    ]);
  });

  test("a missing table gives nothing and says it is not supported", async () => {
    const { db } = fakeCashFlowDb({
      selectError: { code: "PGRST205", message: "Could not find the table 'public.account_cash_flows' in the schema cache" },
    });
    expect(await loadCashFlows(db, ["acc-1"], 0, NOW, NOW)).toEqual({ flows: [], supported: false });
  });

  test("another read problem draws the chart without the adjustment instead of failing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = fakeCashFlowDb({ selectError: { message: "timeout" } });
    expect(await loadCashFlows(db, ["acc-1"], 0, NOW, NOW)).toEqual({ flows: [], supported: true });
  });

  test("no accounts or an inverted window is not a database call", async () => {
    const { db } = fakeCashFlowDb({ selectError: { message: "must not be called" } });
    expect(await loadCashFlows(db, [], 0, NOW, NOW)).toEqual({ flows: [], supported: true });
    expect(await loadCashFlows(db, ["acc-1"], NOW, 0, NOW)).toEqual({ flows: [], supported: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chart maths
// ─────────────────────────────────────────────────────────────────────────────

describe("dropGlitchSamples", () => {
  const point = (balance: number, equity: number) => ({ balance, equity });

  test("equity of zero next to a positive balance can not be real", () => {
    const result = dropGlitchSamples([point(1000, 1000), point(1000, 0), point(1000, 1010)]);
    expect(result.dropped).toBe(1);
    expect(result.kept.map((entry) => entry.equity)).toEqual([1000, 1010]);
  });

  test("an empty account (everything zero) is left alone", () => {
    expect(dropGlitchSamples([point(0, 0), point(0, 0), point(0, 0)]).dropped).toBe(0);
  });

  test("one isolated balance spike between two agreeing neighbours is dropped", () => {
    const result = dropGlitchSamples([point(1000, 1000), point(300, 300), point(1010, 1010)]);
    expect(result.dropped).toBe(1);
    expect(result.kept.map((entry) => entry.balance)).toEqual([1000, 1010]);
  });

  test("a real withdrawal (a step that stays) and a floating loss are kept", () => {
    expect(dropGlitchSamples([point(1000, 1000), point(1000, 1000), point(400, 400), point(400, 400)]).dropped).toBe(0);
    expect(dropGlitchSamples([point(1000, 1000), point(1000, 700), point(1000, 1000)]).dropped).toBe(0);
  });

  test("fewer than two samples are returned as they are", () => {
    expect(dropGlitchSamples([]).kept).toEqual([]);
    expect(dropGlitchSamples([point(1000, 0)])).toEqual({ kept: [point(1000, 0)], dropped: 0 });
  });
});

describe("cashFlowsForWindow", () => {
  test("keeps the flows inside the window, oldest first", () => {
    const flows: PerformanceCashFlow[] = [
      { t: 300, amount: 5 },
      { t: 50, amount: 1 },
      { t: 150, amount: -2 },
      { t: 900, amount: 7 },
      { t: 200, amount: 0 },
    ];
    expect(cashFlowsForWindow(flows, [], 100, 500)).toEqual([
      { t: 150, amount: -2 },
      { t: 300, amount: 5 },
    ]);
  });

  test("a very long list is merged per stretch between two samples without losing money", () => {
    const flows: PerformanceCashFlow[] = [
      { t: 150, amount: 1 },
      { t: 160, amount: 2 },
      { t: 250, amount: -1 },
      { t: 260, amount: 1 },
      { t: 290, amount: 5 },
      { t: 350, amount: 9 },
    ];
    expect(cashFlowsForWindow(flows, [{ t: 100 }, { t: 200 }, { t: 300 }], 0, 400, 3)).toEqual([
      { t: 200, amount: 3 },
      { t: 300, amount: 5 },
    ]);
  });
});

describe("reconstructEstimatedSamples with deposits and withdrawals", () => {
  test("walking back from the first real snapshot takes a deposit out of the earlier balance", () => {
    const anchor = { t: 20 * HOUR, balance: 1500 };
    const base = {
      start: 10 * HOUR,
      end: 20 * HOUR,
      anchor,
      initialBalance: null,
      trades: [{ t: 12 * HOUR, profit: 100, volume: 1 }],
      allHistory: false,
    };
    const withDeposit = reconstructEstimatedSamples({ ...base, flows: [{ t: 15 * HOUR, amount: 500 }] });
    expect(withDeposit.map((entry) => [entry.t, entry.balance])).toEqual([
      [10 * HOUR, 900],
      [12 * HOUR, 1000],
      [15 * HOUR, 1500],
    ]);
    expect(withDeposit.every((entry) => entry.estimated)).toBe(true);

    // without the deposit the same history would put the deposit into the early balance
    const withoutDeposit = reconstructEstimatedSamples(base);
    expect(withoutDeposit[0].balance).toBe(1400);
  });

  test("from the account's start the balance follows trades and money movements", () => {
    const result = reconstructEstimatedSamples({
      start: HOUR,
      end: 12 * HOUR,
      anchor: null,
      initialBalance: 1000,
      trades: [
        { t: 5 * HOUR, profit: 100, volume: 1 },
        { t: 9 * HOUR, profit: -50, volume: 1 },
      ],
      allHistory: true,
      flows: [{ t: 8 * HOUR, amount: 400 }],
    });
    expect(result.map((entry) => [entry.t, entry.balance])).toEqual([
      [HOUR, 1000],
      [5 * HOUR, 1100],
      [8 * HOUR, 1500],
      [9 * HOUR, 1450],
      [12 * HOUR, 1450],
    ]);
  });

  test("deposits made before the first data are the balance the history starts with", () => {
    const result = reconstructEstimatedSamples({
      start: HOUR,
      end: 12 * HOUR,
      anchor: null,
      initialBalance: 500,
      trades: [{ t: 5 * HOUR, profit: 100, volume: 1 }],
      allHistory: true,
      flows: [{ t: HOUR - 1, amount: 2000 }],
    });
    expect(result.map((entry) => entry.balance)).toEqual([2000, 2100, 2100]);
  });

  test("a curve that would need a balance of zero or less is not drawn", () => {
    expect(
      reconstructEstimatedSamples({
        start: 10 * HOUR,
        end: 20 * HOUR,
        anchor: { t: 20 * HOUR, balance: 100 },
        initialBalance: null,
        trades: [{ t: 12 * HOUR, profit: 500, volume: 1 }],
        allHistory: false,
      }),
    ).toEqual([]);
  });
});

describe("fillSnapshotGaps with deposits and withdrawals", () => {
  test("the bridge over a gap steps at the deposit and at the trade", () => {
    const result = fillSnapshotGaps({
      samples: [sample(0, 1000, 1000), sample(10 * HOUR, 1600, 1600)],
      trades: [{ t: 7 * HOUR, profit: 100, volume: 1 }],
      flows: [{ t: 4 * HOUR, amount: 500 }],
      gapMs: HOUR,
    });
    expect(result.gapCount).toBe(1);
    expect(result.samples.map((entry) => [entry.t, entry.balance])).toEqual([
      [1, 1000],
      [4 * HOUR - 1, 1000],
      [4 * HOUR, 1500],
      [7 * HOUR - 1, 1500],
      [7 * HOUR, 1600],
    ]);
    expect(result.samples.every((entry) => entry.estimated)).toBe(true);
  });
});

describe("deriveSeries - money paid in or out is not performance", () => {
  test("a deposit does not count as growth", () => {
    const derived = deriveSeries(
      dtoWith({
        samples: [sample(1000, 1000, 1000), sample(2000, 1000, 1100), sample(3000, 1500, 1600)],
        cashFlows: [{ t: 2500, amount: 500 }],
      }),
    );
    expect(derived.equityGrowthPct).toBeCloseTo(10, 6);
    expect(derived.balanceGrowthPct).toBeCloseTo(0, 6);
    expect(derived.maxDrawdownPct).toBe(0);
    expect(derived.cashFlowCount).toBe(1);
    expect(derived.netCashFlow).toBe(500);
  });

  test("the same samples without the deposit would show the deposit as profit", () => {
    const derived = deriveSeries(
      dtoWith({ samples: [sample(1000, 1000, 1000), sample(2000, 1000, 1100), sample(3000, 1500, 1600)] }),
    );
    expect(derived.equityGrowthPct).toBeCloseTo(60, 6);
    expect(derived.cashFlowCount).toBe(0);
  });

  test("a withdrawal does not count as a loss or a drawdown", () => {
    const derived = deriveSeries(
      dtoWith({
        samples: [sample(1000, 2000, 2000), sample(2000, 1000, 1000)],
        cashFlows: [{ t: 1500, amount: -1000 }],
      }),
    );
    expect(derived.equityGrowthPct).toBeCloseTo(0, 6);
    expect(derived.maxDrawdownPct).toBe(0);
    expect(derived.netCashFlow).toBe(-1000);
  });

  test("a real loss after a deposit is still a loss", () => {
    const derived = deriveSeries(
      dtoWith({
        samples: [sample(1000, 1000, 1000), sample(2000, 2000, 2000), sample(3000, 1800, 1800)],
        cashFlows: [{ t: 1500, amount: 1000 }],
      }),
    );
    expect(derived.equityGrowthPct).toBeCloseTo(-10, 6);
    expect(derived.maxDrawdownPct).toBeCloseTo(10, 6);
    expect(derived.currentDrawdownPct).toBeCloseTo(10, 6);
  });

  test("a flow at or before the first reading changes nothing", () => {
    const derived = deriveSeries(
      dtoWith({
        samples: [sample(1000, 1000, 1000), sample(2000, 1000, 1050)],
        cashFlows: [{ t: 500, amount: 9999 }],
      }),
    );
    expect(derived.equityGrowthPct).toBeCloseTo(5, 6);
    expect(derived.cashFlowCount).toBe(0);
  });

  test("growth starts at zero at the first reading, even with a floating P&L", () => {
    const derived = deriveSeries(dtoWith({ samples: [sample(1000, 1000, 1100), sample(2000, 1000, 1210)] }));
    expect(derived.points[0].equityGrowth).toBe(0);
    expect(derived.points[0].balanceGrowth).toBe(0);
    expect(derived.equityGrowthPct).toBeCloseTo(10, 6);
  });
});

describe("assemblePerformanceDto - deposits, withdrawals and impossible readings", () => {
  const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
  const common = {
    accountId: "acc-1",
    currency: "USD",
    range: "ALL" as const,
    start: T0,
    end: T0 + 10 * HOUR,
    trades: [],
    tradesTruncated: false,
    initialBalance: 1000,
    equityPeak: null,
    marginSupported: true,
    aggregate: false,
    aggregateLimitedToDays: null,
    mixedCurrencies: false,
    allHistory: true,
  };
  const snap = (hours: number, balance: number, equity: number) => ({
    t: T0 + hours * HOUR,
    balance,
    equity,
    margin: null,
    freeMargin: null,
    marginLevel: null,
  });

  test("a reading with equity 0 is left out and the deposit does not become growth", () => {
    const dto = assemblePerformanceDto({
      ...common,
      snapshots: [snap(0, 1000, 1000), snap(1, 1000, 0), snap(2, 1000, 1005), snap(5, 1500, 1500)],
      firstSnapshotAt: T0,
      lastSnapshotAt: T0 + 5 * HOUR,
      cashFlows: [{ t: T0 + 4 * HOUR, amount: 500 }],
      cashFlowsSupported: true,
    });

    expect(dto.coverage.glitchSamplesDropped).toBe(1);
    expect(dto.samples.map((entry) => entry.t)).not.toContain(T0 + HOUR);
    expect(dto.coverage.cashFlowCount).toBe(1);
    expect(dto.coverage.cashFlowsSupported).toBe(true);
    expect(dto.cashFlows).toEqual([{ t: T0 + 4 * HOUR, amount: 500 }]);
    expect(deriveSeries(dto).equityGrowthPct).toBeCloseTo(0, 6);
  });

  test("the balance before the first snapshot is rebuilt through the deposit", () => {
    const dto = assemblePerformanceDto({
      ...common,
      snapshots: [snap(6, 1500, 1500)],
      firstSnapshotAt: T0 + 6 * HOUR,
      lastSnapshotAt: T0 + 6 * HOUR,
      // the first closed trade is the first data the platform holds: nothing is estimated before it
      firstDataAt: T0 + 2 * HOUR,
      trades: [{ t: T0 + 2 * HOUR, profit: 50, volume: 1 }],
      cashFlows: [{ t: T0 + 3 * HOUR, amount: 500 }],
      cashFlowsSupported: true,
    });
    const estimated = dto.samples.filter((entry) => entry.estimated);
    expect(estimated.map((entry) => [entry.t, entry.balance])).toEqual([
      [T0 + 2 * HOUR - 1, 950],
      [T0 + 2 * HOUR, 1000],
      [T0 + 3 * HOUR, 1500],
    ]);
  });

  test("without cash-flow data nothing changes and the table is reported as not supported", () => {
    const dto = assemblePerformanceDto({
      ...common,
      snapshots: [snap(0, 1000, 1000), snap(5, 1000, 1010)],
      firstSnapshotAt: T0,
      lastSnapshotAt: T0 + 5 * HOUR,
    });
    expect(dto.cashFlows).toEqual([]);
    expect(dto.coverage.cashFlowCount).toBe(0);
    expect(dto.coverage.cashFlowsSupported).toBe(false);
    expect(dto.coverage.glitchSamplesDropped).toBe(0);
  });
});
