"use client";

import {
  useId,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Panel } from "@/components/app/WorkspaceUI";
import { useElementWidth } from "@/hooks/useElementWidth";
import { usePerformanceSeries } from "@/hooks/usePerformanceSeries";
import {
  PERFORMANCE_RANGE_OPTIONS,
  PERFORMANCE_STALE_AFTER_MS,
  deriveSeries,
  formatSignedPercent,
  formatTooltipTime,
  nearestIndexByTime,
  timeAxisLabels,
  timeTicks,
  withLiveEquity,
  type PerformanceRange,
  type PerformanceSeriesDto,
} from "@/lib/charts/performanceSeries";
import {
  CHART_TABS,
  buildChartSpec,
  lineValueAt,
  tooltipAt,
  type ChartEmptyReason,
  type ChartLegendItem,
  type ChartLine,
  type ChartMarker,
  type ChartSpec,
  type ChartTab,
} from "@/lib/charts/performanceChartSpec";
import { toSmoothAreaPath, toSmoothPath } from "@/lib/charts/svgCurve";
import { formatMoney } from "@/lib/utils/format";

/**
 * Myfxbook-style account performance chart.
 *
 * One component for every place that shows an account curve (trader dashboard,
 * analytics, account detail). All numbers come from `/api/analytics/performance`
 * (recorded snapshots + closed trades); nothing on the chart is invented.
 *
 * The picture is deliberately plain, like Myfxbook's: ONE smooth curve on two axes (time along the bottom, a single
 * value axis on the left), faint horizontal grid lines and nothing else. The closed-P&L line, the volume bars and the
 * dots of single trades are extras the person can switch on under the chart. While the recording is live the curve
 * ends at the account's current equity (`liveEquity`), so it moves as the account does instead of stopping at the last
 * stored snapshot. Parts rebuilt from closed trades are drawn dotted and labelled as estimates.
 */

export interface AccountPerformanceChartProps {
  /** trading account id, or "ALL" for the combined curve of connected accounts */
  accountId: string | null | undefined;
  accountName?: string;
  /** used until the first response says which currency the account has */
  currency?: string | null;
  eyebrow?: string;
  title?: string;
  description?: string;
  /** controlled range; omit to let the chart keep its own */
  range?: PerformanceRange;
  defaultRange?: PerformanceRange;
  onRangeChange?: (range: PerformanceRange) => void;
  showRangeSelector?: boolean;
  defaultTab?: ChartTab;
  /** live account equity (the host page refreshes it every few seconds) */
  liveEquity?: number | null;
  /** live account drawdown % (vs the platform's all-time equity peak) */
  currentDrawdownPercent?: number | null;
  className?: string;
}

const MARKER_COLORS: Record<ChartMarker["kind"], string> = {
  win: "#21d19f",
  loss: "#ff5f56",
  mixed: "#ffcf00",
};
const EMPTY_HIDDEN: Record<string, boolean> = {};
/** room for the axis title above the plot */
const PAD_TOP = 26;
/** room for the tick label and, under it, the day or year it belongs to */
const PAD_BOTTOM = 44;
const PAD_RIGHT = 20;
/** the stretch before an account's first data is only marked when it is at least this much of the axis */
const MIN_BAND_SHARE = 0.01;
/** ...and only explained in words when it is this much */
const HINT_BAND_SHARE = 0.08;
/** about one drawn point per this many pixels of plot width: a curve, not a hairy line */
const PIXELS_PER_POINT = 4;

const GRID = "rgba(255,255,255,0.07)";
const GRID_ZERO = "rgba(255,255,255,0.22)";

/** The chosen period in words, for the notice that explains a stretch without data. */
const RANGE_WORDS: Record<PerformanceRange, string> = {
  "1D": "last day",
  "1W": "last week",
  "1M": "last month",
  "3M": "last 3 months",
  "6M": "last 6 months",
  "1Y": "last year",
  ALL: "whole history",
};

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeCurrency(code: string | null | undefined): string {
  const trimmed = code?.trim() ?? "";
  return /^[A-Za-z]{3}$/.test(trimmed) ? trimmed.toUpperCase() : "USD";
}

