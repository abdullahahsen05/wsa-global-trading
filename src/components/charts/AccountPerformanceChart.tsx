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
  lastIndexAtOrBefore,
  nearestIndexByTime,
  timeAxisLabels,
  timeTicks,
  type PerformanceRange,
  type PerformanceSeriesDto,
} from "@/lib/charts/performanceSeries";
import {
  CHART_TABS,
  buildChartSpec,
  tooltipAt,
  type ChartEmptyReason,
  type ChartLine,
  type ChartMarker,
  type ChartSpec,
  type ChartTab,
} from "@/lib/charts/performanceChartSpec";
import { toLinearAreaPath, toLinearPath, toStepAreaPath, toStepPath } from "@/lib/charts/svgCurve";
import { formatMoney } from "@/lib/utils/format";

/**
 * Myfxbook-style account performance chart.
 *
 * One component for every place that shows an account curve (trader dashboard,
 * analytics, account detail). All numbers come from `/api/analytics/performance`
 * (recorded snapshots + closed trades); nothing on the chart is invented. Parts
 * rebuilt from closed trades are drawn dotted and labelled as estimates.
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
const PAD_TOP = 40;
/** room for the tick label and, under it, the day or year it belongs to */
const PAD_BOTTOM = 50;
/** the stretch before an account's first data is only marked when it is at least this much of the axis */
const MIN_BAND_SHARE = 0.01;
/** ...and only explained in words when it is this much */
const HINT_BAND_SHARE = 0.08;

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

