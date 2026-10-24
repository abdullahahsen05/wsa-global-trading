import { describe, expect, test } from "vitest";
import {
  deriveSeries,
  summarizeTrades,
  withLiveEquity,
  type PerformanceLedgerPoint,
  type PerformanceSample,
  type PerformanceSeriesDto,
} from "@/lib/charts/performanceSeries";
import {
  CHART_TABS,
  MAX_MARKERS,
  buildChartSpec,
  lineValueAt,
  tooltipAt,
  type ChartSpec,
  type ChartTab,
} from "@/lib/charts/performanceChartSpec";
import { downsampleLttb } from "@/lib/charts/downsample";

function sample(
  t: number,
  balance: number,
  equity: number,
  extra: Partial<PerformanceSample> = {},
): PerformanceSample {
  return { t, balance, equity, margin: null, freeMargin: null, marginLevel: null, estimated: false, ...extra };
}

function dtoOf(samples: PerformanceSample[], ledger: PerformanceLedgerPoint[] = []): PerformanceSeriesDto {
  return {
    accountId: "acc-1",
    currency: "USD",
    range: "ALL",
    generatedAt: 5_000,
    start: 1_000,
    end: 5_000,
    samples,
    ledger,
    stats: summarizeTrades(ledger.map((entry) => ({ t: entry.t, profit: entry.profit, volume: entry.volume }))),
    coverage: {
      firstSnapshotAt: samples[0]?.t ?? null,
      lastSnapshotAt: samples[samples.length - 1]?.t ?? null,
      firstDataAt: samples[0]?.t ?? null,
      lastDataAt: samples[samples.length - 1]?.t ?? null,
      stale: false,
      snapshotSamples: samples.length,
      estimatedSamples: 0,
      gapCount: 0,
      closedTrades: ledger.length,
      tradesTruncated: false,
      marginCaptured: false,
      marginSupported: true,
      mixedCurrencies: false,
      aggregate: false,
      aggregateLimitedToDays: null,
      equityPeak: null,
    },
  };
}

function specFor(
  dto: PerformanceSeriesDto,
  tab: ChartTab,
  options: { hidden?: Record<string, boolean>; equityPeak?: number | null; pointBudget?: number } = {},
): ChartSpec {
  return buildChartSpec({
    derived: deriveSeries(dto),
    ledger: dto.ledger,
    tradeCount: dto.stats.tradeCount,
    tab,
    hidden: options.hidden ?? {},
    currency: "USD",
    barCount: 10,
    currentDrawdownPct: null,
    equityPeak: options.equityPeak ?? null,
    pointBudget: options.pointBudget,
  });
}

/** Growing account with one drawdown and one closed trade. */
const grown = dtoOf(
  [
    sample(1_000, 1_000, 1_000),
    sample(2_000, 1_000, 1_100),
    sample(3_000, 1_050, 990),
    sample(4_000, 1_050, 1_200),
  ],
  [{ t: 2_500, profit: 50, volume: 0.1, count: 1, wins: 1 }],
);

/** The account from the bug report: nothing moved, equity $189,477.75. */
const flat = dtoOf([
  sample(1_000, 189_477.75, 189_477.75),
  sample(3_000, 189_477.75, 189_477.75),
  sample(5_000, 189_477.75, 189_477.75),
]);

const tradesOnly = dtoOf(
  [],
  [
    { t: 2_500, profit: 50, volume: 0.1, count: 1, wins: 1 },
    { t: 3_500, profit: -20, volume: 0.2, count: 1, wins: 0 },
  ],
);

const lineKeys = (spec: ChartSpec) => spec.lines.map((entry) => entry.key);
const values = (spec: ChartSpec, key: string) =>
  spec.lines.find((entry) => entry.key === key)?.points.map((point) => Math.round(point.v * 1000) / 1000);

