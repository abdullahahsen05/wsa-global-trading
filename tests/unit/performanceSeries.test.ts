import { describe, expect, test } from "vitest";
import {
  PERFORMANCE_STALE_AFTER_MS,
  bucketLedgerForBars,
  buildLedger,
  buildProbeTimes,
  buildTradeProbeTimes,
  decimalsForStep,
  deriveSeries,
  fillSnapshotGaps,
  formatAxisMoney,
  formatAxisPercent,
  formatSignedPercent,
  formatTimeTick,
  gapThresholdMs,
  historyStartFor,
  lastIndexAtOrBefore,
  nearestIndexByTime,
  niceScale,
  normalizeSamples,
  rangeForAnalyticsPeriod,
  reconstructEstimatedSamples,
  resolveRangeStart,
  resolveWindow,
  sampleCountFor,
  summarizeTrades,
  timeAxisLabels,
  timeTicks,
  type PerformanceSample,
  type PerformanceSeriesDto,
} from "@/lib/charts/performanceSeries";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

describe("range helpers", () => {
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);

  test("a fixed range starts at now minus its length when the account is older", () => {
    expect(resolveRangeStart("1W", now, now - 90 * DAY)).toBe(now - 7 * DAY);
    expect(resolveRangeStart("1D", now, null)).toBe(now - DAY);
  });

  test("a fixed range spans the period that was chosen, however young the account is", () => {
    // The axis used to be cut at the first data point, so 1M, 3M, 6M and 1Y all looked the same.
    const firstDataAt = now - 2 * DAY;
    expect(resolveRangeStart("1M", now, firstDataAt)).toBe(now - 30 * DAY);
    expect(resolveRangeStart("3M", now, firstDataAt)).toBe(now - 90 * DAY);
    expect(resolveRangeStart("6M", now, firstDataAt)).toBe(now - 182 * DAY);
    expect(resolveRangeStart("1Y", now, firstDataAt)).toBe(now - 365 * DAY);
    expect(resolveRangeStart("1W", now, now - 1_000)).toBe(now - 7 * DAY);
  });

  test("ALL starts at the first data point, or one day back when there is none", () => {
    expect(resolveRangeStart("ALL", now, now - 40 * DAY)).toBe(now - 40 * DAY);
    expect(resolveRangeStart("ALL", now, null)).toBe(now - DAY);
  });

  test("the time axis of ALL never collapses to a point", () => {
    expect(resolveRangeStart("ALL", now, now - 1_000)).toBe(now - 10 * MINUTE);
  });

  test("historyStartFor says where the data begins inside a window", () => {
    const start = now - 30 * DAY;
    // an older account: the data covers the whole window
    expect(historyStartFor(start, now, now - 90 * DAY)).toBe(start);
    // a younger account: the data begins later
    expect(historyStartFor(start, now, now - 3 * DAY)).toBe(now - 3 * DAY);
    // no data at all, or a nonsense value: the window itself
    expect(historyStartFor(start, now, null)).toBe(start);
    expect(historyStartFor(start, now, undefined)).toBe(start);
    expect(historyStartFor(start, now, Number.NaN)).toBe(start);
    // data that begins after the window ended is clamped to its end
    expect(historyStartFor(start, now, now + DAY)).toBe(now);
  });

  test("analytics periods map to chart ranges", () => {
    expect(rangeForAnalyticsPeriod("DAILY")).toBe("1D");
    expect(rangeForAnalyticsPeriod("WEEKLY")).toBe("1W");
    expect(rangeForAnalyticsPeriod("MONTHLY")).toBe("1M");
    expect(rangeForAnalyticsPeriod("ALL_TIME")).toBe("ALL");
  });

  test("probe instants are evenly spaced and end exactly at the end", () => {
    expect(buildProbeTimes(0, 400, 5)).toEqual([0, 100, 200, 300, 400]);
    const probes = buildProbeTimes(1_000, 1_000 + 7 * DAY, 120);
    expect(probes).toHaveLength(120);
    expect(probes[0]).toBe(1_000);
    expect(probes[119]).toBe(1_000 + 7 * DAY);
    expect(buildProbeTimes(500, 500, 10)).toEqual([500]);
  });
});

