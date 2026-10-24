"use client";

import { useId, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useElementWidth } from "@/hooks/useElementWidth";
import {
  formatAxisMoney,
  formatTooltipTime,
  nearestIndexByTime,
  niceScale,
  timeAxisLabels,
  timeTicks,
} from "@/lib/charts/performanceSeries";
import { downsampleLttb } from "@/lib/charts/downsample";
import { toSmoothAreaPath, toSmoothPath } from "@/lib/charts/svgCurve";

/**
 * Plain money-over-time chart for places that only have a list of timestamped
 * values (admin overview, equity panels). Real time axis, round axis values,
 * hover read-out. The curve is smooth (it passes through every point it draws and never overshoots) and long series
 * are thinned to what the width can show - a subset of the given points, none moved or generated.
 */

export interface TimeSeriesPoint {
  /** epoch milliseconds */
  t: number;
  value: number;
}

export interface TimeSeries {
  key: string;
  label: string;
  color: string;
  points: TimeSeriesPoint[];
  area?: boolean;
  width?: number;
}

export interface TimeSeriesAreaChartProps {
  series: TimeSeries[];
  currency: string;
  height?: number;
  ariaLabel: string;
  className?: string;
}

const MIN_SPAN_MS = 10 * 60 * 1000;
const PAD_TOP = 16;
/** room for the tick label and, under it, the day or year it belongs to */
const PAD_BOTTOM = 44;
const PAD_RIGHT = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeCurrency(code: string): string {
  const trimmed = code.trim();
  return /^[A-Za-z]{3}$/.test(trimmed) ? trimmed.toUpperCase() : "USD";
}

