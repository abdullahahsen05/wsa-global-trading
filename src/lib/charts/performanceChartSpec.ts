import { downsampleLttb } from "./downsample";
import {
  bucketLedgerForBars,
  formatAxisMoney,
  formatAxisPercent,
  formatSignedPercent,
  formatTooltipTime,
  lastIndexAtOrBefore,
  nearestIndexByTime,
  niceScale,
  type DerivedSeries,
  type PerformanceLedgerPoint,
} from "./performanceSeries";

/**
 * Turns derived account data into a drawable chart description for each tab
 * (Chart / Growth / Balance / Profit / Drawdown / Margin). Pure - no React and
 * no DOM - so the axis logic can be unit tested.
 *
 * The look is Myfxbook's: ONE clean smooth curve on two axes (time and a single value axis), nothing else by
 * default. The extras - closed-P&L line, volume bars, one dot per trade - exist but are switched off until the person
 * switches them on (`DEFAULT_OFF`). Lines are thinned to what the width can show (`pointBudget`, Largest-Triangle-
 * Three-Buckets: real points only) so a long recording is a curve, not a hairy line.
 */

export type ChartTab = "CHART" | "GROWTH" | "BALANCE" | "PROFIT" | "DRAWDOWN" | "MARGIN";

export const CHART_TABS: ReadonlyArray<{ id: ChartTab; label: string }> = [
  { id: "CHART", label: "Chart" },
  { id: "GROWTH", label: "Growth" },
  { id: "BALANCE", label: "Balance" },
  { id: "PROFIT", label: "Profit" },
  { id: "DRAWDOWN", label: "Drawdown" },
  { id: "MARGIN", label: "Margin" },
];

export const CHART_COLORS = {
  equity: "#21d19f",
  gold: "#ffcf00",
  danger: "#ff5f56",
  volume: "rgba(255,207,0,0.26)",
} as const;

export interface ChartPoint {
  t: number;
  v: number;
  estimated?: boolean;
}

export interface ChartLine {
  key: string;
  label: string;
  color: string;
  points: ChartPoint[];
  area: boolean;
  dashed: boolean;
  /** hold the value until the next point (no tab uses it any more: every curve is smooth) */
  step: boolean;
  width: number;
  /** the line the chart is about: it gets the filled area and the dot on its latest value */
  primary: boolean;
}

export interface ChartBar {
  t: number;
  /** 0..1 relative height */
  ratio: number;
}

/** A closed trade (or a bucket of them) drawn as a dot on the curve. */
export interface ChartMarker {
  t: number;
  v: number;
  /** win / loss for one trade; mixed when a bucket of trades holds both */
  kind: "win" | "loss" | "mixed";
  count: number;
  profit: number;
}

export interface ChartLegendItem {
  key: string;
  label: string;
  helper: string;
  color: string;
  toggleable: boolean;
  active: boolean;
  /** shown next to the label */
  value?: string;
  /** an extra on top of the curve (closed P&L line, volume bars, trade dots): the last curve of a tab can not be switched off, an extra can */
  overlay?: boolean;
}

export type ChartEmptyReason = "NO_DATA" | "NO_SNAPSHOTS" | "NO_MARGIN" | null;

export interface ChartSpec {
  tab: ChartTab;
  yMin: number;
  yMax: number;
  ticks: number[];
  step: number;
  axisTitle: string;
  formatY: (value: number) => string;
  // One value axis only (plus the time axis): the % axis on the Chart / Growth / Drawdown views, money on the
  // views that are explicitly in money. There is no second, right-hand money axis any more - it made the Chart
  // view read as three axes and pushed the plot narrower.
  lines: ChartLine[];
  bars: ChartBar[];
  /** closed trades on the curve (empty when switched off or nothing to attach them to) */
  markers: ChartMarker[];
  barColor: string;
  /** value at which a zero reference line is drawn, when inside the domain */
  zeroValue: number | null;
  legend: ChartLegendItem[];
  emptyReason: ChartEmptyReason;
  /** true when the tab has lines to draw but at least one has no snapshots */
  missingSnapshots: boolean;
}