describe("sample and trade helpers", () => {
  test("normalizeSamples drops invalid rows, sorts and keeps the last row of equal timestamps", () => {
    const result = normalizeSamples([
      sample(300, 3, 3),
      sample(100, 1, 1),
      sample(Number.NaN, 9, 9),
      sample(200, 2, 2),
      sample(200, 20, 20),
      sample(400, Number.NaN, 4),
    ]);
    expect(result.map((entry) => [entry.t, entry.balance])).toEqual([
      [100, 1],
      [200, 20],
      [300, 3],
    ]);
  });

  test("summarizeTrades counts wins, losses and totals", () => {
    const stats = summarizeTrades([
      { t: 1, profit: 100, volume: 0.1 },
      { t: 2, profit: -40, volume: 0.2 },
      { t: 3, profit: 0, volume: 0.3 },
      { t: 4, profit: 20, volume: 0.4 },
    ]);
    expect(stats.tradeCount).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBe(50);
    expect(stats.totalProfit).toBe(80);
    expect(stats.grossProfit).toBe(120);
    expect(stats.grossLoss).toBe(-40);
    expect(stats.totalVolume).toBeCloseTo(1, 6);
    expect(stats.bestTrade).toBe(100);
    expect(stats.worstTrade).toBe(-40);
  });

  test("summarizeTrades of nothing is all zeros, not NaN", () => {
    const stats = summarizeTrades([]);
    expect(stats).toMatchObject({ tradeCount: 0, winRate: 0, totalProfit: 0, bestTrade: null, worstTrade: null });
  });

  test("buildLedger keeps one point per trade while there are few trades", () => {
    const ledger = buildLedger(
      [
        { t: 30, profit: 3, volume: 1 },
        { t: 10, profit: 1, volume: 1 },
        { t: 20, profit: -2, volume: 1 },
      ],
      0,
      100,
    );
    expect(ledger.map((point) => point.t)).toEqual([10, 20, 30]);
    expect(ledger.map((point) => point.wins)).toEqual([1, 0, 1]);
  });

  test("buildLedger buckets many trades without losing any profit, volume or count", () => {
    const trades = Array.from({ length: 1_000 }, (_, index) => ({
      t: index * 10,
      profit: index % 3 === 0 ? -1 : 2,
      volume: 0.01,
    }));
    const ledger = buildLedger(trades, 0, 10_000, 100);
    expect(ledger.length).toBeLessThanOrEqual(101);
    expect(ledger.reduce((sum, point) => sum + point.count, 0)).toBe(1_000);
    const expectedProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);
    expect(ledger.reduce((sum, point) => sum + point.profit, 0)).toBeCloseTo(expectedProfit, 6);
    expect(ledger.reduce((sum, point) => sum + point.volume, 0)).toBeCloseTo(10, 4);
  });

  test("bucketLedgerForBars groups ledger points and ignores those outside the window", () => {
    const bars = bucketLedgerForBars(
      [
        { t: 5, profit: 1, volume: 1, count: 1, wins: 1 },
        { t: 15, profit: -1, volume: 2, count: 1, wins: 0 },
        { t: 16, profit: 4, volume: 3, count: 1, wins: 1 },
        { t: 500, profit: 9, volume: 9, count: 1, wins: 1 },
      ],
      0,
      100,
      10,
    );
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ volume: 1, profit: 1 });
    expect(bars[1]).toMatchObject({ volume: 5, profit: 3 });
  });
});