describe("every tab covers its data with a readable axis", () => {
  test.each(CHART_TABS.map((tab) => tab.id))("%s: all drawn values lie inside the axis and ticks are ascending", (tab) => {
    const margins = dtoOf([
      sample(1_000, 1_000, 1_000, { margin: 100, freeMargin: 900, marginLevel: 1_000 }),
      sample(2_000, 1_000, 1_100, { margin: 200, freeMargin: 900, marginLevel: 550 }),
      sample(3_000, 1_050, 990, { margin: 150, freeMargin: 840, marginLevel: 660 }),
    ]);
    const datasets = tab === "MARGIN" ? [margins] : [grown, flat, margins];
    for (const dto of datasets) {
      const spec = specFor(dto, tab);
      expect(spec.emptyReason).toBeNull();
      expect(spec.yMax).toBeGreaterThan(spec.yMin);
      expect(spec.ticks.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < spec.ticks.length; index += 1) {
        expect(spec.ticks[index]).toBeGreaterThan(spec.ticks[index - 1]);
      }
      for (const entry of spec.lines) {
        for (const point of entry.points) {
          expect(point.v).toBeGreaterThanOrEqual(spec.yMin - 1e-9);
          expect(point.v).toBeLessThanOrEqual(spec.yMax + 1e-9);
          expect(Number.isFinite(point.v)).toBe(true);
        }
      }
    }
  });
});

describe("CHART tab", () => {
  const spec = specFor(grown, "CHART");
  const withExtras = specFor(grown, "CHART", { hidden: { pnl: false, volume: false, markers: false } });

  test("ONE smooth equity-growth curve in % - the closed-P&L line, volume bars and trade dots are extras that start off", () => {
    expect(lineKeys(spec)).toEqual(["equity"]);
    expect(values(spec, "equity")).toEqual([0, 10, -1, 20]);
    expect(spec.lines[0]).toMatchObject({ step: false, dashed: false, area: true, primary: true });
    expect(spec.bars).toEqual([]);
    expect(spec.markers).toEqual([]);
  });

  test("the extras can be switched on: closed P&L (a smooth line on the same % axis), volume bars, trade dots", () => {
    expect(lineKeys(withExtras)).toEqual(["equity", "pnl"]);
    expect(values(withExtras, "pnl")).toEqual([0, 5, 5]);
    expect(withExtras.lines.find((entry) => entry.key === "pnl")).toMatchObject({ step: false, dashed: false, primary: false });
    expect(withExtras.bars).toEqual([{ t: 2_400, ratio: 1 }]);
    expect(withExtras.markers).toHaveLength(1);
  });

  test("the axis is round and it is the ONLY value axis (percent) - no second money axis on the right", () => {
    expect(spec.ticks).toEqual([-10, 0, 10, 20]);
    expect(spec.ticks.map(spec.formatY)).toEqual(["-10%", "0%", "10%", "20%"]);
    expect(spec.axisTitle).toBe("Growth %");
    expect(Object.keys(spec)).not.toContain("right");
    expect(spec.zeroValue).toBe(0);
    // the extra P&L line is drawn in % on that same axis
    expect(withExtras.ticks).toEqual(spec.ticks);
  });

  test("volume bars are scaled to the busiest bucket", () => {
    expect(withExtras.bars).toEqual([{ t: 2_400, ratio: 1 }]);
  });

  test("the legend carries the toggles; the extras are marked as such and are off", () => {
    expect(spec.legend.map((item) => [item.key, item.toggleable, item.active, item.overlay === true])).toEqual([
      ["equity", true, true, false],
      ["pnl", true, false, true],
      ["volume", true, false, true],
      ["markers", true, false, true],
      ["drawdown", false, true, false],
    ]);
    expect(withExtras.legend.map((item) => item.active)).toEqual([true, true, true, true, true]);
  });

  test("switching a series off removes it and the axis is rebuilt from what is left", () => {
    const noEquity = specFor(grown, "CHART", { hidden: { equity: true, pnl: false } });
    expect(lineKeys(noEquity)).toEqual(["pnl"]);
    expect(noEquity.lines[0].primary).toBe(true);
    expect(noEquity.ticks).toEqual([0, 2, 4, 6]);
    expect(noEquity.legend.find((item) => item.key === "equity")?.active).toBe(false);

    const noPnl = specFor(grown, "CHART", { hidden: { pnl: true } });
    expect(lineKeys(noPnl)).toEqual(["equity"]);
    expect(noPnl.ticks).toEqual([-10, 0, 10, 20]);

    expect(specFor(grown, "CHART", { hidden: { volume: true } }).bars).toEqual([]);
  });

  test("an account that did not move still gets a visible axis and its line", () => {
    const flatSpec = specFor(flat, "CHART");
    expect(lineKeys(flatSpec)).toEqual(["equity"]);
    expect(flatSpec.yMin).toBeLessThan(0);
    expect(flatSpec.yMax).toBeGreaterThan(0);
    expect(values(flatSpec, "equity")).toEqual([0, 0, 0]);
  });

  test("without any balance snapshot it falls back to closed P&L in money instead of a 0% line", () => {
    const fallback = specFor(tradesOnly, "CHART");
    expect(fallback.missingSnapshots).toBe(true);
    expect(fallback.emptyReason).toBeNull();
    expect(lineKeys(fallback)).toEqual(["pnl"]);
    expect(values(fallback, "pnl")).toEqual([0, 50, 30, 30]);
    expect(Object.keys(fallback)).not.toContain("right");
    expect(fallback.axisTitle).toBe("Closed P&L");
    expect(fallback.ticks.map(fallback.formatY)[0]).toBe("$0");
  });

  test("no snapshot and no trade is an explicit empty state, not a drawing", () => {
    const empty = specFor(dtoOf([]), "CHART");
    expect(empty.emptyReason).toBe("NO_DATA");
    expect(empty.lines).toEqual([]);
    expect(empty.bars).toEqual([]);
  });
});