export interface BuildSpecInput {
  derived: DerivedSeries;
  ledger: PerformanceLedgerPoint[];
  tradeCount: number;
  tab: ChartTab;
  /**
   * What the person chose per series key: `true` = switched off, `false` = switched on. A key that is not here
   * has its default (everything on, except the extras in `DEFAULT_OFF`).
   */
  hidden: Record<string, boolean>;
  currency: string;
  barCount: number;
  currentDrawdownPct: number | null;
  equityPeak: number | null;
  /** at most this many points per line are drawn (the width of the plot / 4 is a good value); default 240 */
  pointBudget?: number;
}

/** Extras that stay off until the person asks for them. (The closed-P&L line is only an extra on the Chart tab: it IS the Profit tab.) */
export const DEFAULT_OFF_KEYS: ReadonlyArray<string> = ["volume", "markers"];
export const DEFAULT_POINT_BUDGET = 240;
const MIN_POINT_BUDGET = 40;

function range(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function line(
  key: string,
  label: string,
  color: string,
  points: ChartPoint[],
  options: { area?: boolean; dashed?: boolean; step?: boolean; width?: number; primary?: boolean } = {},
): ChartLine {
  return {
    key,
    label,
    color,
    points,
    area: options.area ?? false,
    dashed: options.dashed ?? false,
    step: options.step ?? false,
    width: options.width ?? 2.25,
    primary: options.primary ?? false,
  };
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.round(value * 100) === 0 ? 0 : value);
}

function percent(value: number, digits = 2): string {
  return `${value.toFixed(digits)}%`;
}

/** More dots than this make the curve unreadable; keep an even selection. */
export const MAX_MARKERS = 150;

function thinEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const result: T[] = [];
  for (let index = 0; index < max; index += 1) {
    result.push(items[Math.floor((index * (items.length - 1)) / (max - 1))]);
  }
  return result;
}