describe("estimated balance reconstruction", () => {
  test("walks backwards from the first recorded snapshot through earlier trades", () => {
    const points = reconstructEstimatedSamples({
      start: 0,
      end: 2_000,
      anchor: { t: 1_000, balance: 1_000 },
      initialBalance: null,
      trades: [
        { t: 200, profit: 50, volume: 1 },
        { t: 600, profit: -20, volume: 1 },
        { t: 1_500, profit: 99, volume: 1 },
      ],
      allHistory: false,
    });
    expect(points.map((point) => [point.t, point.balance])).toEqual([
      [0, 970],
      [200, 1020],
      [600, 1000],
    ]);
    expect(points.every((point) => point.estimated)).toBe(true);
    expect(points.every((point) => point.equity === point.balance)).toBe(true);
    expect(points.every((point) => point.margin === null)).toBe(true);
  });

  test("returns nothing when no trade closed before the anchor", () => {
    expect(
      reconstructEstimatedSamples({
        start: 0,
        end: 2_000,
        anchor: { t: 1_000, balance: 1_000 },
        initialBalance: 500,
        trades: [{ t: 1_500, profit: 10, volume: 1 }],
        allHistory: true,
      }),
    ).toEqual([]);
  });

  test("without any snapshot it walks forward from the initial balance, only for the whole history", () => {
    const trades = [
      { t: 100, profit: 10, volume: 1 },
      { t: 300, profit: -5, volume: 1 },
    ];
    const forward = reconstructEstimatedSamples({
      start: 0,
      end: 1_000,
      anchor: null,
      initialBalance: 500,
      trades,
      allHistory: true,
    });
    expect(forward.map((point) => [point.t, point.balance])).toEqual([
      [0, 500],
      [100, 510],
      [300, 505],
      [1_000, 505],
    ]);

    expect(
      reconstructEstimatedSamples({ start: 0, end: 1_000, anchor: null, initialBalance: 500, trades, allHistory: false }),
    ).toEqual([]);
    expect(
      reconstructEstimatedSamples({ start: 0, end: 1_000, anchor: null, initialBalance: null, trades, allHistory: true }),
    ).toEqual([]);
    expect(
      reconstructEstimatedSamples({ start: 0, end: 1_000, anchor: null, initialBalance: 0, trades, allHistory: true }),
    ).toEqual([]);
  });

  test("thins long histories but keeps the first and last point", () => {
    const trades = Array.from({ length: 600 }, (_, index) => ({ t: 10 + index * 10, profit: 1, volume: 1 }));
    const points = reconstructEstimatedSamples({
      start: 0,
      end: 7_000,
      anchor: null,
      initialBalance: 1_000,
      trades,
      allHistory: true,
      maxPoints: 50,
    });
    expect(points.length).toBeLessThanOrEqual(52);
    expect(points[0].t).toBe(0);
    expect(points[0].balance).toBe(1_000);
    expect(points[points.length - 1].t).toBe(7_000);
    expect(points[points.length - 1].balance).toBe(1_600);
  });

  test("a window wider than the history is not estimated before the first event (walking forward)", () => {
    // 1Y chosen on an account whose first closed trade is at t=900: no flat line through t=0..899
    const points = reconstructEstimatedSamples({
      start: 0,
      end: 2_000,
      anchor: null,
      initialBalance: 500,
      trades: [
        { t: 900, profit: 10, volume: 1 },
        { t: 1_200, profit: -5, volume: 1 },
      ],
      allHistory: true,
      historyStart: 900,
    });
    expect(points.map((point) => [point.t, point.balance])).toEqual([
      [899, 500],
      [900, 510],
      [1_200, 505],
      [2_000, 505],
    ]);
    expect(Math.min(...points.map((point) => point.t))).toBeGreaterThanOrEqual(899);
  });

  test("a window wider than the history is not estimated before the first event (walking back)", () => {
    const points = reconstructEstimatedSamples({
      start: 0,
      end: 5_000,
      anchor: { t: 3_000, balance: 1_000 },
      initialBalance: null,
      trades: [
        { t: 1_000, profit: 40, volume: 1 },
        { t: 2_000, profit: -10, volume: 1 },
      ],
      allHistory: false,
      historyStart: 1_000,
    });
    expect(points.map((point) => [point.t, point.balance])).toEqual([
      [999, 970],
      [1_000, 1_010],
      [2_000, 1_000],
    ]);
  });

  test("when the history reaches the window start nothing changes", () => {
    const withHistory = reconstructEstimatedSamples({
      start: 0,
      end: 1_000,
      anchor: null,
      initialBalance: 500,
      trades: [{ t: 100, profit: 10, volume: 1 }],
      allHistory: true,
      historyStart: -5_000,
    });
    const without = reconstructEstimatedSamples({
      start: 0,
      end: 1_000,
      anchor: null,
      initialBalance: 500,
      trades: [{ t: 100, profit: 10, volume: 1 }],
      allHistory: true,
    });
    expect(withHistory).toEqual(without);
    expect(withHistory[0].t).toBe(0);
  });

  test("thinning counts its buckets from where the estimate begins, so a young account in a wide window keeps its detail", () => {
    // 200 trades in the last 2 000 ms of a 1 000 000 ms window, at most 100 points
    const trades = Array.from({ length: 200 }, (_, index) => ({ t: 998_000 + index * 10, profit: 1, volume: 1 }));
    const points = reconstructEstimatedSamples({
      start: 0,
      end: 1_000_000,
      anchor: null,
      initialBalance: 1_000,
      trades,
      allHistory: true,
      maxPoints: 100,
      historyStart: 998_000,
    });
    // counted from the window start these 200 trades would fall into 1 bucket
    expect(points.length).toBeGreaterThan(40);
    expect(points[0].t).toBe(997_999);
    expect(points[points.length - 1].t).toBe(1_000_000);
  });
});