describe("GROWTH and BALANCE tabs", () => {
  test("growth shows equity and balance growth against the first point", () => {
    const spec = specFor(grown, "GROWTH");
    expect(lineKeys(spec)).toEqual(["balance", "equity"]);
    expect(values(spec, "balance")).toEqual([0, 0, 5, 5]);
    expect(values(spec, "equity")).toEqual([0, 10, -1, 20]);
    // the last entry is the trade-marker count (one closed trade)
    expect(spec.legend.map((item) => item.value)).toEqual(["+20.00%", "+5.00%", "1"]);
  });

  test("balance shows both curves in money on a scale that fits them", () => {
    const spec = specFor(grown, "BALANCE");
    expect(values(spec, "equity")).toEqual([1_000, 1_100, 990, 1_200]);
    expect(values(spec, "balance")).toEqual([1_000, 1_000, 1_050, 1_050]);
    expect(spec.ticks).toEqual([900, 1_000, 1_100, 1_200]);
    expect(spec.ticks.map(spec.formatY)).toEqual(["$900", "$1,000", "$1,100", "$1,200"]);
    expect(spec.legend.map((item) => item.value)).toEqual(["$1,050.00", "$1,200.00", "1"]);
  });

  test("a flat $189,477.75 account is drawn on its own tight scale, not collapsed", () => {
    const spec = specFor(flat, "BALANCE");
    expect(spec.yMin).toBeLessThan(189_477.75);
    expect(spec.yMax).toBeGreaterThan(189_477.75);
    expect(spec.yMax - spec.yMin).toBeLessThan(5_000);
    expect(spec.ticks.map(spec.formatY).every((label) => label.startsWith("$189,") || label.startsWith("$190,"))).toBe(true);
  });

  test("hiding a curve narrows the axis to the other one", () => {
    const spec = specFor(grown, "BALANCE", { hidden: { equity: true } });
    expect(lineKeys(spec)).toEqual(["balance"]);
    expect(spec.yMin).toBeGreaterThanOrEqual(1_000);
    expect(spec.yMax).toBeLessThanOrEqual(1_100);
  });

  test("both tabs need snapshots and say so", () => {
    expect(specFor(tradesOnly, "GROWTH").emptyReason).toBe("NO_SNAPSHOTS");
    expect(specFor(tradesOnly, "BALANCE").emptyReason).toBe("NO_SNAPSHOTS");
  });
});