export function buildChartSpec(input: BuildSpecInput): ChartSpec {
  const { derived, ledger, tab, hidden, currency } = input;
  // what the person chose wins; otherwise a series is on - except the extras
  const defaultOff = (key: string): boolean => DEFAULT_OFF_KEYS.includes(key) || (tab === "CHART" && key === "pnl");
  const on = (key: string): boolean => (hidden[key] === undefined ? !defaultOff(key) : hidden[key] !== true);
  // (only real points are kept; the shape of each line decides which)
  const budget = Math.max(MIN_POINT_BUDGET, Math.floor(input.pointBudget ?? DEFAULT_POINT_BUDGET));
  const thin = (items: ChartPoint[]): ChartPoint[] =>
    downsampleLttb(items, budget, (item) => item.t, (item) => item.v);
  const points = derived.points;
  const hasPoints = points.length > 0;
  const hasTrades = input.tradeCount > 0;

  const empty: ChartSpec = {
    tab,
    yMin: -1,
    yMax: 1,
    ticks: [-1, -0.5, 0, 0.5, 1],
    step: 0.5,
    axisTitle: "",
    formatY: (value) => String(value),
    lines: [],
    bars: [],
    markers: [],
    barColor: CHART_COLORS.volume,
    zeroValue: null,
    legend: [],
    emptyReason: null,
    missingSnapshots: false,
  };

  if (!hasPoints && !hasTrades) return { ...empty, emptyReason: "NO_DATA" };

  const volumeBars = (domainAxis: boolean): ChartBar[] => {
    if (!domainAxis) return [];
    // Buckets are as wide as on a full-length axis, counted from where the history
    // begins: a period that is wider than the history does not squeeze every bar
    // into a few buckets at its right edge.
    const axisSpan = Math.max(1, derived.end - derived.start);
    const historySpan = Math.max(1, derived.end - derived.historyStart);
    const barCount = Math.max(
      4,
      Math.min(input.barCount, Math.round((input.barCount * historySpan) / axisSpan)),
    );
    const bars = bucketLedgerForBars(ledger, derived.historyStart, derived.end, barCount);
    const maxVolume = Math.max(0, ...bars.map((bar) => bar.volume));
    if (maxVolume <= 0) return [];
    return bars
      .filter((bar) => bar.volume > 0)
      .map((bar) => ({ t: bar.t, ratio: bar.volume / maxVolume }));
  };

  // Closed trades as dots on the curve. `valueAt` says where on the visible host
  // line a trade belongs; no host line (hidden) means no dots.
  const markersOn = on("markers") && ledger.length > 0;
  const buildMarkers = (valueAt: ((time: number) => number | null) | null): ChartMarker[] => {
    if (!markersOn || !valueAt) return [];
    const entries = thinEvenly(
      ledger.filter((entry) => Number.isFinite(entry.t) && Number.isFinite(entry.profit)),
      MAX_MARKERS,
    );
    const result: ChartMarker[] = [];
    for (const entry of entries) {
      const v = valueAt(entry.t);
      if (v === null || !Number.isFinite(v)) continue;
      const kind: ChartMarker["kind"] =
        entry.count > 1
          ? entry.wins === entry.count
            ? "win"
            : entry.wins === 0
              ? "loss"
              : "mixed"
          : entry.profit >= 0
            ? "win"
            : "loss";
      result.push({ t: entry.t, v, kind, count: entry.count, profit: entry.profit });
    }
    return result;
  };
  const markersLegend = (): ChartLegendItem[] =>
    ledger.length > 0
      ? [
          {
            key: "markers",
            label: "Trade markers",
            helper: "One dot per closed trade",
            color: "bg-accent-2",
            toggleable: true,
            active: on("markers"),
            value: String(input.tradeCount),
            overlay: true,
          },
        ]
      : [];
  const pointTimes = points.map((point) => point.t);
  const pnlTimes = derived.pnl.map((entry) => entry.t);
  const onPoints = (read: (index: number) => number) => (time: number): number | null => {
    const index = nearestIndexByTime(pointTimes, time);
    return index >= 0 ? read(index) : null;
  };
  const onPnl = (read: (index: number) => number) => (time: number): number | null => {
    const index = lastIndexAtOrBefore(pnlTimes, time);
    return index >= 0 ? read(index) : null;
  };

  const drawdownCurrent = input.currentDrawdownPct ?? derived.currentDrawdownPct;

  // Cumulative closed P&L in money + volume bars. It is the PROFIT tab, and also
  // what the CHART tab can honestly show when no balance snapshot exists in the
  // range (without a first balance there is no base to express growth in %).
  const profitSpec = (): ChartSpec => {
    const pnl = derived.pnl.map((point) => ({ t: point.t, v: point.cum }));
    // (here the P&L curve IS the chart, also when it stands in for the Chart tab: only an explicit "off" hides it)
    const pnlOn = hidden["pnl"] !== true;
    const values: number[] = pnlOn ? pnl.map((point) => point.v) : [0];
    const { min, max } = range(values);
    const reference = Math.max(Math.abs(min), Math.abs(max));
    const scale = niceScale(min, max, { includeZero: true, minSpan: Math.max(reference * 0.1, 10) });
    return {
      ...empty,
      yMin: scale.min,
      yMax: scale.max,
      ticks: scale.ticks,
      step: scale.step,
      axisTitle: "Closed P&L",
      formatY: (value) => formatAxisMoney(value, currency, scale.step),
      lines: pnlOn
        ? [line("pnl", "Closed P&L", CHART_COLORS.gold, thin(pnl), { area: true, width: 2.5, primary: true })]
        : [],
      bars: on("volume") ? volumeBars(true) : [],
      markers: buildMarkers(pnlOn ? onPnl((index) => derived.pnl[index].cum) : null),
      zeroValue: 0,
      legend: [
        {
          key: "pnl",
          label: "Closed P&L",
          helper: "Cumulative closed-trade profit",
          color: "bg-accent",
          toggleable: true,
          active: pnlOn,
          value: money(derived.closedPnl, currency),
        },
        {
          key: "volume",
          label: "Volume",
          helper: "Traded lot volume",
          color: "bg-accent/50",
          toggleable: true,
          active: on("volume"),
          overlay: true,
        },
        ...markersLegend(),
      ],
    };
  };

  // ── CHART: ONE smooth equity-growth curve (%), the way Myfxbook draws it; the closed-P&L line, the volume bars and
  //    the trade dots are extras that stay off until switched on ──
  if (tab === "CHART") {
    if (!hasPoints) return { ...profitSpec(), missingSnapshots: true };
    const equity = points.map((point) => ({
      t: point.t,
      v: point.equityGrowth,
      estimated: point.estimated,
    }));
    const pnl = derived.pnl.map((point) => ({ t: point.t, v: point.growth }));
    const values: number[] = [];
    if (on("equity")) values.push(...equity.map((point) => point.v));
    if (on("pnl")) values.push(...pnl.map((point) => point.v));
    const { min, max } = range(values);
    const scale = niceScale(min, max, { includeZero: true, minSpan: 0.2 });
    // Closed P&L (when switched on) is drawn as % of what it is measured against (`derived.pnlBase`), on the same axis
    // as the equity growth; its money amount is in the legend and in the hover read-out, not on a second axis.
    const lines: ChartLine[] = [];
    const equityDrawn = on("equity") && equity.length > 0;
    if (equityDrawn) {
      lines.push(line("equity", "Equity growth", CHART_COLORS.equity, thin(equity), { area: true, width: 2.5, primary: true }));
    }
    if (on("pnl")) {
      lines.push(line("pnl", "Closed P&L", CHART_COLORS.gold, thin(pnl), { width: 1.75, primary: !equityDrawn }));
    }
    return {
      ...empty,
      yMin: scale.min,
      yMax: scale.max,
      ticks: scale.ticks,
      step: scale.step,
      axisTitle: "Growth %",
      formatY: (value) => formatAxisPercent(value, scale.step),
      lines,
      bars: on("volume") ? volumeBars(true) : [],
      markers: buildMarkers(
        on("equity") && equity.length > 0
          ? onPoints((index) => points[index].equityGrowth)
          : on("pnl")
            ? onPnl((index) => derived.pnl[index].growth)
            : null,
      ),
      zeroValue: 0,
      legend: [
        {
          key: "equity",
          label: "Equity growth",
          helper: "Recorded balance/equity snapshots, without deposits / withdrawals",
          color: "bg-accent-2",
          toggleable: true,
          active: on("equity"),
          value: formatSignedPercent(derived.equityGrowthPct),
        },
        {
          key: "pnl",
          label: "Closed P&L",
          helper: "Cumulative closed-trade profit, as % of the starting balance",
          color: "bg-accent",
          toggleable: true,
          active: on("pnl"),
          value: money(derived.closedPnl, currency),
          overlay: true,
        },
        {
          key: "volume",
          label: "Volume",
          helper: "Traded lot volume",
          color: "bg-accent/50",
          toggleable: true,
          active: on("volume"),
          overlay: true,
        },
        ...markersLegend(),
        {
          key: "drawdown",
          label: "Drawdown",
          helper: "Current drawdown vs the highest equity",
          color: drawdownCurrent > 0 ? "bg-danger" : "bg-muted",
          toggleable: false,
          active: true,
          value: percent(drawdownCurrent, 1),
        },
      ],
    };
  }

  // ── GROWTH: equity growth % and balance growth % ──────────────────────────
  if (tab === "GROWTH") {
    if (!hasPoints) return { ...empty, emptyReason: "NO_SNAPSHOTS" };
    const equity = points.map((point) => ({
      t: point.t,
      v: point.equityGrowth,
      estimated: point.estimated,
    }));
    const balance = points.map((point) => ({
      t: point.t,
      v: point.balanceGrowth,
      estimated: point.estimated,
    }));
    const values: number[] = [];
    if (on("equity")) values.push(...equity.map((point) => point.v));
    if (on("balance")) values.push(...balance.map((point) => point.v));
    const { min, max } = range(values);
    const scale = niceScale(min, max, { includeZero: true, minSpan: 0.2 });
    const lines: ChartLine[] = [];
    if (on("balance")) {
      lines.push(line("balance", "Balance growth", CHART_COLORS.gold, thin(balance), { width: 1.75, primary: !on("equity") }));
    }
    if (on("equity")) {
      lines.push(line("equity", "Equity growth", CHART_COLORS.equity, thin(equity), { area: true, width: 2.5, primary: true }));
    }
    return {
      ...empty,
      yMin: scale.min,
      yMax: scale.max,
      ticks: scale.ticks,
      step: scale.step,
      axisTitle: "Growth %",
      formatY: (value) => formatAxisPercent(value, scale.step),
      lines,
      markers: buildMarkers(
        on("equity")
          ? onPoints((index) => points[index].equityGrowth)
          : on("balance")
            ? onPoints((index) => points[index].balanceGrowth)
            : null,
      ),
      zeroValue: 0,
      legend: [
        {
          key: "equity",
          label: "Equity growth",
          helper: derived.cashFlowCount > 0 ? "Equity vs the first point, without deposits / withdrawals" : "Equity vs the first point of the range",
          color: "bg-accent-2",
          toggleable: true,
          active: on("equity"),
          value: formatSignedPercent(derived.equityGrowthPct),
        },
        {
          key: "balance",
          label: "Balance growth",
          helper: derived.cashFlowCount > 0 ? "Balance vs the first point, without deposits / withdrawals" : "Balance vs the first point of the range",
          color: "bg-accent",
          toggleable: true,
          active: on("balance"),
          value: formatSignedPercent(derived.balanceGrowthPct),
        },
        ...markersLegend(),
      ],
    };
  }

  // ── BALANCE: balance and equity in money ──────────────────────────────────
  if (tab === "BALANCE") {
    if (!hasPoints) return { ...empty, emptyReason: "NO_SNAPSHOTS" };
    const balance = points.map((point) => ({ t: point.t, v: point.balance, estimated: point.estimated }));
    const equity = points.map((point) => ({ t: point.t, v: point.equity, estimated: point.estimated }));
    const values: number[] = [];
    if (on("balance")) values.push(...balance.map((point) => point.v));
    if (on("equity")) values.push(...equity.map((point) => point.v));
    const { min, max } = range(values);
    const reference = Math.max(Math.abs(min), Math.abs(max));
    const scale = niceScale(min, max, { minSpan: Math.max(reference * 0.004, 1) });
    const lines: ChartLine[] = [];
    if (on("equity")) {
      lines.push(line("equity", "Equity", CHART_COLORS.equity, thin(equity), { area: true, width: 2.5, primary: true }));
    }
    if (on("balance")) {
      lines.push(line("balance", "Balance", CHART_COLORS.gold, thin(balance), { width: 1.75, primary: !on("equity") }));
    }
    const latest = derived.latest;
    return {
      ...empty,
      yMin: scale.min,
      yMax: scale.max,
      ticks: scale.ticks,
      step: scale.step,
      axisTitle: "Balance / Equity",
      formatY: (value) => formatAxisMoney(value, currency, scale.step),
      lines,
      markers: buildMarkers(
        on("balance")
          ? onPoints((index) => points[index].balance)
          : on("equity")
            ? onPoints((index) => points[index].equity)
            : null,
      ),
      zeroValue: scale.min <= 0 && scale.max >= 0 ? 0 : null,
      legend: [
        {
          key: "balance",
          label: "Balance",
          helper: "Closed-trade balance",
          color: "bg-accent",
          toggleable: true,
          active: on("balance"),
          value: latest ? money(latest.balance, currency) : undefined,
        },
        {
          key: "equity",
          label: "Equity",
          helper: "Balance plus open P&L",
          color: "bg-accent-2",
          toggleable: true,
          active: on("equity"),
          value: latest ? money(latest.equity, currency) : undefined,
        },
        ...markersLegend(),
      ],
    };
  }

  // ── PROFIT: cumulative closed P&L + volume bars ───────────────────────────
  if (tab === "PROFIT") return profitSpec();

  // ── DRAWDOWN: % below the running equity peak (drawn downwards) ───────────
  if (tab === "DRAWDOWN") {
    if (!hasPoints) return { ...empty, emptyReason: "NO_SNAPSHOTS" };
    const drawdown = points.map((point) => ({
      t: point.t,
      // drawn downwards from zero (never -0)
      v: point.drawdown > 0 ? -point.drawdown : 0,
      estimated: point.estimated,
    }));
    const { min } = range(drawdown.map((point) => point.v));
    // The axis hangs from 0 downwards and is at least 1% deep, so an account
    // without any drawdown still gets a readable scale (no "+" half).
    const scale = niceScale(Math.min(min, -1), 0, { includeZero: true, minSpan: 1 });
    return {
      ...empty,
      yMin: scale.min,
      yMax: scale.max,
      ticks: scale.ticks,
      step: scale.step,
      axisTitle: "Drawdown %",
      formatY: (value) => formatAxisPercent(value, scale.step),
      lines: [line("drawdown", "Drawdown", CHART_COLORS.danger, thin(drawdown), { area: true, width: 2.5, primary: true })],
      zeroValue: 0,
      legend: [
        {
          key: "current",
          label: "Current drawdown",
          helper: derived.cashFlowCount > 0 ? "Account value vs its highest peak, without deposits / withdrawals" : "Account value vs its highest peak",
          color: drawdownCurrent > 0 ? "bg-danger" : "bg-muted",
          toggleable: false,
          active: true,
          value: percent(drawdownCurrent, 1),
        },
        {
          key: "max",
          label: "Max drawdown (range)",
          helper: "Deepest fall inside the selected range",
          color: derived.maxDrawdownPct > 0 ? "bg-danger" : "bg-muted",
          toggleable: false,
          active: true,
          value: percent(derived.maxDrawdownPct, 1),
        },
        {
          key: "peak",
          label: "Equity peak (all time)",
          helper: "Highest equity recorded by the platform",
          color: "bg-accent-2",
          toggleable: false,
          active: true,
          value: input.equityPeak !== null ? money(input.equityPeak, currency) : "—",
        },
      ],
    };
  }

  // ── MARGIN: used and free margin in money ─────────────────────────────────
  if (!derived.hasMargin) return { ...empty, emptyReason: hasPoints ? "NO_MARGIN" : "NO_SNAPSHOTS" };
  const used = points
    .filter((point) => point.margin !== null)
    .map((point) => ({ t: point.t, v: point.margin as number }));
  const free = points
    .filter((point) => point.freeMargin !== null)
    .map((point) => ({ t: point.t, v: point.freeMargin as number }));
  const values: number[] = [];
  if (on("used")) values.push(...used.map((point) => point.v));
  if (on("free")) values.push(...free.map((point) => point.v));
  const { min, max } = range(values.length > 0 ? values : [0]);
  const reference = Math.max(Math.abs(min), Math.abs(max));
  const scale = niceScale(min, max, { includeZero: true, minSpan: Math.max(reference * 0.1, 10) });
  const latest = derived.latest;
  return {
    ...empty,
    yMin: scale.min,
    yMax: scale.max,
    ticks: scale.ticks,
    step: scale.step,
    axisTitle: "Margin",
    formatY: (value) => formatAxisMoney(value, currency, scale.step),
    lines: [
      ...(on("free") && free.length > 0
        ? [line("free", "Free margin", CHART_COLORS.equity, thin(free), { area: true, width: 2.5, primary: true })]
        : []),
      ...(on("used") && used.length > 0
        ? [line("used", "Used margin", CHART_COLORS.gold, thin(used), { width: 1.75, primary: !(on("free") && free.length > 0) })]
        : []),
    ],
    zeroValue: 0,
    legend: [
      {
        key: "used",
        label: "Used margin",
        helper: "Margin held by open positions",
        color: "bg-accent",
        toggleable: true,
        active: on("used"),
        value: latest?.margin != null ? money(latest.margin, currency) : undefined,
      },
      {
        key: "free",
        label: "Free margin",
        helper: "Equity available for new trades",
        color: "bg-accent-2",
        toggleable: true,
        active: on("free"),
        value: latest?.freeMargin != null ? money(latest.freeMargin, currency) : undefined,
      },
      {
        key: "level",
        label: "Margin level",
        helper: "Equity / used margin",
        color: "bg-muted",
        toggleable: false,
        active: true,
        value: latest?.marginLevel != null ? percent(latest.marginLevel, 0) : "—",
      },
    ],
  };
}

