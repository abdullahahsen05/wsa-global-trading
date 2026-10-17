"use client";

import { useMemo } from "react";
import { TimeSeriesAreaChart, type TimeSeries } from "@/components/charts/TimeSeriesAreaChart";
import type { EquityPoint } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";

/**
 * Equity panel for a plain list of timestamped equity values (admin overview).
 * Draws exactly the points it receives on a real time axis; per-account
 * Myfxbook-style history lives in `AccountPerformanceChart`.
 */
export function EquityCurve({
  data,
  title = "Equity curve",
  description = "Account growth and intraday volatility",
  currency = "USD",
}: {
  data: EquityPoint[];
  title?: string;
  description?: string;
  currency?: string;
}) {
  const series = useMemo<TimeSeries[]>(
    () => [
      {
        key: "equity",
        label: "Equity",
        color: "#21d19f",
        area: true,
        width: 3,
        points: data
          .map((point) => ({ t: new Date(point.capturedAt).getTime(), value: Number(point.equity) }))
          .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value)),
      },
    ],
    [data],
  );

  const latest = series[0].points.reduce<{ t: number; value: number } | null>(
    (best, point) => (best === null || point.t >= best.t ? point : best),
    null,
  );

  if (!latest) {
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

  return (
    <div className="h-72 rounded-[4px] border border-line bg-panel p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
        <span className="shrink-0 text-base font-semibold tabular-nums text-accent">
          {formatMoney({ amount: latest.value, currency })}
        </span>
      </div>
      <TimeSeriesAreaChart series={series} currency={currency} height={190} ariaLabel={`${title} chart`} />
    </div>
  );
}