describe("PROFIT tab", () => {
  test("cumulative closed P&L is a smooth area; the traded volume underneath is an extra that starts off", () => {
    const spec = specFor(grown, "PROFIT");
    expect(values(spec, "pnl")).toEqual([0, 50, 50]);
    expect(spec.lines[0]).toMatchObject({ step: false, dashed: false, area: true, primary: true });
    expect(spec.bars).toEqual([]);
    expect(specFor(grown, "PROFIT", { hidden: { volume: false } }).bars).toEqual([{ t: 2_400, ratio: 1 }]);
    expect(spec.ticks).toEqual([0, 20, 40, 60]);
    expect(spec.legend[0].value).toBe("$50.00");
  });

  test("works from trades alone and shows losses below zero", () => {
    const spec = specFor(tradesOnly, "PROFIT");
    expect(values(spec, "pnl")).toEqual([0, 50, 30, 30]);
    expect(spec.emptyReason).toBeNull();
  });

  test("an account without any profit gets a small readable axis around zero with round money labels", () => {
    const spec = specFor(flat, "PROFIT");
    expect(values(spec, "pnl")).toEqual([0, 0]);
    expect(spec.yMin).toBeLessThan(0);
    expect(spec.yMax).toBeGreaterThan(0);
    // 2.5 must never be printed as "$3"
    expect(spec.ticks.map(spec.formatY)).toEqual(["-$5.0", "-$2.5", "$0", "$2.5", "$5.0"]);
  });

  test("losing money draws below the zero line", () => {
    const spec = specFor(
      dtoOf([sample(1_000, 1_000, 1_000)], [{ t: 2_000, profit: -120, volume: 1, count: 1, wins: 0 }]),
      "PROFIT",
    );
    expect(values(spec, "pnl")).toEqual([0, -120, -120]);
    expect(spec.yMin).toBeLessThan(-120 + 1e-9);
    expect(spec.yMax).toBeGreaterThanOrEqual(0);
  });

  test("switching the curve off leaves a zero-based axis", () => {
    const spec = specFor(grown, "PROFIT", { hidden: { pnl: true } });
    expect(spec.lines).toEqual([]);
    expect(spec.yMin).toBeLessThan(0);
    expect(spec.yMax).toBeGreaterThan(0);
  });
});

describe("DRAWDOWN tab", () => {
  test("values hang below zero and the axis ends at zero", () => {
    const spec = specFor(grown, "DRAWDOWN", { equityPeak: 1_200 });
    expect(values(spec, "drawdown")).toEqual([0, 0, -10, 0]);
    expect(spec.yMax).toBe(0);
    expect(spec.yMin).toBe(-10);
    expect(spec.ticks).toEqual([-10, -7.5, -5, -2.5, 0]);
    expect(spec.ticks.map(spec.formatY)).toEqual(["-10.0%", "-7.5%", "-5.0%", "-2.5%", "0%"]);
  });

  test("the legend reports current drawdown, deepest fall in the range and the all-time peak", () => {
    const spec = specFor(grown, "DRAWDOWN", { equityPeak: 1_200 });
    expect(spec.legend.map((item) => [item.key, item.value])).toEqual([
      ["current", "0.0%"],
      ["max", "10.0%"],
      ["peak", "$1,200.00"],
    ]);
    expect(specFor(grown, "DRAWDOWN").legend[2].value).toBe("—");
  });

  test("an account with no drawdown gets a readable scale that still ends at zero", () => {
    const spec = specFor(flat, "DRAWDOWN");
    expect(values(spec, "drawdown")).toEqual([0, 0, 0]);
    expect(spec.yMax).toBe(0);
    expect(spec.yMin).toBeLessThanOrEqual(-1);
  });

  test("the live drawdown handed in by the page wins over the one derived from the range", () => {
    const spec = buildChartSpec({
      derived: deriveSeries(grown),
      ledger: grown.ledger,
      tradeCount: 1,
      tab: "DRAWDOWN",
      hidden: {},
      currency: "USD",
      barCount: 10,
      currentDrawdownPct: 5.3,
      equityPeak: null,
    });
    expect(spec.legend[0].value).toBe("5.3%");
  });
});