describe("deriveSeries", () => {
  const dto = dtoWith({
    start: 1_000,
    end: 5_000,
    samples: [
      sample(1_000, 1_000, 1_000),
      sample(2_000, 1_000, 1_100),
      sample(3_000, 1_050, 990),
      sample(4_000, 1_050, 1_200),
    ],
    ledger: [{ t: 2_500, profit: 50, volume: 0.1, count: 1, wins: 1 }],
  });
  const derived = deriveSeries(dto);

  test("growth is measured against the first point of the window", () => {
    expect(derived.base).toBe(1_000);
    expect(derived.points.map((point) => Math.round(point.equityGrowth * 100) / 100)).toEqual([0, 10, -1, 20]);
    expect(derived.equityGrowthPct).toBeCloseTo(20, 6);
    expect(derived.balanceGrowthPct).toBeCloseTo(5, 6);
  });

  test("drawdown is measured against the running equity peak", () => {
    expect(derived.points[2].drawdown).toBeCloseTo(10, 6);
    expect(derived.maxDrawdownPct).toBeCloseTo(10, 6);
    expect(derived.currentDrawdownPct).toBe(0);
  });

  test("closed P&L accumulates from zero and holds its last value to the end of the window", () => {
    expect(derived.pnl).toEqual([
      { t: 1_000, cum: 0, growth: 0 },
      { t: 2_500, cum: 50, growth: 5 },
      { t: 5_000, cum: 50, growth: 5 },
    ]);
    expect(derived.closedPnl).toBe(50);
    expect(derived.pnlGrowthPct).toBe(5);
  });

  test("floating P&L is equity minus balance and flags come from the samples", () => {
    expect(derived.points[1].floating).toBe(100);
    expect(derived.hasMargin).toBe(false);
    expect(derived.hasEstimated).toBe(false);
    expect(derived.latest?.t).toBe(4_000);
  });

  test("an empty window has no base and no points but still a flat P&L line", () => {
    const empty = deriveSeries(dtoWith({ samples: [] }));
    expect(empty.base).toBeNull();
    expect(empty.points).toEqual([]);
    expect(empty.latest).toBeNull();
    expect(empty.equityGrowthPct).toBe(0);
    expect(empty.pnl).toEqual([
      { t: 1_000, cum: 0, growth: 0 },
      { t: 5_000, cum: 0, growth: 0 },
    ]);
  });

  test("margin and estimated flags are detected", () => {
    const withMargin = deriveSeries(
      dtoWith({
        samples: [
          sample(1_000, 100, 100, { estimated: true }),
          sample(2_000, 100, 101, { margin: 10, freeMargin: 91, marginLevel: 1010 }),
        ],
      }),
    );
    expect(withMargin.hasMargin).toBe(true);
    expect(withMargin.hasEstimated).toBe(true);
  });

  test("the base falls back to equity when the first balance is zero", () => {
    const result = deriveSeries(dtoWith({ samples: [sample(1_000, 0, 200), sample(2_000, 0, 220)] }));
    expect(result.base).toBe(200);
    expect(result.equityGrowthPct).toBeCloseTo(10, 6);
  });

  describe("a period wider than the history", () => {
    const young = dtoWith({
      start: 0,
      end: 10_000,
      samples: [sample(7_000, 1_000, 1_000), sample(9_000, 1_100, 1_100)],
      ledger: [{ t: 8_000, profit: 100, volume: 0.1, count: 1, wins: 1 }],
    });
    young.coverage.firstDataAt = 7_000;

    test("the history starts where the data does, not at the window start", () => {
      const result = deriveSeries(young);
      expect(result.start).toBe(0);
      expect(result.historyStart).toBe(7_000);
    });

    test("the closed P&L line begins at the history start, without a flat zero line through the empty stretch", () => {
      const result = deriveSeries(young);
      expect(result.pnl).toEqual([
        { t: 7_000, cum: 0, growth: 0 },
        { t: 8_000, cum: 100, growth: 10 },
        { t: 10_000, cum: 100, growth: 10 },
      ]);
    });

    test("an account older than the window has its history from the window start", () => {
      const old = dtoWith({ start: 5_000, end: 10_000, samples: [sample(5_000, 1_000, 1_000)] });
      old.coverage.firstDataAt = 1_000;
      expect(deriveSeries(old).historyStart).toBe(5_000);
    });
  });

  describe("accounts connected while the combined curve runs", () => {
    // 1 000 at t=1000; a second account joins with 4 000 (its whole value appears in the sum at t=3000)
    const samples = [
      sample(1_000, 1_000, 1_000),
      sample(2_000, 1_000, 1_100),
      sample(3_000, 5_000, 5_100),
      sample(4_000, 5_000, 5_610),
    ];
    const joined = dtoWith({
      start: 1_000,
      end: 5_000,
      samples,
      ledger: [{ t: 3_500, profit: 100, volume: 1, count: 1, wins: 1 }],
      cashFlows: [{ t: 3_000, amount: 4_000, kind: "JOIN" }],
    });

    test("the money an account brings along is not performance", () => {
      const withJoin = deriveSeries(joined);
      // without the join the jump from 1 100 to 5 100 would read as +364 %
      const withoutJoin = deriveSeries({ ...joined, cashFlows: [] });
      expect(withoutJoin.equityGrowthPct).toBeGreaterThan(400);
      // equity: 1 000 -> 1 100 (+10 %) -> (5 100 - 4 000) / 1 100 = 1 -> 5 610 / 5 100 (+10 %): +21 %
      expect(withJoin.points.map((point) => Math.round(point.equityGrowth * 10) / 10)).toEqual([0, 10, 10, 21]);
      expect(withJoin.maxDrawdownPct).toBe(0);
    });

    test("joins are counted apart from deposits and withdrawals", () => {
      const result = deriveSeries(joined);
      expect(result.joinedAccounts).toBe(1);
      expect(result.joinedAmount).toBe(4_000);
      expect(result.cashFlowCount).toBe(0);
      expect(result.netCashFlow).toBe(0);
    });

    test("closed P&L is measured against the first balance plus the accounts that joined", () => {
      const result = deriveSeries(joined);
      expect(result.base).toBe(1_000);
      expect(result.pnlBase).toBe(5_000);
      expect(result.closedPnl).toBe(100);
      expect(result.pnlGrowthPct).toBeCloseTo(2, 6);
      expect(result.pnl[result.pnl.length - 1].growth).toBeCloseTo(2, 6);
    });

    test("a deposit and a join in the same stretch are both taken out", () => {
      const both = deriveSeries({
        ...joined,
        cashFlows: [
          { t: 3_000, amount: 4_000, kind: "JOIN" },
          { t: 3_000, amount: 500 },
        ],
      });
      expect(both.joinedAccounts).toBe(1);
      expect(both.cashFlowCount).toBe(1);
      expect(both.netCashFlow).toBe(500);
    });

    test("one account has no join and its closed P&L base is the first balance", () => {
      const single = deriveSeries(dtoWith({ samples: [sample(1_000, 1_000, 1_000), sample(2_000, 1_050, 1_050)] }));
      expect(single.joinedAccounts).toBe(0);
      expect(single.pnlBase).toBe(single.base);
    });
  });
});