const LEGEND_GRID: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-5",
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
  const derived = useMemo(() => (dto ? deriveSeries(dto) : null), [dto]);
  const currency = safeCurrency(dto?.currency ?? currencyProp);
  const hidden = hiddenByTab[tab] ?? EMPTY_HIDDEN;

  const compact = width > 0 && width < 560;
  const height = compact ? 300 : 390;
  const barCount = Math.max(8, Math.floor((width || 800) / 16));

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
    });
  }, [dto, derived, tab, hidden, currency, barCount, currentDrawdownPercent]);

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
    const leftLabels = spec.ticks.map((tick) => spec.formatY(tick));
    const right = spec.right;
    const rightLabels = right ? right.ticks.map((tick) => right.formatY(tick)) : [];
    // the axis text is 11 px (12 px from a tablet up): a digit is about 7 / 7.8 px wide
    const charWidth = compact ? 7 : 7.8;
    const padLeft = clamp(longest(leftLabels) * charWidth + 18, 52, 124);
    const padRight = right ? clamp(longest(rightLabels) * charWidth + 18, 52, 124) : 34;
    const plotW = Math.max(60, width - padLeft - padRight);
    const plotH = height - PAD_TOP - PAD_BOTTOM;
    const span = Math.max(1, derived.end - derived.start);
    const ySpan = Math.max(1e-9, spec.yMax - spec.yMin);
    const xOf = (time: number) => padLeft + clamp((time - derived.start) / span, 0, 1) * plotW;
    const yOf = (value: number) => PAD_TOP + (1 - clamp((value - spec.yMin) / ySpan, 0, 1)) * plotH;
    const baselineY =
      spec.zeroValue !== null ? yOf(spec.zeroValue) : PAD_TOP + plotH;
    // about one tick per 96 px: room for "Oct 12" / "14:05" at 12 px with air around them
    const timeTickValues = timeTicks(derived.start, derived.end, clamp(Math.floor(plotW / 96), 2, 10));
    const timeLabels = timeAxisLabels(timeTickValues, span);
    // the stretch before the account's first data: marked, never drawn into
    const historyX = xOf(derived.historyStart);
    const bandW =
      derived.historyStart - derived.start >= span * MIN_BAND_SHARE ? historyX - padLeft : 0;
    return {
      padLeft,
      padRight,
      plotW,
      plotH,
      span,
      xOf,
      yOf,
      baselineY,
      timeLabels,
      historyX,
      bandW,
      leftLabels,
      rightLabels,
    };
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

  const toggleSeries = (key: string) => {
    if (!spec) return;
    setHiddenByTab((current) => {
      const forTab = { ...(current[tab] ?? {}) };
      forTab[key] = !forTab[key];
      const toggleKeys = spec.legend
        .filter((item) => item.toggleable && item.key !== "markers")
        .map((item) => item.key);
      // never switch off the last visible series
      if (toggleKeys.every((candidate) => forTab[candidate] === true)) return current;
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

  // ── notices ────────────────────────────────────────────────────────────────
  const notices: string[] = [];
  if (dto && !message) {
    const last = dto.coverage.lastSnapshotAt;
    const lastData = dto.coverage.lastDataAt;
    if (dto.coverage.stale && lastData !== null) {
      notices.push(
        `Recording stopped ${formatAge(dto.generatedAt - lastData)} ago (last data: ${formatTooltipTime(lastData)}). The chart is calibrated to the period that has data and ends there. It grows again once the risk worker and the broker connection record new snapshots for ${dto.coverage.aggregate ? "these accounts" : "this account"}.`,
      );
    } else if (last !== null && dto.generatedAt - last > PERFORMANCE_STALE_AFTER_MS) {
      notices.push(
        `Last balance snapshot: ${formatTooltipTime(last)} (${formatAge(dto.generatedAt - last)} ago). The curve only grows while the platform keeps recording snapshots for ${dto.coverage.aggregate ? "these accounts" : "this account"} — if the risk worker or the broker connection is stopped, it ends at the last snapshot.`,
      );
    }
    if (derived?.hasEstimated) {
      const gaps = dto.coverage.gapCount;
      notices.push(
        gaps > 0
          ? `Dotted segments are estimates: ${gaps} stretch${gaps === 1 ? "" : "es"} without recorded snapshots ${gaps === 1 ? "was" : "were"} bridged using the closed trades of that period.`
          : "Dotted segments are estimated from closed trades because no snapshot was recorded for that period.",
      );
    }
    const flowCount = dto.coverage.cashFlowCount ?? 0;
    if (flowCount > 0 && derived) {
      const plural = flowCount === 1 ? "" : "s";
      notices.push(
        derived.cashFlowCount > 0
          ? `Growth and drawdown leave out ${flowCount} deposit${plural} / withdrawal${plural} (net ${formatMoney({ amount: derived.netCashFlow, currency })}): paying money in or out is not counted as profit or loss.`
          : `${flowCount} deposit${plural} / withdrawal${plural} fall outside the drawn curve and do not change growth or drawdown.`,
      );
    }
    if (derived && derived.joinedAccounts > 0) {
      const count = derived.joinedAccounts;
      notices.push(
        `${count} account${count === 1 ? " was" : "s were"} connected during this period (${formatMoney({ amount: derived.joinedAmount, currency })} in total): the combined curve steps up when each one joins, and growth and drawdown leave that out.`,
      );
    }
    const droppedReadings = dto.coverage.glitchSamplesDropped ?? 0;
    if (droppedReadings > 0) {
      notices.push(
        `${droppedReadings} stored reading${droppedReadings === 1 ? "" : "s"} that cannot be real (for example equity 0 next to a positive balance) ${droppedReadings === 1 ? "was" : "were"} left out of the curve.`,
      );
    }
    if (derived && derived.points.length === 1 && tab !== "PROFIT") {
      notices.push("Only one balance snapshot exists in this range so far — the line appears as soon as a second one is recorded.");
    }
    if (spec?.missingSnapshots) {
      notices.push("No balance snapshots in this range: only the closed-trade curve can be drawn.");
    }
    if (derived && derived.points.length > 0 && dto.stats.tradeCount === 0) {
      notices.push("No closed trades in this range — the curve follows balance and equity only.");
    }
    if (dto.coverage.tradesTruncated) {
      notices.push("This account has more closed trades than the chart can load; the oldest ones are used and the newest may be missing.");
    }
    if (dto.coverage.aggregate && dto.coverage.aggregateLimitedToDays) {
      notices.push(
        `The combined curve of all connected accounts covers the last ${dto.coverage.aggregateLimitedToDays} days; the part of this period before that is left empty.`,
      );
    }
    if (query.isError) {
      notices.push("The last refresh failed; showing the most recently loaded history.");
    }
  }

  // The period is longer than the history: say so, and offer the view that fits.
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
    `Broker-synced equity growth, closed P&L and traded volume from ${displayName}, drawn from stored account snapshots and closed trades.`;

  // ── hover content ──────────────────────────────────────────────────────────
  const hover =
    layout && derived && hoverTime !== null && hoverTime >= derived.start - 1 && hoverTime <= derived.end + 1
      ? tooltipAt({ derived, tab, time: hoverTime, currency })
      : null;
  const hoverX = layout && hover ? layout.xOf(hoverTime as number) : null;

  const renderLine = (line: ChartLine, lineIndex: number) => {
    if (!layout || !spec) return null;
    const pixels: PixelPoint[] = line.points.map((point) => ({
      x: layout.xOf(point.t),
      y: layout.yOf(point.v),
      estimated: point.estimated === true,
    }));
    const runs = splitRuns(pixels);
    const belowBaseline = line.points.length > 0 && line.points.every((point) => point.v <= (spec.zeroValue ?? 0));
    const gradientId = `${uid}fill${lineIndex}`;
    return (
      <g key={line.key}>
        {line.area ? (
          <>
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={line.color} stopOpacity="0.3" />
                <stop offset="100%" stopColor={line.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {runs
              .filter((run) => !run.estimated)
              .map((run, runIndex) => {
                const d = line.step
                  ? toStepAreaPath(run.points, layout.baselineY)
                  : toLinearAreaPath(run.points, layout.baselineY);
                if (!d) return null;
                return (
                  <path
                    key={`area-${runIndex}`}
                    d={d}
                    fill={belowBaseline && spec.zeroValue !== null ? line.color : `url(#${gradientId})`}
                    fillOpacity={belowBaseline && spec.zeroValue !== null ? 0.16 : 1}
                  />
                );
              })}
          </>
        ) : null}
        {runs.map((run, runIndex) => {
          const d = line.step ? toStepPath(run.points) : toLinearPath(run.points);
          if (!d) return null;
          return (
            <path
              key={`line-${runIndex}`}
              d={d}
              fill="none"
              stroke={line.color}
              strokeWidth={run.estimated ? Math.max(2, line.width - 1) : line.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={run.estimated ? "2 7" : line.dashed ? "9 9" : undefined}
              opacity={run.estimated ? 0.85 : 1}
            />
          );
        })}
      </g>
    );
  };

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

      <div className="px-4 pb-5 pt-4 sm:px-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1 rounded-[4px] border border-line bg-background p-1">
            {CHART_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => selectTab(entry.id)}
                aria-pressed={tab === entry.id}
                className={`rounded-[3px] px-3 py-2 text-xs font-semibold transition ${
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
                  className={`rounded-[3px] px-3 py-2 text-xs font-semibold transition ${
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

        {notices.length > 0 || (showHistoryHint && derived && firstDataAt !== null) ? (
          <div className="mb-3 space-y-2">
            {showHistoryHint && derived && firstDataAt !== null ? (
              <p className="rounded-[4px] border border-line border-l-accent bg-panel px-3 py-2 text-xs leading-5 text-muted [border-left-width:3px]">
                The axis shows the {RANGE_WORDS[range]}, but {dto?.coverage.aggregate ? "these accounts have" : "this account has"} data only since{" "}
                <span className="font-semibold text-foreground">{formatRangeDate(derived.historyStart)}</span> (
                {formatAge(derived.end - derived.historyStart)}). The shaded stretch before it has none.
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
            {notices.map((notice) => (
              <p
                key={notice}
                className="rounded-[4px] border border-line border-l-accent bg-panel px-3 py-2 text-xs leading-5 text-muted [border-left-width:3px]"
              >
                {notice}
              </p>
            ))}
          </div>
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
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,rgba(255,207,0,0.12),transparent_34%),radial-gradient(circle_at_75%_70%,rgba(33,209,159,0.12),transparent_30%)]" />

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
                  <pattern
                    id={`${uid}nodata`}
                    width="9"
                    height="9"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <rect width="9" height="9" fill="rgba(255,255,255,0.02)" />
                    <line x1="0" y1="0" x2="0" y2="9" stroke="rgba(255,255,255,0.07)" strokeWidth="3" />
                  </pattern>
                </defs>

                {/* frame */}
                <line x1={layout.padLeft} x2={layout.padLeft} y1={PAD_TOP} y2={PAD_TOP + layout.plotH} stroke="rgba(255,255,255,0.12)" />
                <line x1={layout.padLeft + layout.plotW} x2={layout.padLeft + layout.plotW} y1={PAD_TOP} y2={PAD_TOP + layout.plotH} stroke="rgba(255,255,255,0.12)" />
                <line x1={layout.padLeft} x2={layout.padLeft + layout.plotW} y1={PAD_TOP + layout.plotH} y2={PAD_TOP + layout.plotH} stroke="rgba(255,255,255,0.12)" />

                {/* horizontal grid + value axes */}
                {spec.ticks.map((tick, index) => {
                  const y = layout.yOf(tick);
                  return (
                    <g key={`y-${tick}`}>
                      <line x1={layout.padLeft} x2={layout.padLeft + layout.plotW} y1={y} y2={y} stroke="rgba(255,255,255,0.08)" strokeDasharray="7 10" />
                      <text x={layout.padLeft - 10} y={y + 4} textAnchor="end" className={`fill-muted ${compact ? "text-[11px]" : "text-xs"} font-semibold tabular-nums`}>
                        {layout.leftLabels[index]}
                      </text>
                      {spec.right ? (
                        <text x={layout.padLeft + layout.plotW + 10} y={y + 4} textAnchor="start" className={`fill-muted ${compact ? "text-[11px]" : "text-xs"} font-semibold tabular-nums`}>
                          {layout.rightLabels[index]}
                        </text>
                      ) : null}
                    </g>
                  );
                })}

                {/* time axis: the label, and under it the day or year it belongs to */}
                {layout.timeLabels.map((tick) => {
                  const x = layout.xOf(tick.time);
                  return (
                    <g key={`x-${tick.time}`}>
                      <line x1={x} x2={x} y1={PAD_TOP} y2={PAD_TOP + layout.plotH + 4} stroke="rgba(255,255,255,0.06)" />
                      <text x={x} y={PAD_TOP + layout.plotH + 19} textAnchor="middle" className={`fill-muted ${compact ? "text-[11px]" : "text-xs"} font-semibold tabular-nums`}>
                        {tick.label}
                      </text>
                      {tick.sub ? (
                        <text x={x} y={PAD_TOP + layout.plotH + 34} textAnchor="middle" className="fill-muted/70 text-[10px] font-medium tabular-nums">
                          {tick.sub}
                        </text>
                      ) : null}
                    </g>
                  );
                })}

                <text x={layout.padLeft} y={22} textAnchor="start" className="fill-accent-2 text-[11px] font-bold uppercase tracking-[0.16em]">
                  {spec.axisTitle}
                </text>
                {spec.right ? (
                  <text x={layout.padLeft + layout.plotW} y={22} textAnchor="end" className="fill-accent text-[11px] font-bold uppercase tracking-[0.16em]">
                    {spec.right.title}
                  </text>
                ) : null}

                {/* plot content */}
                <g clipPath={`url(#${uid}clip)`}>
                  {layout.bandW > 0 && derived ? (
                    <g pointerEvents="none">
                      <rect x={layout.padLeft} y={PAD_TOP} width={layout.bandW} height={layout.plotH} fill={`url(#${uid}nodata)`}>
                        <title>{`No data before ${formatTooltipTime(derived.historyStart)}`}</title>
                      </rect>
                      <line
                        x1={layout.historyX}
                        x2={layout.historyX}
                        y1={PAD_TOP}
                        y2={PAD_TOP + layout.plotH}
                        stroke="rgba(255,207,0,0.5)"
                        strokeDasharray="3 5"
                      />
                      {layout.bandW >= 104 ? (
                        <>
                          <text x={layout.padLeft + layout.bandW / 2} y={PAD_TOP + layout.plotH / 2 - 4} textAnchor="middle" className="fill-muted text-[11px] font-semibold">
                            No data before
                          </text>
                          <text x={layout.padLeft + layout.bandW / 2} y={PAD_TOP + layout.plotH / 2 + 12} textAnchor="middle" className="fill-muted text-[11px] font-semibold">
                            {formatRangeDate(derived.historyStart)}
                          </text>
                        </>
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
                        rx="3"
                        fill={spec.barColor}
                      />
                    );
                  })}
                  {spec.zeroValue !== null ? (
                    <line
                      x1={layout.padLeft}
                      x2={layout.padLeft + layout.plotW}
                      y1={layout.yOf(spec.zeroValue)}
                      y2={layout.yOf(spec.zeroValue)}
                      stroke="rgba(255,255,255,0.18)"
                    />
                  ) : null}
                  {spec.lines.map((line, index) => renderLine(line, index))}
                  {spec.markers.map((marker) => (
                    <circle
                      key={`marker-${marker.t}`}
                      cx={layout.xOf(marker.t)}
                      cy={layout.yOf(marker.v)}
                      r={marker.count > 1 ? 3.6 : 3}
                      fill={MARKER_COLORS[marker.kind]}
                      stroke="#050505"
                      strokeWidth={1.2}
                      opacity={0.92}
                      pointerEvents="none"
                    />
                  ))}
                </g>

                {/* latest point of every line */}
                {spec.lines.map((line) => {
                  const last = line.points[line.points.length - 1];
                  if (!last) return null;
                  return (
                    <circle
                      key={`last-${line.key}`}
                      cx={layout.xOf(last.t)}
                      cy={layout.yOf(last.v)}
                      r={5}
                      fill="#050505"
                      stroke={line.color}
                      strokeWidth={3}
                    />
                  );
                })}

                {/* crosshair + hover markers */}
                {hover && hoverX !== null && hoverTime !== null ? (
                  <g pointerEvents="none">
                    <line x1={hoverX} x2={hoverX} y1={PAD_TOP} y2={PAD_TOP + layout.plotH} stroke="rgba(255,255,255,0.35)" strokeDasharray="4 4" />
                    {spec.lines.map((line) => {
                      if (line.points.length === 0) return null;
                      const lineTimes = line.points.map((point) => point.t);
                      const index = line.step
                        ? lastIndexAtOrBefore(lineTimes, hoverTime)
                        : nearestIndexByTime(lineTimes, hoverTime);
                      const point = index >= 0 ? line.points[index] : null;
                      if (!point) return null;
                      return (
                        <circle
                          key={`hover-${line.key}`}
                          cx={layout.xOf(line.step ? hoverTime : point.t)}
                          cy={layout.yOf(point.v)}
                          r={4.5}
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
          <div
            className={`mt-4 grid grid-cols-1 gap-3 text-xs text-muted ${LEGEND_GRID[Math.min(5, spec.legend.length)] ?? "sm:grid-cols-4"}`}
          >
            {spec.legend.map((item) => {
              const badge = !item.active ? "Hidden" : (item.value ?? (item.toggleable ? "Shown" : ""));
              const body = (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${item.active ? item.color : "bg-muted/40"}`} />
                      <span className="font-semibold text-foreground">{item.label}</span>
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted tabular-nums">
                      {badge}
                    </span>
                  </div>
                  <p className="mt-1">{item.helper}</p>
                </>
              );
              return item.toggleable ? (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => toggleSeries(item.key)}
                  aria-pressed={item.active}
                  className={`rounded-[4px] border px-3 py-3 text-left transition ${
                    item.active
                      ? "border-line bg-panel text-muted"
                      : "border-line/60 bg-background text-muted/60 opacity-70"
                  }`}
                >
                  {body}
                </button>
              ) : (
                <div key={item.key} className="rounded-[4px] border border-line bg-panel px-3 py-3">
                  {body}
                </div>
              );
            })}
          </div>
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