describe("MARGIN tab", () => {
  const withMargin = dtoOf([
    sample(1_000, 1_000, 1_000, { margin: 100, freeMargin: 900, marginLevel: 1_000 }),
    sample(2_000, 1_000, 1_100, { margin: 200, freeMargin: 900, marginLevel: 550 }),
    sample(3_000, 1_000, 990, { margin: null, freeMargin: null, marginLevel: null }),
  ]);

  test("draws only the snapshots that carry margin", () => {
    const spec = specFor(withMargin, "MARGIN");
    expect(lineKeys(spec)).toEqual(["free", "used"]);
    expect(values(spec, "used")).toEqual([100, 200]);
    expect(values(spec, "free")).toEqual([900, 900]);
    expect(spec.yMin).toBe(0);
    expect(spec.yMax).toBeGreaterThanOrEqual(900);
  });

  test("shows the margin level of the latest snapshot or a dash when it has none", () => {
    expect(specFor(withMargin, "MARGIN").legend.find((item) => item.key === "level")?.value).toBe("—");
    const recent = dtoOf([sample(1_000, 1_000, 1_000, { margin: 100, freeMargin: 900, marginLevel: 1_000 })]);
    expect(specFor(recent, "MARGIN").legend.find((item) => item.key === "level")?.value).toBe("1000%");
  });

  test("hiding free margin zooms in on used margin", () => {
    const spec = specFor(withMargin, "MARGIN", { hidden: { free: true } });
    expect(lineKeys(spec)).toEqual(["used"]);
    expect(spec.yMax).toBeLessThan(900);
  });

  test("no margin stored yet is an explicit empty state", () => {
    expect(specFor(grown, "MARGIN").emptyReason).toBe("NO_MARGIN");
    expect(specFor(tradesOnly, "MARGIN").emptyReason).toBe("NO_SNAPSHOTS");
  });
});

describe("trade markers", () => {
  const trade = (
    t: number,
    profit: number,
    count = 1,
    wins = profit >= 0 ? count : 0,
  ): PerformanceLedgerPoint => ({ t, profit, volume: 0.1, count, wins });
  const withTrades = (ledger: PerformanceLedgerPoint[]) => dtoOf([...grown.samples], ledger);

  // (the dots are an extra: they stay off until the person switches them on)
  const dotsOn = { markers: false };

  test("the dots start off, and the trade count is still in the legend", () => {
    const spec = specFor(withTrades([trade(2_100, 50), trade(3_100, -20)]), "GROWTH");
    expect(spec.markers).toEqual([]);
    expect(spec.legend.find((item) => item.key === "markers")).toMatchObject({ toggleable: true, active: false, value: "2", overlay: true });
  });

  test("one dot per closed trade, coloured by the result and sitting on the equity curve", () => {
    const spec = specFor(withTrades([trade(2_100, 50), trade(3_100, -20)]), "GROWTH", { hidden: dotsOn });
    expect(spec.markers.map((marker) => [marker.t, marker.kind, marker.profit, marker.count])).toEqual([
      [2_100, "win", 50, 1],
      [3_100, "loss", -20, 1],
    ]);
    // equity growth of the nearest recorded snapshots (2 000 → +10 %, 3 000 → -1 %)
    expect(spec.markers[0].v).toBeCloseTo(10, 6);
    expect(spec.markers[1].v).toBeCloseTo(-1, 6);
  });

  test("a bucket of several trades is a win, a loss or mixed", () => {
    const spec = specFor(withTrades([trade(1_900, 30, 3, 3), trade(2_900, -30, 2, 0), trade(3_900, 5, 4, 2)]), "BALANCE", {
      hidden: dotsOn,
    });
    expect(spec.markers.map((marker) => marker.kind)).toEqual(["win", "loss", "mixed"]);
    expect(spec.markers.map((marker) => marker.count)).toEqual([3, 2, 4]);
    // the balance curve at the nearest snapshots
    expect(spec.markers.map((marker) => marker.v)).toEqual([1_000, 1_050, 1_050]);
  });

  test("the dots follow the next visible curve and disappear when no curve is left", () => {
    const dto = withTrades([trade(2_100, 50)]);
    const onEquity = specFor(dto, "BALANCE", { hidden: { ...dotsOn, balance: true } });
    expect(onEquity.markers.map((marker) => marker.v)).toEqual([1_100]);
    expect(specFor(dto, "BALANCE", { hidden: { ...dotsOn, balance: true, equity: true } }).markers).toEqual([]);
    expect(specFor(dto, "CHART", { hidden: { ...dotsOn, equity: true, pnl: true } }).markers).toEqual([]);
  });

  test("the legend toggle switches the dots on and off and still shows the trade count", () => {
    const dto = withTrades([trade(2_100, 50), trade(3_100, -20)]);
    const on = specFor(dto, "BALANCE", { hidden: dotsOn });
    expect(on.legend.find((item) => item.key === "markers")).toMatchObject({ toggleable: true, active: true, value: "2" });
    const off = specFor(dto, "BALANCE", { hidden: { markers: true } });
    expect(off.markers).toEqual([]);
    expect(off.legend.find((item) => item.key === "markers")).toMatchObject({ active: false, value: "2" });
  });

  test("long histories are thinned evenly and keep the first and the last trade", () => {
    const many = Array.from({ length: 400 }, (_, index) => trade(1_000 + index * 7, index % 2 === 0 ? 1 : -1));
    const spec = specFor(withTrades(many), "PROFIT", { hidden: dotsOn });
    expect(spec.markers).toHaveLength(MAX_MARKERS);
    expect(spec.markers[0].t).toBe(many[0].t);
    expect(spec.markers[spec.markers.length - 1].t).toBe(many[many.length - 1].t);
    for (const marker of spec.markers) expect(Number.isFinite(marker.v)).toBe(true);
  });

  test("on the profit tab the dots sit on the closed-P&L line", () => {
    const spec = specFor(grown, "PROFIT", { hidden: dotsOn });
    expect(spec.markers).toHaveLength(1);
    expect(spec.markers[0]).toMatchObject({ t: 2_500, kind: "win", profit: 50 });
    expect(spec.markers[0].v).toBe(50);
  });

  test("no trade, no dot and no legend entry; drawdown and margin never carry dots", () => {
    const none = specFor(flat, "BALANCE", { hidden: dotsOn });
    expect(none.markers).toEqual([]);
    expect(none.legend.some((item) => item.key === "markers")).toBe(false);
    expect(specFor(grown, "DRAWDOWN", { hidden: dotsOn }).markers).toEqual([]);
    expect(specFor(grown, "MARGIN", { hidden: dotsOn }).markers).toEqual([]);
  });
});