describe("time axis labels", () => {
  const at = (month: number, day: number, hour = 0, minute = 0, year = 2026) =>
    new Date(year, month - 1, day, hour, minute).getTime();

  test("a row of clock times says its date under the first tick and where the day changes", () => {
    const start = at(10, 11, 21);
    const end = at(10, 12, 9);
    const ticks = [at(10, 11, 21), at(10, 11, 23), at(10, 12, 0), at(10, 12, 3), at(10, 12, 6), at(10, 12, 9)];
    const labels = timeAxisLabels(ticks, end - start);
    expect(labels.map((entry) => entry.label)).toEqual(["21:00", "23:00", "Oct 12", "03:00", "06:00", "09:00"]);
    // the first tick names its day; the midnight tick is a date already; the rest stay on that day
    expect(labels.map((entry) => entry.sub)).toEqual(["Oct 11", null, null, null, null, null]);
  });

  test("a short view that crosses midnight names the new day under the clock time", () => {
    const start = at(10, 11, 22);
    const end = at(10, 12, 2);
    const ticks = [at(10, 11, 22), at(10, 12, 0), at(10, 12, 2)];
    const labels = timeAxisLabels(ticks, end - start); // 4 h: labels are clock times
    expect(labels.map((entry) => entry.label)).toEqual(["22:00", "00:00", "02:00"]);
    expect(labels.map((entry) => entry.sub)).toEqual(["Oct 11", "Oct 12", null]);
  });

  test("a row of days says its year once, and again where the year changes", () => {
    const ticks = [at(12, 20), at(12, 27), at(1, 3, 0, 0, 2027), at(1, 10, 0, 0, 2027)];
    const labels = timeAxisLabels(ticks, 21 * DAY);
    expect(labels.map((entry) => entry.label)).toEqual(["Dec 20", "Dec 27", "Jan 3", "Jan 10"]);
    expect(labels.map((entry) => entry.sub)).toEqual(["2026", null, "2027", null]);
  });

  test("a long period carries the year in every label and needs no second line", () => {
    const ticks = [at(1, 1), at(4, 1), at(7, 1), at(10, 1)];
    const labels = timeAxisLabels(ticks, 270 * DAY);
    expect(labels.map((entry) => entry.label)).toEqual(["Jan ’26", "Apr ’26", "Jul ’26", "Oct ’26"]);
    expect(labels.every((entry) => entry.sub === null)).toBe(true);
  });
});

describe("lookups", () => {
  const times = [10, 20, 30, 40];

  test("nearestIndexByTime picks the closest sample", () => {
    expect(nearestIndexByTime(times, 5)).toBe(0);
    expect(nearestIndexByTime(times, 24)).toBe(1);
    expect(nearestIndexByTime(times, 26)).toBe(2);
    expect(nearestIndexByTime(times, 1_000)).toBe(3);
    expect(nearestIndexByTime([], 5)).toBe(-1);
  });

  test("lastIndexAtOrBefore never looks into the future", () => {
    expect(lastIndexAtOrBefore(times, 5)).toBe(-1);
    expect(lastIndexAtOrBefore(times, 10)).toBe(0);
    expect(lastIndexAtOrBefore(times, 39)).toBe(2);
    expect(lastIndexAtOrBefore(times, 99)).toBe(3);
  });
});

describe("axis scales", () => {
  test("decimalsForStep prints steps exactly", () => {
    expect(decimalsForStep(2)).toBe(0);
    expect(decimalsForStep(0.5)).toBe(1);
    expect(decimalsForStep(0.25)).toBe(2);
    expect(decimalsForStep(0.001)).toBe(3);
    expect(decimalsForStep(0)).toBe(0);
  });

  test("niceScale covers the data with round, evenly spaced ticks", () => {
    const scale = niceScale(-0.12, 0.35, { includeZero: true, minSpan: 0.2 });
    expect(scale.min).toBeLessThanOrEqual(-0.12);
    expect(scale.max).toBeGreaterThanOrEqual(0.35);
    expect(scale.ticks).toContain(0);
    for (let index = 1; index < scale.ticks.length; index += 1) {
      expect(scale.ticks[index] - scale.ticks[index - 1]).toBeCloseTo(scale.step, 9);
    }
  });

  test("a tiny growth domain keeps its own scale (the old chart pinned it to one unit)", () => {
    const scale = niceScale(0, 0.04, { includeZero: true, minSpan: 0.2 });
    expect(scale.max - scale.min).toBeLessThan(1);
    expect(scale.step).toBeLessThan(0.2);
  });

  test("a flat series still gets a visible span around its value", () => {
    const scale = niceScale(189_477.75, 189_477.75, { minSpan: 758 });
    expect(scale.min).toBeLessThan(189_477.75);
    expect(scale.max).toBeGreaterThan(189_477.75);
    expect(scale.max - scale.min).toBeGreaterThanOrEqual(758);
  });

  test("non-finite input does not break the scale", () => {
    const scale = niceScale(Number.NaN, Number.POSITIVE_INFINITY, { minSpan: 1 });
    expect(Number.isFinite(scale.min)).toBe(true);
    expect(Number.isFinite(scale.max)).toBe(true);
    expect(scale.ticks.length).toBeGreaterThan(1);
  });

  test("percent and money labels", () => {
    expect(formatAxisPercent(0, 0.5)).toBe("0%");
    expect(formatAxisPercent(1.5, 0.5)).toBe("1.5%");
    expect(formatAxisPercent(0.25, 0.25)).toBe("0.25%");
    expect(formatSignedPercent(1.234)).toBe("+1.23%");
    expect(formatSignedPercent(-2)).toBe("-2.00%");
    expect(formatSignedPercent(-0.004)).toBe("0.00%");
    expect(formatSignedPercent(Number.NaN)).toBe("—");
    expect(formatAxisMoney(189_477.75, "USD", 5_000)).toBe("$189.5K");
    expect(formatAxisMoney(189_478, "USD", 100)).toBe("$189,478");
    expect(formatAxisMoney(0.004, "USD", 0.5)).toBe("$0");
  });
});

