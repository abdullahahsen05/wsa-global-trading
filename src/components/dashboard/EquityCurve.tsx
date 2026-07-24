import type { EquityPoint } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";

export function EquityCurve({
  data,
  title,
  description,
}: {
  data: EquityPoint[];
  title?: string;
  description?: string;
}) {
  return EquityCurvePanel({ data, title, description });
}

function EquityCurvePanel({
  data,
  title = "Equity curve",
  description = "Account growth and intraday volatility",
}: {
  data: EquityPoint[];
  title?: string;
  description?: string;
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
  const padding = 14;
  const values = data.map((point) => point.equity);
  const min = Math.min(...values) - 300;
  const max = Math.max(...values) + 300;
  const range = max - min || 1;
  const points = data.map((point, index) => {
    const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((point.equity - min) / range) * (height - padding * 2);
    return { x, y, point };
  });
  const line = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const area = `${padding},${height - padding} ${line} ${width - padding},${height - padding}`;
  const latest = data[data.length - 1];

  return (
    <div className="h-72 rounded-[4px] border border-line bg-panel p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
        <span className="shrink-0 text-base font-semibold tabular-nums text-accent">
          {formatMoney({ amount: latest.equity, currency: "USD" })}
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
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={padding}
            x2={width - padding}
            y1={height * ratio}
            y2={height * ratio}
            stroke="#1d3832"
            strokeWidth="1"
          />
        ))}
        <polygon points={area} fill="url(#equitySvgGradient)" />
        <polyline points={line} fill="none" stroke="#21d19f" strokeWidth="2.5" />
        {points.slice(-1).map(({ x, y }) => (
          <g key="latest">
            <circle cx={x} cy={y} r="5" fill="#07100f" stroke="#21d19f" strokeWidth="2" />
            <circle cx={x} cy={y} r="2" fill="#21d19f" />
          </g>
        ))}
      </svg>
    </div>
  );
}
