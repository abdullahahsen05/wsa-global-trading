import type { TradeDto } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";

export function OpenTradesTable({
  trades,
  updatedAt,
}: {
  trades: TradeDto[];
  updatedAt?: string;
}) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Open trades</h3>
          <p className="mt-1 text-xs text-muted">Refreshing from the mock broker feed</p>
        </div>
        <span className="rounded-[4px] bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
          {updatedAt ? `Updated ${updatedAt}` : "Live refresh"}
        </span>
      </div>
      <div className="invisible-scrollbar overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead className="bg-panel-strong text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="px-4 py-3">Symbol</th>
              <th className="px-4 py-3">Side</th>
              <th className="px-4 py-3">Volume</th>
              <th className="px-4 py-3">Open</th>
              <th className="px-4 py-3">Floating PnL</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr key={trade.id} className="border-t border-line/70">
                <td className="px-4 py-3 font-medium text-foreground">{trade.symbol}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-[4px] px-2 py-1 text-xs ${
                      trade.side === "BUY"
                        ? "bg-accent/12 text-accent"
                        : "bg-danger/12 text-danger"
                    }`}
                  >
                    {trade.side}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted">{trade.volume}</td>
                <td className="px-4 py-3 text-muted">{trade.openPrice}</td>
                <td
                  className={`px-4 py-3 font-medium ${
                    trade.profit.amount >= 0 ? "text-accent" : "text-danger"
                  }`}
                >
                  {formatMoney(trade.profit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
