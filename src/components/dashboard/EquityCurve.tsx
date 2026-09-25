import type { EquityPoint } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";
import { toSmoothAreaPath, toSmoothPath } from "@/lib/charts/svgCurve";

function compactMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

function compactDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function EquityCurve({
  data,
  title,
  description,
  currency = "USD",
}: {
  data: EquityPoint[];
  title?: string;
  description?: string;
  currency?: string;
}) {
  return EquityCurvePanel({ data, title, description, currency });
}

function EquityCurvePanel({
  data,
  title = "Equity curve",
  description = "Account growth and intraday volatility",
  currency,
}: {
  data: EquityPoint[];
  title?: string;
  description?: string;
  currency: string;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-72 flex-col justify-between rounded-[4px] border border-line bg-panel p-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted">No equity data yet</p>
        </div>
      </div>
    );
  }

  const width = 900;
  const height = 235;
  const padding = {
    top: 16,
    right: 22,
    bottom: 28,
    left: 68,
  };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const samples = [...data]
    .map((point) => ({ ...point, at: new Date(point.capturedAt).getTime() }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.equity))
    .sort((left, right) => left.at - right.at);
  if (samples.length === 0) return EquityCurvePanel({ data: [], title, description, currency });
  const values = samples.map((point) => point.equity);
  const actualMin = Math.min(...values);
  const actualMax = Math.max(...values);
  const actualRange = actualMax - actualMin;
  const buffer =
    actualRange > 0
      ? actualRange * 0.1
      : Math.max(Math.abs(actualMax) * 0.002, 100);
  const min = actualMin - buffer;
  const max = actualMax + buffer;
  const range = max - min || 1;
  const firstTime = samples[0]?.at ?? 0;
  const lastTime = samples.at(-1)?.at ?? firstTime;
  const points = samples.map((point, index) => {
    const x = padding.left + (samples.length === 1
      ? plotWidth
      : ((point.at - firstTime) / Math.max(lastTime - firstTime, 1)) * plotWidth);
    const y = padding.top + ((max - point.equity) / range) * plotHeight;
    return { x, y, point };
  });
  const curvePoints = points.map(({ x, y }) => ({ x, y }));
  const linePath = toSmoothPath(curvePoints);
  const areaPath = toSmoothAreaPath(curvePoints, height - padding.bottom);
  const latest = samples[samples.length - 1];
  const axisTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const value = max - range * ratio;
    const y = padding.top + plotHeight * ratio;
    return { value, y };
  });
  const firstPoint = samples[0];
  const latestCoordinate = points[points.length - 1];

  return (
    <div className="h-72 rounded-[4px] border border-line bg-panel p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
        <span className="shrink-0 text-base font-semibold tabular-nums text-accent">
          {formatMoney({ amount: latest.equity, currency })}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[220px] w-full overflow-visible"
        role="img"
        aria-label="Equity curve"
      >
        <defs>
          <linearGradient id="equitySvgGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#21d19f" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#21d19f" stopOpacity="0" />
          </linearGradient>
        </defs>
        {axisTicks.map((tick) => (
          <g key={tick.y}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={tick.y}
              y2={tick.y}
              stroke="#1d3832"
              strokeDasharray="4 8"
              strokeWidth="1"
            />
            <text
              x={padding.left - 12}
              y={tick.y + 4}
              textAnchor="end"
              className="fill-muted text-[11px]"
            >
              {compactMoney(tick.value, currency)}
            </text>
          </g>
        ))}
        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={height - padding.bottom}
          y2={height - padding.bottom}
          stroke="#23302b"
          strokeWidth="1"
        />
        <path d={areaPath} fill="url(#equitySvgGradient)" />
        <path
          d={linePath}
          fill="none"
          stroke="#21d19f"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {latestCoordinate ? (
          <circle
            cx={latestCoordinate.x}
            cy={latestCoordinate.y}
            r="5"
            fill="#050807"
            stroke="#21d19f"
            strokeWidth="3"
          />
        ) : null}
        <text
          x={padding.left}
          y={height - 7}
          textAnchor="start"
          className="fill-muted text-[11px]"
        >
          {compactDate(firstPoint.capturedAt)}
        </text>
        <text
          x={width - padding.right}
          y={height - 7}
          textAnchor="end"
          className="fill-muted text-[11px]"
        >
          {compactDate(latest.capturedAt)}
        </text>
      </svg>
    </div>
  );
}