describe("a long recording is drawn as a curve, not a hairy line", () => {
  // 600 readings, a small wobble on a slow climb and ONE spike
  const readings = Array.from({ length: 600 }, (_, index) =>
    sample(1_000 + index * 6, 10_000, 10_000 + index * 0.5 + (index % 5) - (index === 300 ? -400 : 0)),
  );
  const long = dtoOf(readings);

  test("each line keeps at most the point budget, the first and the last reading and a subset in time order", () => {
    const spec = specFor(long, "BALANCE", { pointBudget: 80 });
    const times = new Set(readings.map((entry) => entry.t));
    for (const entry of spec.lines) {
      expect(entry.points.length).toBeLessThanOrEqual(80);
      expect(entry.points[0].t).toBe(readings[0].t);
      expect(entry.points[entry.points.length - 1].t).toBe(readings[readings.length - 1].t);
      for (let index = 0; index < entry.points.length; index += 1) {
        expect(times.has(entry.points[index].t)).toBe(true);
        if (index > 0) expect(entry.points[index].t).toBeGreaterThan(entry.points[index - 1].t);
      }
    }
  });

  test("the spike that matters to the shape survives the thinning, and the axis still holds it", () => {
    const spec = specFor(long, "BALANCE", { pointBudget: 80 });
    const equity = spec.lines.find((entry) => entry.key === "equity");
    expect(equity?.points.some((point) => point.t === 1_000 + 300 * 6)).toBe(true);
    expect(spec.yMax).toBeGreaterThanOrEqual(Math.max(...readings.map((entry) => entry.equity)));
  });

  test("nothing is thinned when the line is short enough, and a silly budget is raised to a usable minimum", () => {
    expect(specFor(grown, "BALANCE").lines[0].points).toHaveLength(4);
    expect(specFor(long, "BALANCE", { pointBudget: 3 }).lines[0].points.length).toBeLessThanOrEqual(40);
    expect(specFor(long, "BALANCE", { pointBudget: 3 }).lines[0].points.length).toBeGreaterThan(3);
  });
});

