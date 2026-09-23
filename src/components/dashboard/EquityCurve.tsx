import type { EquityPoint } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";

type ChartCoordinate = {
  x: number;
  y: number;
};

function toActualSmoothPath(points: ChartCoordinate[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2)
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

  const [first, second] = points;
  const commands = [
    `M ${first.x} ${first.y}`,
    `Q ${first.x} ${first.y} ${(first.x + second.x) / 2} ${(first.y + second.y) / 2}`,
  ];

  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    commands.push(`T ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`);
  }

  const last = points[points.length - 1];
  commands.push(`T ${last.x} ${last.y}`);
  return commands.join(" ");
}

function toActualAreaPath(
  points: ChartCoordinate[],
  baselineY: number,
): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x} ${baselineY} L ${point.x} ${point.y} L ${point.x} ${baselineY} Z`;
  }

  const line = toActualSmoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

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
  const values = data.map((point) => point.equity);
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
  const points = data.map((point, index) => {
    const x = padding.left + (index / Math.max(data.length - 1, 1)) * plotWidth;
    const y = padding.top + ((max - point.equity) / range) * plotHeight;
    return { x, y, point };
  });
  const curvePoints = points.map(({ x, y }) => ({ x, y }));
  const linePath = toActualSmoothPath(curvePoints);
  const areaPath = toActualAreaPath(curvePoints, height - padding.bottom);
  const latest = data[data.length - 1];
  const axisTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const value = max - range * ratio;
    const y = padding.top + plotHeight * ratio;
    return { value, y };
  });
  const firstPoint = data[0];
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
        <circle
          cx={latestCoordinate.x}
          cy={latestCoordinate.y}
          r="5"
          fill="#050807"
          stroke="#21d19f"
          strokeWidth="3"
        />
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
