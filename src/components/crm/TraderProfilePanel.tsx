import type { TraderProfileDto } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";

export function TraderProfilePanel({ traders }: { traders: TraderProfileDto[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {traders.map((trader) => (
        <article key={trader.traderId} className="rounded-[4px] border border-line bg-background p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-foreground">{trader.name}</p>
              <p className="mt-1 text-sm text-muted">{trader.email}</p>
            </div>
            <span className="rounded-[4px] bg-panel-strong px-2 py-1 text-xs text-accent">
              {trader.segment}
            </span>
          </div>
          <p className="mt-4 text-sm text-muted">
            {trader.accountCount} accounts · {formatMoney(trader.totalEquity)} equity
          </p>
        </article>
      ))}
    </div>
  );
}