export function TimeSeriesAreaChart({
  series,
  currency: currencyProp,
  height = 235,
  ariaLabel,
  className = "",
}: TimeSeriesAreaChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const currency = safeCurrency(currencyProp);
  const [frameRef, width] = useElementWidth<HTMLDivElement>();
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const cleaned = useMemo(
    () =>
      series.map((entry) => ({
        ...entry,
        points: entry.points
          .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value))
          .sort((left, right) => left.t - right.t),
      })),
    [series],
  );

  const model = useMemo(() => {
    const all = cleaned.flatMap((entry) => entry.points);
    if (all.length === 0) return null;
    let min = all[0].value;
    let max = all[0].value;
    let start = all[0].t;
    let end = all[0].t;
    for (const point of all) {
      if (point.value < min) min = point.value;
      if (point.value > max) max = point.value;
      if (point.t < start) start = point.t;
      if (point.t > end) end = point.t;
    }
    if (end - start < MIN_SPAN_MS) {
      const middle = (start + end) / 2;
      start = middle - MIN_SPAN_MS / 2;
      end = middle + MIN_SPAN_MS / 2;
    }
    const scale = niceScale(min, max, { minSpan: Math.max(Math.abs(max) * 0.004, 1) });
    return { start, end, scale, pointCount: all.length };
  }, [cleaned]);

  // about one drawn point per 4 px of width: a curve, not a hairy line (the scale above still comes from every point)
  const budget = clamp(Math.round((width || 800) / 4), 60, 240);
  const drawn = useMemo(
    () =>
      cleaned.map((entry) => ({
        ...entry,
        points: downsampleLttb(
          entry.points,
          budget,
          (point) => point.t,
          (point) => point.value,
        ),
      })),
    [cleaned, budget],
  );

  const primaryTimes = useMemo(() => (drawn[0] ? drawn[0].points.map((point) => point.t) : []), [drawn]);

  const money = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.round(value * 100) === 0 ? 0 : value);

  // The frame (and its measuring ref) is always rendered, so the width is known
  // as soon as data arrives.
  let content: ReactNode = null;
  let handlePointer: ((event: ReactPointerEvent<HTMLDivElement>) => void) | undefined;

  if (!model) {
    content = (
      <div className="flex h-full items-center justify-center text-sm text-muted">No data to draw yet.</div>
    );
  } else if (width > 0) {
    const { start, end, scale } = model;
    const span = end - start;
    const labels = scale.ticks.map((tick) => formatAxisMoney(tick, currency, scale.step));
    const padLeft = clamp(labels.reduce((max, label) => Math.max(max, label.length), 0) * 7.2 + 18, 52, 116);
    const plotW = Math.max(60, width - padLeft - PAD_RIGHT);
    const plotH = height - PAD_TOP - PAD_BOTTOM;
    const xOf = (time: number) => padLeft + clamp((time - start) / span, 0, 1) * plotW;
    const yOf = (value: number) =>
      PAD_TOP + (1 - clamp((value - scale.min) / Math.max(1e-9, scale.max - scale.min), 0, 1)) * plotH;
    const baselineY = PAD_TOP + plotH;
    const xTicks = timeAxisLabels(timeTicks(start, end, clamp(Math.floor(plotW / 100), 2, 8)), span);

    handlePointer = (event) => {
      const target = event.currentTarget;
      const x = event.clientX - target.getBoundingClientRect().left - target.clientLeft;
      if (x < padLeft || x > padLeft + plotW || primaryTimes.length === 0) {
        setHoverTime(null);
        return;
      }
      const raw = start + ((x - padLeft) / plotW) * span;
      const snapped = primaryTimes[nearestIndexByTime(primaryTimes, raw)];
      setHoverTime((current) => (current === snapped ? current : snapped));
    };

    const hoverRows =
      hoverTime === null
        ? []
        : drawn
            .map((entry) => {
              const times = entry.points.map((point) => point.t);
              const index = nearestIndexByTime(times, hoverTime);
              const point = index >= 0 ? entry.points[index] : null;
              return point ? { entry, point } : null;
            })
            .filter((row): row is { entry: (typeof drawn)[number]; point: TimeSeriesPoint } => row !== null);
    const hoverX = hoverTime === null ? null : xOf(hoverTime);

    content = (
      <>
        <svg width={width} height={height} className="block" role="img" aria-label={ariaLabel}>
          <defs>
            {drawn.map((entry, index) => (
              <linearGradient key={entry.key} id={`${uid}fill${index}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={entry.color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={entry.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {scale.ticks.map((tick, index) => (
            <g key={`y-${tick}`}>
              <line
                x1={padLeft}
                x2={padLeft + plotW}
                y1={yOf(tick)}
                y2={yOf(tick)}
                stroke="rgba(255,255,255,0.07)"
              />
              <text
                x={padLeft - 8}
                y={yOf(tick) + 4}
                textAnchor="end"
                className="fill-muted text-[11px] font-medium tabular-nums"
              >
                {labels[index]}
              </text>
            </g>
          ))}
          <line x1={padLeft} x2={padLeft + plotW} y1={baselineY} y2={baselineY} stroke="rgba(255,255,255,0.14)" />

          {xTicks.map((tick) => (
            <g key={`x-${tick.time}`}>
              <text
                x={xOf(tick.time)}
                y={baselineY + 18}
                textAnchor="middle"
                className="fill-muted text-[11px] font-semibold tabular-nums"
              >
                {tick.label}
              </text>
              {tick.sub ? (
                <text
                  x={xOf(tick.time)}
                  y={baselineY + 32}
                  textAnchor="middle"
                  className="fill-muted/70 text-[10px] font-medium tabular-nums"
                >
                  {tick.sub}
                </text>
              ) : null}
            </g>
          ))}

          {drawn.map((entry, index) => {
            // (one reading per pixel column: the smooth path needs x to increase)
            const pixels: Array<{ x: number; y: number }> = [];
            for (const point of entry.points) {
              const x = xOf(point.t);
              const y = yOf(point.value);
              if (pixels.length > 0 && x <= pixels[pixels.length - 1].x) pixels[pixels.length - 1] = { x, y };
              else pixels.push({ x, y });
            }
            const line = toSmoothPath(pixels);
            const area = entry.area ? toSmoothAreaPath(pixels, baselineY) : "";
            return (
              <g key={entry.key}>
                {area ? <path d={area} fill={`url(#${uid}fill${index})`} /> : null}
                {line ? (
                  <path
                    d={line}
                    fill="none"
                    stroke={entry.color}
                    strokeWidth={entry.width ?? 2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null}
              </g>
            );
          })}

          {drawn.map((entry) => {
            const last = entry.points[entry.points.length - 1];
            if (!last) return null;
            return (
              <circle
                key={`last-${entry.key}`}
                cx={xOf(last.t)}
                cy={yOf(last.value)}
                r={4}
                fill="#050505"
                stroke={entry.color}
                strokeWidth={2.5}
              />
            );
          })}

          {model.pointCount === 1 ? (
            <text
              x={padLeft + plotW / 2}
              y={PAD_TOP + 18}
              textAnchor="middle"
              className="fill-muted text-[11px] font-semibold"
            >
              Only one data point so far — the line appears once a second one is recorded.
            </text>
          ) : null}

          {hoverX !== null ? (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={PAD_TOP}
                y2={baselineY}
                stroke="rgba(255,255,255,0.28)"
              />
              {hoverRows.map((row) => (
                <circle
                  key={`hover-${row.entry.key}`}
                  cx={xOf(row.point.t)}
                  cy={yOf(row.point.value)}
                  r={4.5}
                  fill={row.entry.color}
                  stroke="#050505"
                  strokeWidth={2}
                />
              ))}
            </g>
          ) : null}
        </svg>

        {hoverX !== null && hoverRows.length > 0 && hoverTime !== null ? (
          <div
            className="pointer-events-none absolute z-10 min-w-40 rounded-[4px] border border-line bg-panel px-3 py-2 text-xs shadow-lg"
            style={
              hoverX > width / 2
                ? { right: width - hoverX + 14, top: PAD_TOP + 4 }
                : { left: hoverX + 14, top: PAD_TOP + 4 }
            }
          >
            <p className="font-semibold text-foreground">{formatTooltipTime(hoverTime)}</p>
            <div className="mt-1.5 space-y-1">
              {hoverRows.map((row) => (
                <div key={row.entry.key} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.entry.color }} />
                    {row.entry.label}
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">{money(row.point.value)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div
      ref={frameRef}
      className={`relative w-full ${className}`}
      style={{ height, touchAction: "pan-y" }}
      onPointerMove={handlePointer}
      onPointerDown={handlePointer}
      onPointerLeave={() => setHoverTime(null)}
    >
      {content}
    </div>
  );
}