/**
 * The value of a drawn line at `time`: the point's own value, or the straight-line value between its two neighbours.
 * Null outside the line (before its first or after its last point). The hover marker sits on the drawn curve with this.
 */
export function lineValueAt(points: ReadonlyArray<ChartPoint>, time: number): number | null {
  if (points.length === 0) return null;
  if (time < points[0].t || time > points[points.length - 1].t) return null;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (points[middle].t <= time) low = middle;
    else high = middle - 1;
  }
  const before = points[low];
  const after = points[low + 1];
  if (!after || after.t === before.t) return before.v;
  return before.v + ((after.v - before.v) * (time - before.t)) / (after.t - before.t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip
// ─────────────────────────────────────────────────────────────────────────────

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

export interface TooltipContent {
  title: string;
  rows: TooltipRow[];
  estimated: boolean;
}

export function tooltipAt(input: {
  derived: DerivedSeries;
  tab: ChartTab;
  time: number;
  currency: string;
}): TooltipContent | null {
  const { derived, tab, time, currency } = input;
  const times = derived.points.map((point) => point.t);
  const pointIndex = nearestIndexByTime(times, time);
  const point = pointIndex >= 0 ? derived.points[pointIndex] : null;
  const pnlIndex = lastIndexAtOrBefore(
    derived.pnl.map((entry) => entry.t),
    time,
  );
  const pnl = pnlIndex >= 0 ? derived.pnl[pnlIndex] : null;

  if (tab === "PROFIT" || (tab === "CHART" && derived.points.length === 0)) {
    if (!pnl) return null;
    return {
      title: formatTooltipTime(time),
      estimated: false,
      rows: [
        { label: "Closed P&L", value: money(pnl.cum, currency), color: CHART_COLORS.gold },
        ...(derived.base !== null ? [{ label: "Growth", value: formatSignedPercent(pnl.growth) }] : []),
      ],
    };
  }
  if (!point) return null;
  const title = formatTooltipTime(point.t);
  const estimated = point.estimated;

  if (tab === "CHART") {
    return {
      title,
      estimated,
      rows: [
        { label: "Equity", value: money(point.equity, currency), color: CHART_COLORS.equity },
        { label: "Equity growth", value: formatSignedPercent(point.equityGrowth) },
        { label: "Balance", value: money(point.balance, currency), color: CHART_COLORS.gold },
        ...(pnl ? [{ label: "Closed P&L", value: money(pnl.cum, currency) }] : []),
      ],
    };
  }
  if (tab === "GROWTH") {
    return {
      title,
      estimated,
      rows: [
        { label: "Equity growth", value: formatSignedPercent(point.equityGrowth), color: CHART_COLORS.equity },
        { label: "Balance growth", value: formatSignedPercent(point.balanceGrowth), color: CHART_COLORS.gold },
      ],
    };
  }
  if (tab === "BALANCE") {
    return {
      title,
      estimated,
      rows: [
        { label: "Equity", value: money(point.equity, currency), color: CHART_COLORS.equity },
        { label: "Balance", value: money(point.balance, currency), color: CHART_COLORS.gold },
        { label: "Floating P&L", value: money(point.floating, currency) },
      ],
    };
  }
  if (tab === "DRAWDOWN") {
    return {
      title,
      estimated,
      rows: [
        { label: "Drawdown", value: percent(point.drawdown), color: CHART_COLORS.danger },
        { label: "Equity", value: money(point.equity, currency) },
      ],
    };
  }
  return {
    title,
    estimated,
    rows: [
      {
        label: "Used margin",
        value: point.margin !== null ? money(point.margin, currency) : "—",
        color: CHART_COLORS.gold,
      },
      {
        label: "Free margin",
        value: point.freeMargin !== null ? money(point.freeMargin, currency) : "—",
        color: CHART_COLORS.equity,
      },
      {
        label: "Margin level",
        value: point.marginLevel !== null ? percent(point.marginLevel, 0) : "—",
      },
    ],
  };
}