describe("time axis", () => {
  test("hourly ticks are ascending, inside the window and evenly spaced", () => {
    const start = Date.UTC(2026, 9, 11, 7, 17);
    const end = start + 12 * HOUR;
    const ticks = timeTicks(start, end, 6);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks[0]).toBeGreaterThanOrEqual(start);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(end);
    const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]);
    expect(new Set(gaps).size).toBe(1);
  });

  test("multi-day ticks fall on local midnight", () => {
    const start = new Date(2026, 8, 1, 13, 30).getTime();
    const end = new Date(2026, 9, 11, 9, 0).getTime();
    const ticks = timeTicks(start, end, 6);
    expect(ticks.length).toBeGreaterThan(1);
    for (const tick of ticks) {
      const date = new Date(tick);
      expect(date.getHours()).toBe(0);
      expect(date.getMinutes()).toBe(0);
    }
    expect(ticks[0]).toBeGreaterThanOrEqual(start);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(end);
  });

  test("year-long ticks fall on the first of a month", () => {
    const start = new Date(2025, 9, 11).getTime();
    const end = new Date(2026, 9, 11).getTime();
    const ticks = timeTicks(start, end, 6);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(7);
    for (const tick of ticks) expect(new Date(tick).getDate()).toBe(1);
  });

  test("a collapsed window yields a single tick", () => {
    expect(timeTicks(5, 5, 6)).toEqual([5]);
  });

  test("tick labels depend on the visible span", () => {
    const time = new Date(2026, 9, 11, 14, 5).getTime();
    expect(formatTimeTick(time, 6 * HOUR)).toMatch(/14:05/);
    expect(formatTimeTick(time, 30 * DAY)).toMatch(/Oct/);
    expect(formatTimeTick(time, 400 * DAY)).toMatch(/Oct/);
  });

  test("on a view that crosses days, the midnight tick carries the date instead of 00:00", () => {
    const midnight = new Date(2026, 9, 12, 0, 0).getTime();
    expect(formatTimeTick(midnight, DAY)).toMatch(/Oct\s*12/);
    expect(formatTimeTick(midnight, DAY)).not.toMatch(/00:00/);
    // a short view never labels its edge as a date
    expect(formatTimeTick(midnight, 3 * HOUR)).toMatch(/00:00/);
    const noon = new Date(2026, 9, 12, 12, 0).getTime();
    expect(formatTimeTick(noon, DAY)).toMatch(/12:00/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calibrated window, denser sampling, gap bridging
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWindow - the chart is calibrated to the data it really has", () => {
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);

  test("a live account runs up to now", () => {
    const window = resolveWindow({ range: "1W", now, firstDataAt: now - 30 * DAY, lastDataAt: now - 20_000 });
    expect(window).toEqual({ start: now - 7 * DAY, end: now, stale: false });
  });

  test("the staleness limit is 15 minutes", () => {
    const edge = resolveWindow({ range: "1D", now, firstDataAt: now - DAY, lastDataAt: now - PERFORMANCE_STALE_AFTER_MS });
    expect(edge.stale).toBe(false);
    const over = resolveWindow({ range: "1D", now, firstDataAt: now - DAY, lastDataAt: now - PERFORMANCE_STALE_AFTER_MS - 1 });
    expect(over.stale).toBe(true);
  });

  test("once recording stopped the window ends at the last data and the range is counted back from there", () => {
    const lastDataAt = now - 3 * DAY;
    const window = resolveWindow({ range: "1D", now, firstDataAt: now - 40 * DAY, lastDataAt });
    expect(window).toEqual({ start: lastDataAt - DAY, end: lastDataAt, stale: true });
  });

  test("a young stopped account still gets the period that was chosen, ending at its last data", () => {
    const firstDataAt = now - 5 * DAY;
    const lastDataAt = now - 4 * DAY;
    const window = resolveWindow({ range: "3M", now, firstDataAt, lastDataAt });
    expect(window.start).toBe(lastDataAt - 90 * DAY);
    expect(window.end).toBe(lastDataAt);
    // the stretch before the first data stays on the axis; historyStartFor marks it
    expect(historyStartFor(window.start, window.end, firstDataAt)).toBe(firstDataAt);
  });

  test("every fixed range spans exactly its own length on a live account of any age", () => {
    const span = (range: "1D" | "1W" | "1M" | "3M" | "6M" | "1Y", firstDataAt: number) => {
      const window = resolveWindow({ range, now, firstDataAt, lastDataAt: now - 1_000 });
      return window.end - window.start;
    };
    for (const firstDataAt of [now - 3 * HOUR, now - 9 * DAY, now - 800 * DAY]) {
      expect(span("1D", firstDataAt)).toBe(DAY);
      expect(span("1W", firstDataAt)).toBe(7 * DAY);
      expect(span("1M", firstDataAt)).toBe(30 * DAY);
      expect(span("3M", firstDataAt)).toBe(90 * DAY);
      expect(span("6M", firstDataAt)).toBe(182 * DAY);
      expect(span("1Y", firstDataAt)).toBe(365 * DAY);
    }
  });

  test("ALL covers exactly the data, even when it ended long ago", () => {
    const window = resolveWindow({ range: "ALL", now, firstDataAt: now - 90 * DAY, lastDataAt: now - 10 * DAY });
    expect(window).toEqual({ start: now - 90 * DAY, end: now - 10 * DAY, stale: true });
  });

  test("no data at all keeps the default one-day window up to now", () => {
    expect(resolveWindow({ range: "ALL", now, firstDataAt: null, lastDataAt: null })).toEqual({
      start: now - DAY,
      end: now,
      stale: false,
    });
  });

  test("the axis never collapses even when the last data is the only data", () => {
    const only = now - 2 * DAY;
    const window = resolveWindow({ range: "ALL", now, firstDataAt: only, lastDataAt: only });
    expect(window.end).toBe(only);
    expect(window.end - window.start).toBeGreaterThanOrEqual(10 * MINUTE);
  });
});