function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function formatRangeDate(time: number): string {
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface PixelPoint {
  x: number;
  y: number;
  estimated: boolean;
}

interface PixelRun {
  estimated: boolean;
  points: PixelPoint[];
}

/**
 * The smooth path needs strictly increasing x. Two readings that land on the same pixel column (or the same instant) are
 * one reading to the eye: the later one stays. (Nothing is moved or invented.)
 */
function dedupeX(points: PixelPoint[]): PixelPoint[] {
  const result: PixelPoint[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && point.x <= last.x) result[result.length - 1] = point;
    else result.push(point);
  }
  return result;
}

/**
 * Splits a line into runs of recorded and estimated segments. A segment is
 * estimated when it starts at an estimated point (the stretch before the first
 * recorded snapshot), so the join with the first real point is dotted too.
 */
function splitRuns(points: PixelPoint[]): PixelRun[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ estimated: points[0].estimated, points: [points[0]] }];
  const runs: PixelRun[] = [];
  let current: PixelRun = { estimated: points[0].estimated, points: [points[0], points[1]] };
  for (let index = 2; index < points.length; index += 1) {
    const flag = points[index - 1].estimated;
    if (flag === current.estimated) {
      current.points.push(points[index]);
    } else {
      runs.push(current);
      current = { estimated: flag, points: [points[index - 1], points[index]] };
    }
  }
  runs.push(current);
  return runs;
}

