"use client";

import { useMemo, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import {
  formatHeld,
  formatHistoryTime,
  HISTORY_PERIODS,
  summarizeHistory,
  type HistoryPeriodId,
  type WebTradeHistoryRow,
} from "@/lib/trade/webTradeHistory";
import { formatLots, formatMoney, formatPercent, formatPrice, formatSigned, resultTone } from "@/lib/trade/webTradeFormat";
import { SideBadge } from "./Book";
import { BANNER_CLASS, CHIP_CLASS, Figure, toneClass } from "./ui";

/**
 * The History tab of WSA Trade: the closed trades of the account for a period, newest first, with the figures that
 * matter above them (how many, the net result, win rate, profit factor, best and worst). Read only. The first rows are
 * drawn; "Show more" adds the next ones, so a long record never makes the panel heavy.
 */

const PAGE = 40;

export interface HistoryTabProps {
  period: HistoryPeriodId;
  onPeriod: (period: HistoryPeriodId) => void;
  /** the synced rows with the ones just closed from the panel in front (`mergeHistory`) */
  rows: ReadonlyArray<WebTradeHistoryRow>;
  currency: string;
  /** the first read of this period is still under way */
  loading: boolean;
  /** why the list could not be read (null = fine) */
  error: string | null;
  /** the period holds more closed trades than the rows */
  truncated: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

function HistoryRow({ row }: { row: WebTradeHistoryRow }) {
  const tone = toneClass(resultTone(row.profit));
  const held = formatHeld(row.openedAt, row.closedAt);
  return (
    <li className="rounded-[4px] border border-line bg-background px-3 py-2" aria-label={`Closed trade ${row.symbol} ${row.ticket}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <SideBadge side={row.side} text={row.side === "BUY" ? "Buy" : "Sell"} />
            <span className="truncate">{row.symbol}</span>
            <span className="text-xs font-medium text-muted">{formatLots(row.volume)} lots</span>
            {row.local ? (
              <span className="text-[10px] font-medium text-muted" title="Closed just now: the confirmed record follows in a moment">
                just closed
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-xs tabular-nums text-muted">
            {formatPrice(row.openPrice)} → {formatPrice(row.closePrice)}
            {held ? ` · ${held}` : ""}
          </p>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted">
            {row.openedAt ? `${formatHistoryTime(row.openedAt)} → ` : "Closed "}
            {formatHistoryTime(row.closedAt)}
          </p>
        </div>
        <p
          className={`shrink-0 text-right text-sm font-semibold tabular-nums ${tone}`}
          title={row.local ? "The last floating result of the trade; the confirmed result replaces it" : undefined}
        >
          {row.local ? "≈ " : ""}
          {formatSigned(row.profit)}
        </p>
      </div>
    </li>
  );
}

export function HistoryTab({ period, onPeriod, rows, currency, loading, error, truncated, refreshing, onRefresh }: HistoryTabProps) {
  const [shown, setShown] = useState(PAGE);
  const summary = useMemo(() => summarizeHistory(rows), [rows]);
  const visible = rows.slice(0, shown);
  const hasLocal = rows.some((row) => row.local);

  return (
    <div className="space-y-2" role="tabpanel" aria-label="Trade history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="History period" className="flex flex-wrap gap-1.5">
          {HISTORY_PERIODS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`${CHIP_CLASS} ${entry.id === period ? "border-accent text-foreground" : ""}`}
              aria-pressed={entry.id === period}
              onClick={() => {
                if (entry.id === period) return;
                setShown(PAGE);
                onPeriod(entry.id);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn-dark text-xs" onClick={onRefresh} disabled={refreshing} aria-label="Refresh history">
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCw className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {error && rows.length === 0 ? (
        <p role="alert" className={`${BANNER_CLASS} text-danger`}>
          {error}
        </p>
      ) : loading && rows.length === 0 ? (
        <p role="status" className={`${BANNER_CLASS} text-muted`}>
          Reading the trade history…
        </p>
      ) : rows.length === 0 ? (
        <p role="status" className={`${BANNER_CLASS} text-muted`}>
          No closed trades in this period.
        </p>
      ) : (
        <>
          <div className="definition-grid grid grid-cols-3 gap-0" aria-label="History figures">
            <Figure label="Trades" value={`${summary.count}${truncated ? "+" : ""}`} />
            <Figure label="Net result" value={formatMoney(summary.net, currency)} tone={resultTone(summary.net)} />
            <Figure label="Win rate" value={summary.winRate === null ? "-" : formatPercent(Math.round(summary.winRate * 10) / 10)} />
            <Figure
              label="Profit factor"
              value={summary.profitFactor === null ? "-" : summary.profitFactor.toFixed(2)}
            />
            <Figure
              label="Best"
              value={summary.best === null ? "-" : formatSigned(summary.best)}
              tone={summary.best === null ? "flat" : resultTone(summary.best)}
            />
            <Figure
              label="Worst"
              value={summary.worst === null ? "-" : formatSigned(summary.worst)}
              tone={summary.worst === null ? "flat" : resultTone(summary.worst)}
            />
          </div>

          <ul className="space-y-2" aria-label="Closed trades">
            {visible.map((row) => (
              <HistoryRow key={`${row.ticket}:${row.closedAt}`} row={row} />
            ))}
          </ul>

          {rows.length > visible.length ? (
            <button type="button" className={`${CHIP_CLASS} w-full`} onClick={() => setShown((count) => count + PAGE)}>
              Show more ({rows.length - visible.length} left)
            </button>
          ) : null}
          {truncated ? (
            <p className="text-[11px] leading-snug text-muted">
              The newest {rows.length} closed trades of this period are listed - choose a shorter period to see the rest.
            </p>
          ) : null}
          {hasLocal ? (
            <p className="text-[11px] leading-snug text-muted">
              A trade you close here is listed at once; its confirmed result follows from the account&apos;s trade record within a
              few seconds.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