describe("sampleCountFor", () => {
  test("about one sample per minute on short spans, never below 48 or above the cap", () => {
    expect(sampleCountFor(10 * MINUTE, 480)).toBe(48);
    expect(sampleCountFor(2 * HOUR, 480)).toBe(120);
    expect(sampleCountFor(DAY, 480)).toBe(480);
    expect(sampleCountFor(365 * DAY, 240)).toBe(240);
  });

  test("garbage in, a sane number out", () => {
    expect(sampleCountFor(Number.NaN, 480)).toBe(48);
    expect(sampleCountFor(-5, 480)).toBe(48);
  });
});

describe("buildTradeProbeTimes", () => {
  const start = 0;
  const end = 10 * DAY;

  test("looks right before and shortly after every close", () => {
    const closeAt = 2 * DAY;
    expect(buildTradeProbeTimes([{ t: closeAt }], start, end)).toEqual([closeAt - 2_000, closeAt + 90_000]);
  });

  test("drops instants that fall outside the window and ignores trades outside it", () => {
    expect(buildTradeProbeTimes([{ t: 1_000 }], start, end)).toEqual([1_000 + 90_000]);
    expect(buildTradeProbeTimes([{ t: end - 10_000 }], start, end)).toEqual([end - 10_000 - 2_000]);
    expect(buildTradeProbeTimes([{ t: -5 }, { t: end + 5 }, { t: Number.NaN }], start, end)).toEqual([]);
  });

  test("sorted and unique, even when trades close together", () => {
    const times = buildTradeProbeTimes([{ t: DAY }, { t: DAY }, { t: DAY + 1_000 }], start, end);
    expect(times).toEqual([...new Set(times)].sort((left, right) => left - right));
    expect(times).toHaveLength(4);
  });

  test("a huge history is thinned evenly instead of flooding the database", () => {
    const trades = Array.from({ length: 5_000 }, (_, index) => ({ t: (index + 1) * 100_000 }));
    const times = buildTradeProbeTimes(trades, start, trades[trades.length - 1].t + HOUR, { maxTrades: 100 });
    expect(times.length).toBeLessThanOrEqual(200);
    expect(times.length).toBeGreaterThan(150);
    // spread over the whole history, not just the first trades
    expect(times[times.length - 1]).toBeGreaterThan(trades[4_000].t);
  });
});

describe("gapThresholdMs", () => {
  test("never below fifteen minutes", () => {
    const dense = Array.from({ length: 50 }, (_, index) => index * 1_000);
    expect(gapThresholdMs(dense, 1_000)).toBe(15 * MINUTE);
  });

  test("scales with the usual spacing: three times the median", () => {
    const hourly = Array.from({ length: 40 }, (_, index) => index * HOUR);
    expect(gapThresholdMs(hourly, MINUTE)).toBe(3 * HOUR);
  });

  test("an outage does not move the median", () => {
    const times = [...Array.from({ length: 20 }, (_, index) => index * 10 * MINUTE), 20 * HOUR];
    expect(gapThresholdMs(times, MINUTE)).toBe(30 * MINUTE);
  });

  test("with too few samples the grid step is used", () => {
    expect(gapThresholdMs([0, HOUR], 2 * HOUR)).toBe(6 * HOUR);
    expect(gapThresholdMs([], 0)).toBe(15 * MINUTE);
  });
});

