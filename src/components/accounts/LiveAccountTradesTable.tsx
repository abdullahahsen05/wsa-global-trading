"use client";

import { useQuery } from "@tanstack/react-query";
import { DataTable, EmptyState, Panel, StatusPill } from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";
import type { TradeDto } from "@/lib/domain/types";

type Props = {
  accountId: string;
};

export function LiveAccountTradesTable({ accountId }: Props) {
  const { data: trades = [], isLoading, isError } = useQuery<TradeDto[]>({
    queryKey: ["account-trades", accountId],
    staleTime: 1_500,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
    queryFn: async () => {
      const res = await fetch(`/api/trades?accountId=${accountId}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load account trades");
      return json.data;
    },
  });

  const recentTrades = [...trades].sort((a, b) => {
    const aTime = new Date(a.closedAt ?? a.openedAt).getTime();
    const bTime = new Date(b.closedAt ?? b.openedAt).getTime();
    return bTime - aTime;
  });

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Recent trades</h2>
          <p className="mt-1 text-xs text-muted">Auto-refreshing every 3 seconds</p>
        </div>
        <span className="text-xs font-semibold uppercase tracking-widest text-muted">
          {recentTrades.length} trades
        </span>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(6)].map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-[4px] border border-line bg-panel" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load recent trades.
          </div>
        ) : !recentTrades.length ? (
          <EmptyState
            title="No trades yet"
            description="Trades will appear here automatically after broker activity is detected."
          />
        ) : (
          <DataTable
            headers={["Trade ID", "Symbol", "Side", "Status", "Profit", "Close price", "Closed"]}
            paginated
            initialPageSize={10}
            rows={recentTrades.map((trade) => [
              <span key="trade-id" className="font-mono text-xs text-muted">{trade.shortTradeId}</span>,
              <div key="symbol" className="space-y-1">
                <span className="font-semibold text-foreground">{trade.symbol}</span>
                {trade.copyStrategyName ? (
                  <div className="text-[11px] font-semibold text-accent">Copied by {trade.copyStrategyName}</div>
                ) : null}
              </div>,
              trade.side,
              <StatusPill key="status" tone={trade.status === "OPEN" ? "accent" : "muted"}>
                {trade.status}
              </StatusPill>,
              <span
                key="profit"
                className={
                  trade.profit.amount >= 0
                    ? "font-semibold text-accent-2"
                    : "font-semibold text-danger"
                }
              >
                {formatMoney(trade.profit)}
              </span>,
              trade.closePrice ?? "—",
              trade.closedAt ? new Date(trade.closedAt).toLocaleString() : "—",
            ])}
          />
        )}
      </div>
    </Panel>
  );
}