function describeEmpty(
  reason: ChartEmptyReason,
  dto: PerformanceSeriesDto,
): { title: string; text: string } | null {
  if (dto.coverage.mixedCurrencies) {
    return {
      title: "Accounts use different currencies",
      text: "One combined curve would mix currencies. Select a single account to see its history.",
    };
  }
  if (reason === "NO_DATA") {
    return dto.coverage.aggregate
      ? {
          title: "No history to combine yet",
          text: "The combined curve appears once your connected accounts have recorded balance snapshots or closed trades.",
        }
      : {
          title: "No history recorded yet",
          text: "This account has no balance snapshot and no closed trade in the selected range. The curve starts with the first one that is stored.",
        };
  }
  if (reason === "NO_SNAPSHOTS") {
    return {
      title: "No balance snapshots in this range",
      text: "This view needs recorded balance/equity snapshots. The Chart and Profit tabs still show the closed-trade curve.",
    };
  }
  if (reason === "NO_MARGIN") {
    return dto.coverage.marginSupported
      ? {
          title: "Margin history is empty so far",
          text: "Used margin, free margin and margin level are stored together with new account snapshots; the curve fills in as they arrive.",
        }
      : {
          title: "Margin history is not enabled yet",
          text: "The platform database does not store margin per snapshot yet, so this view has nothing to draw.",
        };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function AccountPerformanceChart({
  accountId,
  accountName,
  currency: currencyProp,
  eyebrow = "Performance analytics",
  title = "Account performance curve",
  description,
  range: controlledRange,
  defaultRange = "ALL",
  onRangeChange,
  showRangeSelector = true,
  defaultTab = "CHART",
  liveEquity = null,
  currentDrawdownPercent = null,
  className = "",
}: AccountPerformanceChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [internalRange, setInternalRange] = useState<PerformanceRange>(defaultRange);
  const range = controlledRange ?? internalRange;
  const [tab, setTab] = useState<ChartTab>(defaultTab);
  const [hiddenByTab, setHiddenByTab] = useState<Partial<Record<ChartTab, Record<string, boolean>>>>({});
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [frameRef, width] = useElementWidth<HTMLDivElement>();

  const query = usePerformanceSeries(accountId, range);
  const dto = query.data ?? null;
  const recorded = useMemo(() => (dto ? deriveSeries(dto) : null), [dto]);
  // The curve reaches "now" while the recording is live: the account's current equity is its last point. (Not for the
  // combined curve of several accounts - the host's live figure is not the sum that curve is drawn from.)
  const liveAllowed = dto !== null && !dto.coverage.stale && !dto.coverage.aggregate && accountId !== "ALL";
  const derived = useMemo(
    () => (recorded ? withLiveEquity(recorded, liveAllowed ? liveEquity : null, !liveAllowed) : null),
    [recorded, liveEquity, liveAllowed],
  );
  const liveShown = derived !== null && recorded !== null && derived !== recorded;
  const currency = safeCurrency(dto?.currency ?? currencyProp);
  const hidden = hiddenByTab[tab] ?? EMPTY_HIDDEN;

  const compact = width > 0 && width < 560;
  const height = compact ? 280 : 360;
  const barCount = Math.max(8, Math.floor((width || 800) / 16));
  const pointBudget = clamp(Math.round((width || 800) / PIXELS_PER_POINT), 60, 240);

  const spec = useMemo<ChartSpec | null>(() => {
    if (!dto || !derived) return null;
    return buildChartSpec({
      derived,
      ledger: dto.ledger,
      tradeCount: dto.stats.tradeCount,
      tab,
      hidden,
      currency,
      barCount,
      currentDrawdownPct: currentDrawdownPercent,
      equityPeak: dto.coverage.equityPeak,
      pointBudget,
    });
  }, [dto, derived, tab, hidden, currency, barCount, currentDrawdownPercent, pointBudget]);

  const emptyInfo = dto && spec ? describeEmpty(spec.emptyReason, dto) : null;
  const message: { title: string; text: ReactNode } | null = !accountId
    ? { title: "No account selected", text: "Select a trading account to see its performance history." }
    : query.isPending
      ? { title: "Loading account history…", text: "Reading recorded snapshots and closed trades." }
      : !dto
        ? {
            title: "Account history could not be loaded",
            text: (
              <>
                {query.error instanceof Error ? query.error.message : "The history service did not answer."}{" "}
                <button
                  type="button"
                  onClick={() => void query.refetch()}
                  className="font-semibold text-accent underline-offset-2 hover:underline"
                >
                  Try again
                </button>
              </>
            ),
          }
        : emptyInfo;

  // ── geometry ───────────────────────────────────────────────────────────────
  const hasMessage = message !== null;
  const layout = useMemo(() => {
    if (!spec || !derived || width <= 0 || hasMessage) return null;
    const longest = (labels: string[]) => labels.reduce((max, label) => Math.max(max, label.length), 0);
    // ONE value axis (on the left) plus the time axis
    const leftLabels = spec.ticks.map((tick) => spec.formatY(tick));
    // the axis text is 11 px (12 px from a tablet up): a digit is about 7 / 7.8 px wide
    const charWidth = compact ? 7 : 7.8;
    const padLeft = clamp(longest(leftLabels) * charWidth + 16, 44, 112);
    const plotW = Math.max(60, width - padLeft - PAD_RIGHT);
    const plotH = height - PAD_TOP - PAD_BOTTOM;
    const span = Math.max(1, derived.end - derived.start);
    const ySpan = Math.max(1e-9, spec.yMax - spec.yMin);
    const xOf = (time: number) => padLeft + clamp((time - derived.start) / span, 0, 1) * plotW;
    const yOf = (value: number) => PAD_TOP + (1 - clamp((value - spec.yMin) / ySpan, 0, 1)) * plotH;
    const baselineY = spec.zeroValue !== null ? yOf(spec.zeroValue) : PAD_TOP + plotH;
    // about one tick per 96 px: room for "Oct 12" / "14:05" at 12 px with air around them
    const timeTickValues = timeTicks(derived.start, derived.end, clamp(Math.floor(plotW / 96), 2, 10));
    const timeLabels = timeAxisLabels(timeTickValues, span);
    // the stretch before the account's first data: marked, never drawn into
    const historyX = xOf(derived.historyStart);
    const bandW = derived.historyStart - derived.start >= span * MIN_BAND_SHARE ? historyX - padLeft : 0;
    return { padLeft, plotW, plotH, span, xOf, yOf, baselineY, timeLabels, historyX, bandW, leftLabels };
  }, [spec, derived, width, height, hasMessage, compact]);

  // ── interaction ────────────────────────────────────────────────────────────
  const times = useMemo(() => (derived ? derived.points.map((point) => point.t) : []), [derived]);

  const handlePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!layout || !derived) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left - target.clientLeft;
    if (x < layout.padLeft || x > layout.padLeft + layout.plotW) {
      setHoverTime(null);
      return;
    }
    const raw = derived.start + ((x - layout.padLeft) / layout.plotW) * layout.span;
    const snapped =
      tab !== "PROFIT" && times.length > 0 ? times[nearestIndexByTime(times, raw)] : Math.round(raw);
    setHoverTime((current) => (current === snapped ? current : snapped));
  };

  const toggleSeries = (item: ChartLegendItem) => {
    if (!spec) return;
    setHiddenByTab((current) => {
      const forTab = { ...(current[tab] ?? {}) };
      // (what is on is switched off, what is off is switched on)
      forTab[item.key] = item.active;
      // the last curve of a tab stays: only the extras may all be off
      const curves = spec.legend.filter((entry) => entry.toggleable && !entry.overlay);
      const stays = (entry: ChartLegendItem) => (entry.key === item.key ? !item.active : entry.active);
      if (curves.length > 0 && !curves.some(stays)) return current;
      return { ...current, [tab]: forTab };
    });
  };

  const selectRange = (next: PerformanceRange) => {
    if (controlledRange === undefined) setInternalRange(next);
    onRangeChange?.(next);
    setHoverTime(null);
  };

  const selectTab = (next: ChartTab) => {
    setTab(next);
    setHoverTime(null);
  };

  // ── header numbers ─────────────────────────────────────────────────────────
  const headerEquity = liveEquity ?? derived?.latest?.equity ?? null;
  const growth = derived && derived.base !== null ? derived.equityGrowthPct : null;
  const closedPnl = derived ? derived.closedPnl : null;
  const headerStats: Array<{ label: string; value: string; tone: string }> = [
    {
      label: "Equity",
      value: headerEquity !== null ? formatMoney({ amount: headerEquity, currency }) : "—",
      tone: "text-accent",
    },
    {
      label: "Closed P&L",
      value: closedPnl !== null ? formatMoney({ amount: closedPnl, currency }) : "—",
      tone: closedPnl === null || closedPnl >= 0 ? "text-accent-2" : "text-danger",
    },
    {
      label: "% Growth",
      value: growth !== null ? formatSignedPercent(growth) : "—",
      tone: growth === null || growth >= 0 ? "text-accent-2" : "text-danger",
    },
    {
      label: "Win rate",
      value: dto && dto.stats.tradeCount > 0 ? `${dto.stats.winRate.toFixed(1)}%` : "—",
      tone: "text-foreground",
    },
  ];

  // ── notices: one warning when the recording stopped, the rest folded away under "Notes" ──
  const accountWords = dto?.coverage.aggregate ? "these accounts" : "this account";
  let warning: string | null = null;
  const notes: string[] = [];
  if (dto && !message) {
    const last = dto.coverage.lastSnapshotAt;
    const lastData = dto.coverage.lastDataAt;
    if (dto.coverage.stale && lastData !== null) {
      warning = `Recording stopped ${formatAge(dto.generatedAt - lastData)} ago (last data: ${formatTooltipTime(lastData)}). The chart ends there and grows again once the risk worker and the broker connection record new snapshots for ${accountWords}.`;
    } else if (last !== null && dto.generatedAt - last > PERFORMANCE_STALE_AFTER_MS) {
      warning = `Last balance snapshot: ${formatTooltipTime(last)} (${formatAge(dto.generatedAt - last)} ago). The curve only grows while snapshots are recorded for ${accountWords}.`;
    }
    if (derived?.hasEstimated) {
      const gaps = dto.coverage.gapCount;
      notes.push(
        gaps > 0
          ? `Dotted segments are estimates: ${gaps} stretch${gaps === 1 ? "" : "es"} without recorded snapshots ${gaps === 1 ? "was" : "were"} bridged using the closed trades of that period.`
          : "Dotted segments are estimated from closed trades because no snapshot was recorded for that period.",
      );
    }
    const flowCount = dto.coverage.cashFlowCount ?? 0;
    if (flowCount > 0 && derived) {
      const plural = flowCount === 1 ? "" : "s";
      notes.push(
        derived.cashFlowCount > 0
          ? `Growth and drawdown leave out ${flowCount} deposit${plural} / withdrawal${plural} (net ${formatMoney({ amount: derived.netCashFlow, currency })}): paying money in or out is not profit or loss.`
          : `${flowCount} deposit${plural} / withdrawal${plural} fall outside the drawn curve and do not change growth or drawdown.`,
      );
    }
    if (derived && derived.joinedAccounts > 0) {
      const count = derived.joinedAccounts;
      notes.push(
        `${count} account${count === 1 ? " was" : "s were"} connected during this period (${formatMoney({ amount: derived.joinedAmount, currency })} in total): the combined curve steps up when each one joins, and growth and drawdown leave that out.`,
      );
    }
    const droppedReadings = dto.coverage.glitchSamplesDropped ?? 0;
    if (droppedReadings > 0) {
      notes.push(
        `${droppedReadings} stored reading${droppedReadings === 1 ? "" : "s"} that cannot be real (for example equity 0 next to a positive balance) ${droppedReadings === 1 ? "was" : "were"} left out of the curve.`,
      );
    }
    if (derived && derived.points.length === 1 && tab !== "PROFIT") {
      notes.push("Only one balance snapshot exists in this range so far — the line appears as soon as a second one is recorded.");
    }
    if (spec?.missingSnapshots) {
      notes.push("No balance snapshots in this range: only the closed-trade curve can be drawn.");
    }
    if (derived && derived.points.length > 0 && dto.stats.tradeCount === 0) {
      notes.push("No closed trades in this range — the curve follows balance and equity only.");
    }
    if (dto.coverage.tradesTruncated) {
      notes.push("This account has more closed trades than the chart can load; the oldest ones are used and the newest may be missing.");
    }
    if (dto.coverage.aggregate && dto.coverage.aggregateLimitedToDays) {
      notes.push(
        `The combined curve of all connected accounts covers the last ${dto.coverage.aggregateLimitedToDays} days; the part of this period before that is left empty.`,
      );
    }
    if (query.isError) {
      notes.push("The last refresh failed; showing the most recently loaded history.");
    }
  }

  // The period is longer than the history: say so in one line, and offer the view that fits.
  const firstDataAt = dto?.coverage.firstDataAt ?? null;
  const showHistoryHint =
    dto !== null &&
    derived !== null &&
    !message &&
    firstDataAt !== null &&
    derived.historyStart - derived.start >= (derived.end - derived.start) * HINT_BAND_SHARE;

  const displayName = accountName?.trim() || (accountId === "ALL" ? "all connected accounts" : "this account");
  const subtitle =
    description ??
    `Equity growth of ${displayName}, drawn from stored account snapshots and closed trades.`;

  // ── hover content ──────────────────────────────────────────────────────────
  const hover =
    layout && derived && hoverTime !== null && hoverTime >= derived.start - 1 && hoverTime <= derived.end + 1
      ? tooltipAt({ derived, tab, time: hoverTime, currency })
      : null;
  const hoverX = layout && hover ? layout.xOf(hoverTime as number) : null;

  const renderLine = (line: ChartLine, lineIndex: number) => {
    if (!layout || !spec) return null;
    const pixels: PixelPoint[] = dedupeX(
      line.points.map((point) => ({
        x: layout.xOf(point.t),
        y: layout.yOf(point.v),
        estimated: point.estimated === true,
      })),
    );
    const runs = splitRuns(pixels);
    const belowBaseline = line.points.length > 0 && line.points.every((point) => point.v <= (spec.zeroValue ?? 0));
    const gradientId = `${uid}fill${lineIndex}`;
    return (
      <g key={line.key}>
        {line.area ? (
          <>
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={line.color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={line.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {runs
              .filter((run) => !run.estimated)
              .map((run, runIndex) => {
                const d = toSmoothAreaPath(run.points, layout.baselineY);
                if (!d) return null;
                return (
                  <path
                    key={`area-${runIndex}`}
                    d={d}
                    fill={belowBaseline && spec.zeroValue !== null ? line.color : `url(#${gradientId})`}
                    fillOpacity={belowBaseline && spec.zeroValue !== null ? 0.14 : 1}
                  />
                );
              })}
          </>
        ) : null}
        {runs.map((run, runIndex) => {
          const d = toSmoothPath(run.points);
          if (!d) return null;
          return (
            <path
              key={`line-${runIndex}`}
              d={d}
              fill="none"
              stroke={line.color}
              strokeWidth={run.estimated ? Math.max(1.5, line.width - 0.5) : line.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={run.estimated ? "1 5" : undefined}
              opacity={run.estimated ? 0.85 : 1}
            />
          );
        })}
      </g>
    );
  };

  const axisText = `fill-muted ${compact ? "text-[11px]" : "text-xs"} tabular-nums`;

  return (
    <Panel className={`overflow-hidden p-0 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">{eyebrow}</p>
          <h2 className="mt-2 text-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>
        </div>
        <div className="grid grid-cols-2 overflow-hidden rounded-[4px] border border-line bg-background text-right sm:grid-cols-4">
          {headerStats.map((stat) => (
            <div key={stat.label} className="min-w-28 border-r border-line px-4 py-3 last:border-r-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{stat.label}</p>
              <p className={`mt-1 text-sm font-semibold tabular-nums ${stat.tone}`}>{stat.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="px-4 pb-4 pt-4 sm:px-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1 rounded-[4px] border border-line bg-background p-1">
            {CHART_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => selectTab(entry.id)}
                aria-pressed={tab === entry.id}
                className={`rounded-[3px] px-3 py-1.5 text-xs font-semibold transition ${
                  tab === entry.id
                    ? "bg-accent text-background"
                    : "text-muted hover:bg-panel hover:text-foreground"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {showRangeSelector ? (
            <div className="flex flex-wrap items-center gap-1 rounded-[4px] border border-line bg-background p-1">
              {PERFORMANCE_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => selectRange(option.id)}
                  aria-pressed={range === option.id}
                  title={option.id === "ALL" ? "Whole history" : `Last ${RANGE_WORDS[option.id].replace("last ", "")}`}
                  className={`rounded-[3px] px-3 py-1.5 text-xs font-semibold transition ${
                    range === option.id
                      ? "bg-accent text-background"
                      : "text-muted hover:bg-panel hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {warning ? (
          <p className="mb-3 rounded-[4px] border border-line border-l-accent bg-panel px-3 py-2 text-xs leading-5 text-muted [border-left-width:3px]">
            {warning}
          </p>
        ) : null}

        {showHistoryHint && derived && firstDataAt !== null ? (
          <p className="mb-3 text-xs text-muted">
            Data starts{" "}
            <span className="font-semibold text-foreground">{formatRangeDate(derived.historyStart)}</span> — the{" "}
            {RANGE_WORDS[range]} is longer than the history.
            {range !== "ALL" ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => selectRange("ALL")}
                  className="font-semibold text-accent underline-offset-2 hover:underline"
                >
                  Show the whole history
                </button>
              </>
            ) : null}
          </p>
        ) : null}

        <div
          ref={frameRef}
          className={`relative overflow-hidden rounded-[4px] border border-line bg-background transition-opacity ${
            query.isPlaceholderData ? "opacity-70" : ""
          }`}
          style={{ height: height + 2, touchAction: "pan-y" }}
          aria-busy={query.isFetching}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setHoverTime(null)}
        >
          {message ? (
            <div className="relative flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm font-semibold text-foreground">{message.title}</p>
              <p className="max-w-md text-xs leading-5 text-muted">{message.text}</p>
            </div>
          ) : layout && spec && derived ? (
            <>
              <svg
                width={width}
                height={height}
                className="relative block"
                role="img"
                aria-label={`${displayName} performance chart, ${CHART_TABS.find((entry) => entry.id === tab)?.label ?? ""} view`}
              >
                <defs>
                  <clipPath id={`${uid}clip`}>
                    <rect x={layout.padLeft} y={PAD_TOP} width={layout.plotW} height={layout.plotH} />
                  </clipPath>
                </defs>

                {/* the value axis: faint solid lines, the zero line a little stronger, the labels on the left */}
                {spec.ticks.map((tick, index) => {
                  const y = layout.yOf(tick);
                  const isZero = spec.zeroValue !== null && Math.abs(tick - spec.zeroValue) < 1e-9;
                  return (
                    <g key={`y-${tick}`}>
                      <line
                        x1={layout.padLeft}
                        x2={layout.padLeft + layout.plotW}
                        y1={y}
                        y2={y}
                        stroke={isZero ? GRID_ZERO : GRID}
                      />
                      <text x={layout.padLeft - 8} y={y + 4} textAnchor="end" className={`${axisText} font-medium`}>
                        {layout.leftLabels[index]}
                      </text>
                    </g>
                  );
                })}

                {/* the time axis: the label, and under it the day or year it belongs to */}
                {layout.timeLabels.map((tick) => {
                  const x = layout.xOf(tick.time);
                  return (
                    <g key={`x-${tick.time}`}>
                      <text x={x} y={PAD_TOP + layout.plotH + 18} textAnchor="middle" className={`${axisText} font-medium`}>
                        {tick.label}
                      </text>
                      {tick.sub ? (
                        <text x={x} y={PAD_TOP + layout.plotH + 32} textAnchor="middle" className="fill-muted/70 text-[10px] tabular-nums">
                          {tick.sub}
                        </text>
                      ) : null}
                    </g>
                  );
                })}

                <text x={layout.padLeft} y={14} textAnchor="start" className="fill-muted text-[10px] font-semibold uppercase tracking-[0.14em]">
                  {spec.axisTitle}
                </text>
                {liveShown ? (
                  <text x={layout.padLeft + layout.plotW} y={14} textAnchor="end" className="fill-accent-2 text-[10px] font-semibold uppercase tracking-[0.14em]">
                    ● Live
                  </text>
                ) : null}

                {/* plot content */}
                <g clipPath={`url(#${uid}clip)`}>
                  {layout.bandW > 0 && derived ? (
                    <g pointerEvents="none">
                      <rect x={layout.padLeft} y={PAD_TOP} width={layout.bandW} height={layout.plotH} fill="rgba(255,255,255,0.03)">
                        <title>{`No data before ${formatTooltipTime(derived.historyStart)}`}</title>
                      </rect>
                      {layout.bandW >= 104 ? (
                        <text x={layout.padLeft + layout.bandW / 2} y={PAD_TOP + layout.plotH / 2 + 4} textAnchor="middle" className="fill-muted/80 text-[11px]">
                          No data before {formatRangeDate(derived.historyStart)}
                        </text>
                      ) : null}
                    </g>
                  ) : null}
                  {spec.bars.map((bar) => {
                    const barWidth = clamp(layout.plotW / Math.max(barCount, 1) - 3, 3, 22);
                    const barHeight = Math.max(4, bar.ratio * Math.min(90, layout.plotH * 0.28));
                    return (
                      <rect
                        key={`bar-${bar.t}`}
                        x={layout.xOf(bar.t) - barWidth / 2}
                        y={PAD_TOP + layout.plotH - barHeight}
                        width={barWidth}
                        height={barHeight}
                        rx="2"
                        fill={spec.barColor}
                      />
                    );
                  })}
                  {spec.lines.map((line, index) => renderLine(line, index))}
                  {spec.markers.map((marker) => (
                    <circle
                      key={`marker-${marker.t}`}
                      cx={layout.xOf(marker.t)}
                      cy={layout.yOf(marker.v)}
                      r={marker.count > 1 ? 3.4 : 2.8}
                      fill={MARKER_COLORS[marker.kind]}
                      stroke="#050505"
                      strokeWidth={1}
                      opacity={0.92}
                      pointerEvents="none"
                    />
                  ))}
                </g>

                {/* where the main curve ends: the account's latest value */}
                {spec.lines.map((line) => {
                  const last = line.points[line.points.length - 1];
                  if (!line.primary || !last) return null;
                  return (
                    <circle
                      key={`last-${line.key}`}
                      cx={layout.xOf(last.t)}
                      cy={layout.yOf(last.v)}
                      r={4}
                      fill="#050505"
                      stroke={line.color}
                      strokeWidth={2.5}
                    />
                  );
                })}

                {/* crosshair + hover markers (on the drawn curve) */}
                {hover && hoverX !== null && hoverTime !== null ? (
                  <g pointerEvents="none">
                    <line x1={hoverX} x2={hoverX} y1={PAD_TOP} y2={PAD_TOP + layout.plotH} stroke="rgba(255,255,255,0.28)" />
                    {spec.lines.map((line) => {
                      const value = lineValueAt(line.points, hoverTime);
                      if (value === null) return null;
                      return (
                        <circle
                          key={`hover-${line.key}`}
                          cx={hoverX}
                          cy={layout.yOf(value)}
                          r={4}
                          fill={line.color}
                          stroke="#050505"
                          strokeWidth={2}
                        />
                      );
                    })}
                  </g>
                ) : null}
              </svg>

              {hover && hoverX !== null ? (
                <div
                  className="pointer-events-none absolute z-10 min-w-44 rounded-[4px] border border-line bg-panel px-3 py-2 text-xs shadow-lg"
                  style={
                    hoverX > width / 2
                      ? { right: width - hoverX + 14, top: PAD_TOP + 6 }
                      : { left: hoverX + 14, top: PAD_TOP + 6 }
                  }
                >
                  <p className="font-semibold text-foreground">{hover.title}</p>
                  {hover.estimated ? (
                    <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
                      Estimated from closed trades
                    </p>
                  ) : null}
                  <div className="mt-1.5 space-y-1">
                    {hover.rows.map((row) => (
                      <div key={row.label} className="flex items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-muted">
                          {row.color ? (
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                          ) : null}
                          {row.label}
                        </span>
                        <span className="font-semibold tabular-nums text-foreground">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {spec && !message && spec.legend.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]" aria-label="Chart series">
            {spec.legend.map((item) => {
              const body = (
                <>
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${item.active ? item.color : "border border-muted/60"}`}
                    aria-hidden="true"
                  />
                  <span className={`font-semibold ${item.active ? "text-foreground" : "text-muted"}`}>{item.label}</span>
                  {item.value && item.active ? <span className="tabular-nums text-muted">{item.value}</span> : null}
                </>
              );
              const chip = "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1";
              return item.toggleable ? (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => toggleSeries(item)}
                  aria-pressed={item.active}
                  title={`${item.helper} - click to ${item.active ? "hide" : "show"}`}
                  className={`${chip} transition ${
                    item.active ? "border-line bg-panel" : "border-line/50 bg-background opacity-70 hover:opacity-100"
                  }`}
                >
                  {body}
                </button>
              ) : (
                <span key={item.key} title={item.helper} className={`${chip} border-line/50 bg-background`}>
                  {body}
                </span>
              );
            })}
          </div>
        ) : null}

        {notes.length > 0 ? (
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer select-none font-semibold text-muted hover:text-foreground">
              Notes ({notes.length})
            </summary>
            <ul className="mt-2 space-y-1.5 leading-5">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {dto && !message ? (
          <p className="mt-3 text-[11px] text-muted">
            {[
              `${dto.coverage.snapshotSamples} recorded points`,
              dto.coverage.estimatedSamples > 0 ? `${dto.coverage.estimatedSamples} estimated points` : null,
              `${dto.stats.tradeCount} closed trades`,
              (dto.coverage.cashFlowCount ?? 0) > 0 ? `${dto.coverage.cashFlowCount} deposits / withdrawals` : null,
              `${formatRangeDate(dto.start)} – ${formatRangeDate(dto.end)}`,
              dto.coverage.stale ? "ends at the last recorded data" : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
