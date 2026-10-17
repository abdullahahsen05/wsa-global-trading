import { describe, expect, test } from "vitest";
import {
  deriveSeries,
  summarizeTrades,
  type PerformanceLedgerPoint,
  type PerformanceSample,
  type PerformanceSeriesDto,
} from "@/lib/charts/performanceSeries";
import {
  CHART_TABS,
  MAX_MARKERS,
  buildChartSpec,
  tooltipAt,
  type ChartSpec,
  type ChartTab,
} from "@/lib/charts/performanceChartSpec";

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
  options: { hidden?: Record<string, boolean>; equityPeak?: number | null } = {},
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

  test("equity growth in % and closed P&L as a stepped line, both on the same % axis", () => {
    expect(lineKeys(spec)).toEqual(["equity", "pnl"]);
    expect(values(spec, "equity")).toEqual([0, 10, -1, 20]);
    expect(values(spec, "pnl")).toEqual([0, 5, 5]);
    expect(spec.lines.find((entry) => entry.key === "pnl")).toMatchObject({ step: true, dashed: true });
    expect(spec.lines.find((entry) => entry.key === "equity")).toMatchObject({ step: false, area: true });
  });

  test("the axis is round and the money axis on the right is the same scale times the base", () => {
    expect(spec.ticks).toEqual([-10, 0, 10, 20]);
    expect(spec.ticks.map(spec.formatY)).toEqual(["-10%", "0%", "10%", "20%"]);
    expect(spec.right?.ticks).toEqual([-100, 0, 100, 200]);
    expect(spec.right?.ticks.map(spec.right.formatY)).toEqual(["-$100", "$0", "$100", "$200"]);
    expect(spec.zeroValue).toBe(0);
  });

  test("volume bars are scaled to the busiest bucket", () => {
    expect(spec.bars).toEqual([{ t: 2_400, ratio: 1 }]);
  });

  test("the legend carries the toggles", () => {
    expect(spec.legend.map((item) => [item.key, item.toggleable, item.active])).toEqual([
      ["equity", true, true],
      ["pnl", true, true],
      ["volume", true, true],
      ["markers", true, true],
      ["drawdown", false, true],
    ]);
  });

  test("switching a series off removes it and the axis is rebuilt from what is left", () => {
    const noEquity = specFor(grown, "CHART", { hidden: { equity: true } });
    expect(lineKeys(noEquity)).toEqual(["pnl"]);
    expect(noEquity.ticks).toEqual([0, 2, 4, 6]);
    expect(noEquity.legend.find((item) => item.key === "equity")?.active).toBe(false);

    const noPnl = specFor(grown, "CHART", { hidden: { pnl: true } });
    expect(lineKeys(noPnl)).toEqual(["equity"]);
    expect(noPnl.ticks).toEqual([-10, 0, 10, 20]);

    expect(specFor(grown, "CHART", { hidden: { volume: true } }).bars).toEqual([]);
  });

  test("an account that did not move still gets a visible axis and both lines", () => {
    const flatSpec = specFor(flat, "CHART");
    expect(lineKeys(flatSpec)).toEqual(["equity", "pnl"]);
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
    expect(fallback.right).toBeNull();
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
  test("cumulative closed P&L is a stepped area with traded volume underneath", () => {
    const spec = specFor(grown, "PROFIT");
    expect(values(spec, "pnl")).toEqual([0, 50, 50]);
    expect(spec.lines[0]).toMatchObject({ step: true, area: true });
    expect(spec.bars).toEqual([{ t: 2_400, ratio: 1 }]);
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

  test("one dot per closed trade, coloured by the result and sitting on the equity curve", () => {
    const spec = specFor(withTrades([trade(2_100, 50), trade(3_100, -20)]), "GROWTH");
    expect(spec.markers.map((marker) => [marker.t, marker.kind, marker.profit, marker.count])).toEqual([
      [2_100, "win", 50, 1],
      [3_100, "loss", -20, 1],
    ]);
    // equity growth of the nearest recorded snapshots (2 000 → +10 %, 3 000 → -1 %)
    expect(spec.markers[0].v).toBeCloseTo(10, 6);
    expect(spec.markers[1].v).toBeCloseTo(-1, 6);
  });

  test("a bucket of several trades is a win, a loss or mixed", () => {
    const spec = specFor(withTrades([trade(1_900, 30, 3, 3), trade(2_900, -30, 2, 0), trade(3_900, 5, 4, 2)]), "BALANCE");
    expect(spec.markers.map((marker) => marker.kind)).toEqual(["win", "loss", "mixed"]);
    expect(spec.markers.map((marker) => marker.count)).toEqual([3, 2, 4]);
    // the balance curve at the nearest snapshots
    expect(spec.markers.map((marker) => marker.v)).toEqual([1_000, 1_050, 1_050]);
  });

  test("the dots follow the next visible curve and disappear when no curve is left", () => {
    const dto = withTrades([trade(2_100, 50)]);
    const onEquity = specFor(dto, "BALANCE", { hidden: { balance: true } });
    expect(onEquity.markers.map((marker) => marker.v)).toEqual([1_100]);
    expect(specFor(dto, "BALANCE", { hidden: { balance: true, equity: true } }).markers).toEqual([]);
    expect(specFor(dto, "CHART", { hidden: { equity: true, pnl: true } }).markers).toEqual([]);
  });

  test("the legend toggle switches the dots off and still shows the trade count", () => {
    const dto = withTrades([trade(2_100, 50), trade(3_100, -20)]);
    const on = specFor(dto, "BALANCE");
    expect(on.legend.find((item) => item.key === "markers")).toMatchObject({ toggleable: true, active: true, value: "2" });
    const off = specFor(dto, "BALANCE", { hidden: { markers: true } });
    expect(off.markers).toEqual([]);
    expect(off.legend.find((item) => item.key === "markers")).toMatchObject({ active: false, value: "2" });
  });

  test("long histories are thinned evenly and keep the first and the last trade", () => {
    const many = Array.from({ length: 400 }, (_, index) => trade(1_000 + index * 7, index % 2 === 0 ? 1 : -1));
    const spec = specFor(withTrades(many), "PROFIT");
    expect(spec.markers).toHaveLength(MAX_MARKERS);
    expect(spec.markers[0].t).toBe(many[0].t);
    expect(spec.markers[spec.markers.length - 1].t).toBe(many[many.length - 1].t);
    for (const marker of spec.markers) expect(Number.isFinite(marker.v)).toBe(true);
  });

  test("on the profit tab the dots sit on the stepped closed-P&L line", () => {
    const spec = specFor(grown, "PROFIT");
    expect(spec.markers).toHaveLength(1);
    expect(spec.markers[0]).toMatchObject({ t: 2_500, kind: "win", profit: 50 });
    expect(spec.markers[0].v).toBe(50);
  });

  test("no trade, no dot and no legend entry; drawdown and margin never carry dots", () => {
    const none = specFor(flat, "BALANCE");
    expect(none.markers).toEqual([]);
    expect(none.legend.some((item) => item.key === "markers")).toBe(false);
    expect(specFor(grown, "DRAWDOWN").markers).toEqual([]);
    expect(specFor(grown, "MARGIN").markers).toEqual([]);
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