describe("fillSnapshotGaps", () => {
  const gapMs = 30 * MINUTE;

  test("a recording without gaps gets nothing added", () => {
    const samples = [sample(0, 1_000, 1_000), sample(10 * MINUTE, 1_000, 1_010), sample(20 * MINUTE, 1_000, 1_005)];
    expect(fillSnapshotGaps({ samples, trades: [], gapMs })).toEqual({ samples: [], gapCount: 0 });
  });

  test("a gap without trades holds the last recorded value, flagged, so the join is drawn dotted", () => {
    const before = sample(0, 1_000, 1_020);
    const after = sample(2 * HOUR, 1_000, 1_000);
    const result = fillSnapshotGaps({ samples: [before, after], trades: [], gapMs });
    expect(result.gapCount).toBe(1);
    expect(result.samples).toEqual([
      { t: 1, balance: 1_000, equity: 1_020, margin: null, freeMargin: null, marginLevel: null, estimated: true },
    ]);
  });

  test("closed trades inside the gap move the balance in steps and carry the last floating P&L", () => {
    const before = sample(0, 1_000, 1_020); // floating +20
    const after = sample(6 * HOUR, 1_100, 1_100);
    const trades = [
      { t: HOUR, profit: 50, volume: 1 },
      { t: 3 * HOUR, profit: -10, volume: 1 },
    ];
    const result = fillSnapshotGaps({ samples: [before, after], trades, gapMs });
    expect(result.gapCount).toBe(1);
    expect(result.samples.every((entry) => entry.estimated)).toBe(true);
    expect(result.samples.map((entry) => [entry.t, entry.balance, entry.equity])).toEqual([
      [1, 1_000, 1_020],
      [HOUR - 1, 1_000, 1_020],
      [HOUR, 1_050, 1_070],
      [3 * HOUR - 1, 1_050, 1_070],
      [3 * HOUR, 1_040, 1_060],
    ]);
    // the recorded sample after the gap is not forced to match the estimate
    expect(result.samples[result.samples.length - 1].t).toBeLessThan(after.t);
  });

  test("everything added lies strictly inside the gap and in ascending order", () => {
    const before = sample(1_000, 500, 500);
    const after = sample(1_000 + 4 * HOUR, 560, 560);
    const trades = [
      { t: 1_000, profit: 99, volume: 1 }, // at the left edge: not inside
      { t: 1_000 + HOUR, profit: 30, volume: 1 },
      { t: 1_000 + HOUR, profit: 30, volume: 1 }, // same instant
      { t: 1_000 + 4 * HOUR, profit: 77, volume: 1 }, // at the right edge: not inside
    ];
    const { samples } = fillSnapshotGaps({ samples: [before, after], trades, gapMs });
    for (const entry of samples) {
      expect(entry.t).toBeGreaterThan(before.t);
      expect(entry.t).toBeLessThan(after.t);
    }
    expect(samples.map((entry) => entry.t)).toEqual([...samples.map((entry) => entry.t)].sort((l, r) => l - r));
    // trades closing at the same instant are folded into one step
    const atClose = samples.filter((entry) => entry.t === 1_000 + HOUR);
    expect(atClose).toHaveLength(1);
    expect(atClose[0].balance).toBe(560);
  });

  test("several gaps are bridged independently", () => {
    const samples = [
      sample(0, 100, 100),
      sample(2 * HOUR, 100, 100),
      sample(2 * HOUR + MINUTE, 100, 100),
      sample(6 * HOUR, 100, 100),
    ];
    const result = fillSnapshotGaps({ samples, trades: [], gapMs });
    expect(result.gapCount).toBe(2);
    expect(result.samples.map((entry) => entry.t)).toEqual([1, 2 * HOUR + MINUTE + 1]);
  });

  test("estimated neighbours never count as recorded: only real samples define a gap", () => {
    const samples = [
      sample(0, 100, 100),
      sample(HOUR, 100, 100, { estimated: true }),
      sample(2 * HOUR, 100, 100),
    ];
    // between the two recorded samples there are 2 hours
    expect(fillSnapshotGaps({ samples, trades: [], gapMs }).gapCount).toBe(1);
  });

  test("a gap with very many trades is thinned but keeps its last step", () => {
    const before = sample(0, 1_000, 1_000);
    const after = sample(10 * DAY, 1_000, 1_000);
    // 200 hourly trades, all strictly inside the 240 h gap, 1 unit of profit each
    const trades = Array.from({ length: 200 }, (_, index) => ({ t: (index + 1) * HOUR, profit: 1, volume: 0.1 }));
    const { samples } = fillSnapshotGaps({ samples: [before, after], trades, gapMs, maxPointsPerGap: 40 });
    expect(samples.length).toBeLessThanOrEqual(42);
    expect(samples[samples.length - 1].balance).toBe(1_200);
  });

  test("the input is not modified", () => {
    const samples = [sample(0, 1, 1), sample(5 * HOUR, 2, 2)];
    const copy = JSON.parse(JSON.stringify(samples));
    fillSnapshotGaps({ samples, trades: [{ t: HOUR, profit: 1, volume: 1 }], gapMs });
    expect(samples).toEqual(copy);
  });
});