describe("downsampleLttb", () => {
  const xOf = (item: { x: number; y: number }) => item.x;
  const yOf = (item: { x: number; y: number }) => item.y;
  const series = Array.from({ length: 1_000 }, (_, index) => ({ x: index, y: index === 500 ? 100 : Math.sin(index / 40) }));

  test("short input is returned as it is (a copy), and a budget below three changes nothing", () => {
    const short = series.slice(0, 10);
    const result = downsampleLttb(short, 50, xOf, yOf);
    expect(result).toEqual(short);
    expect(result).not.toBe(short);
    expect(downsampleLttb(series, 2, xOf, yOf)).toHaveLength(series.length);
    expect(downsampleLttb(series, Number.NaN, xOf, yOf)).toHaveLength(series.length);
  });

  test("keeps the first and the last point, exactly the budget of points, in order, none invented", () => {
    const result = downsampleLttb(series, 60, xOf, yOf);
    expect(result).toHaveLength(60);
    expect(result[0]).toBe(series[0]);
    expect(result[59]).toBe(series[999]);
    for (let index = 1; index < result.length; index += 1) expect(result[index].x).toBeGreaterThan(result[index - 1].x);
    for (const item of result) expect(series[item.x]).toBe(item);
  });

  test("a lone spike is kept - that is what the triangles are for", () => {
    expect(downsampleLttb(series, 60, xOf, yOf).some((item) => item.y === 100)).toBe(true);
  });

  test("bad numbers do not break it", () => {
    const dirty = Array.from({ length: 200 }, (_, index) => ({ x: index, y: index === 50 ? Number.NaN : index }));
    expect(downsampleLttb(dirty, 30, xOf, yOf)).toHaveLength(30);
  });
});

describe("the live end of the curve", () => {
  // grown: the last snapshot is at t = 4_000 (equity 1_200 = +20 %), the axis ends at 5_000
  const base = deriveSeries(grown);

  test("a live reading becomes the last point, at the end of the axis, and growth continues from the last snapshot", () => {
    const live = withLiveEquity(base, 1_260, false);
    expect(live).not.toBe(base);
    expect(live.points).toHaveLength(base.points.length + 1);
    expect(live.latest).toMatchObject({ t: 5_000, equity: 1_260, balance: 1_050, estimated: false, margin: null });
    expect(live.equityGrowthPct).toBeCloseTo(26, 6);
    expect(live.currentDrawdownPct).toBe(0);
    // the recorded points are untouched
    expect(live.points.slice(0, base.points.length)).toEqual(base.points);
    // the original series was not changed
    expect(base.points).toHaveLength(4);
  });

  test("below the highest point the drawdown is measured against the peak so far", () => {
    const live = withLiveEquity(base, 1_100, false);
    expect(live.equityGrowthPct).toBeCloseTo(10, 6);
    expect(live.currentDrawdownPct).toBeCloseTo(((1.2 - 1.1) / 1.2) * 100, 6);
    expect(live.maxDrawdownPct).toBeGreaterThanOrEqual(live.currentDrawdownPct);
  });

  test("nothing is added while the recording is stale, or for a reading that is not a usable number or not a move", () => {
    expect(withLiveEquity(base, 1_260, true)).toBe(base);
    expect(withLiveEquity(base, null, false)).toBe(base);
    expect(withLiveEquity(base, Number.NaN, false)).toBe(base);
    expect(withLiveEquity(base, 0, false)).toBe(base);
    expect(withLiveEquity(base, -5, false)).toBe(base);
    // more than a doubling / halving against the last snapshot is a different account value, not a move
    expect(withLiveEquity(base, 3_000, false)).toBe(base);
    expect(withLiveEquity(base, 500, false)).toBe(base);
    // nothing to continue from
    expect(withLiveEquity(deriveSeries(dtoOf([])), 1_000, false)).toEqual(deriveSeries(dtoOf([])));
  });

  test("a reading within a second of the last snapshot replaces it instead of standing next to it", () => {
    // (the axis ends 500 ms after the last snapshot)
    const near = deriveSeries({ ...grown, end: 4_500, generatedAt: 4_500 });
    const live = withLiveEquity(near, 1_210, false);
    expect(live.points).toHaveLength(near.points.length);
    expect(live.latest).toMatchObject({ t: 4_000, equity: 1_210 });
  });
});

describe("lineValueAt (where the hover dot sits on the drawn curve)", () => {
  const line = [
    { t: 1_000, v: 0 },
    { t: 2_000, v: 10 },
    { t: 4_000, v: -10 },
  ];

  test("a point's own value, the straight-line value between two points, nothing outside the line", () => {
    expect(lineValueAt(line, 2_000)).toBe(10);
    expect(lineValueAt(line, 1_500)).toBe(5);
    expect(lineValueAt(line, 3_000)).toBe(0);
    expect(lineValueAt(line, 999)).toBeNull();
    expect(lineValueAt(line, 4_001)).toBeNull();
    expect(lineValueAt([], 1_000)).toBeNull();
    expect(lineValueAt([{ t: 5, v: 7 }], 5)).toBe(7);
  });
});

describe("tooltips", () => {
  const derived = deriveSeries(grown);
  const at = (tab: ChartTab, time: number) => tooltipAt({ derived, tab, time, currency: "USD" });
  const row = (tab: ChartTab, time: number, label: string) =>
    at(tab, time)?.rows.find((entry) => entry.label === label)?.value;

  test("the chart tab reports the nearest snapshot and the closed P&L known at that moment", () => {
    expect(row("CHART", 2_100, "Equity")).toBe("$1,100.00");
    expect(row("CHART", 2_100, "Equity growth")).toBe("+10.00%");
    expect(row("CHART", 2_100, "Balance")).toBe("$1,000.00");
    expect(row("CHART", 2_100, "Closed P&L")).toBe("$0.00");
    expect(row("CHART", 2_900, "Closed P&L")).toBe("$50.00");
  });

  test("growth, balance and drawdown tabs", () => {
    expect(row("GROWTH", 3_000, "Equity growth")).toBe("-1.00%");
    expect(row("GROWTH", 3_000, "Balance growth")).toBe("+5.00%");
    expect(row("BALANCE", 3_000, "Floating P&L")).toBe("-$60.00");
    expect(row("DRAWDOWN", 3_000, "Drawdown")).toBe("10.00%");
  });

  test("the profit tab follows the time continuously and never reads from the future", () => {
    expect(at("PROFIT", 500)).toBeNull();
    expect(row("PROFIT", 2_499, "Closed P&L")).toBe("$0.00");
    expect(row("PROFIT", 2_600, "Closed P&L")).toBe("$50.00");
    expect(row("PROFIT", 2_600, "Growth")).toBe("+5.00%");
  });

  test("margin values the snapshot did not store are dashes, not zeros", () => {
    expect(at("MARGIN", 3_000)?.rows.map((entry) => entry.value)).toEqual(["—", "—", "—"]);
  });

  test("snapshot tooltips mark estimated points", () => {
    const estimated = deriveSeries(
      dtoOf([sample(1_000, 100, 100, { estimated: true }), sample(2_000, 100, 101)]),
    );
    expect(tooltipAt({ derived: estimated, tab: "BALANCE", time: 1_000, currency: "USD" })?.estimated).toBe(true);
    expect(tooltipAt({ derived: estimated, tab: "BALANCE", time: 2_000, currency: "USD" })?.estimated).toBe(false);
  });

  test("without snapshots the chart tab reads the P&L tooltip and has no growth figure to show", () => {
    const onlyTrades = deriveSeries(tradesOnly);
    const tip = tooltipAt({ derived: onlyTrades, tab: "CHART", time: 3_000, currency: "USD" });
    expect(tip?.rows.map((entry) => entry.label)).toEqual(["Closed P&L"]);
    expect(tip?.rows[0].value).toBe("$50.00");
    expect(tooltipAt({ derived: onlyTrades, tab: "GROWTH", time: 3_000, currency: "USD" })).toBeNull();
  });
});
