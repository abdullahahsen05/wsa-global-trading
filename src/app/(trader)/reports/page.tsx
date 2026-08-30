"use client";

import { Download } from "lucide-react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DataTable,
  EmptyState,
  InlineStatusStrip,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import type { TradeDto } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";
import {
  EMPTY_PLATFORM_SUBSCRIPTION_ACCESS,
  useTraderAccessSummary,
} from "@/hooks/useTraderAccessSummary";

type ReportRow = {
  name: string;
  period: string;
  status: "Ready";
  tradeCount: number;
  pnl: number;
  format: "CSV / PDF";
  trades: TradeDto[];
};

export default function ReportsPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage
        eyebrow="Reporting"
        title="Reports"
        description="Loading your platform access status."
      >
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Reporting"
        title="Reports"
        description="Activate your platform subscription to unlock reporting and export workflows."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock reports, export tools, and scheduled reporting workflows."
        />
      </WorkspacePage>
    );
  }

  return <ReportsContent />;
}

function ReportsContent() {
  const { data: trades = [] } = useQuery<TradeDto[]>({
    queryKey: ["trades"],
    queryFn: async () => {
      const res = await fetch("/api/trades");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trades");
      return json.data;
    },
  });

  const reports = useMemo((): ReportRow[] => {
    const closed = trades.filter((trade) => trade.status === "CLOSED");
    const open = trades.filter((trade) => trade.status === "OPEN");
    const byMonth = new Map<string, TradeDto[]>();

    for (const trade of closed) {
      const month = new Date(trade.closedAt ?? trade.openedAt).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });
      const existing = byMonth.get(month) ?? [];
      byMonth.set(month, [...existing, trade]);
    }

    const rows: ReportRow[] = [];

    for (const [month, monthTrades] of byMonth.entries()) {
      rows.push({
        name: "Performance Summary",
        period: month,
        status: "Ready",
        tradeCount: monthTrades.length,
        pnl: monthTrades.reduce((sum, trade) => sum + trade.profit.amount, 0),
        format: "CSV / PDF",
        trades: monthTrades,
      });
    }

    if (trades.length > 0) {
      rows.push({
        name: "Risk Review",
        period: `${closed.length} closed / ${open.length} open`,
        status: "Ready",
        tradeCount: trades.length,
        pnl: closed.reduce((sum, trade) => sum + trade.profit.amount, 0),
        format: "CSV / PDF",
        trades,
      });
    }

    if (closed.length > 0) {
      rows.push({
        name: "Challenge Summary",
        period: "Full history",
        status: "Ready",
        tradeCount: closed.length,
        pnl: closed.reduce((sum, trade) => sum + trade.profit.amount, 0),
        format: "CSV / PDF",
        trades: closed,
      });
    }

    return rows;
  }, [trades]);

  const closedCount = trades.filter((trade) => trade.status === "CLOSED").length;
  const openCount = trades.filter((trade) => trade.status === "OPEN").length;
  const totalClosedPnl = trades
    .filter((trade) => trade.status === "CLOSED")
    .reduce((sum, trade) => sum + trade.profit.amount, 0);

  function exportCsv(report: ReportRow) {
    const header = [
      "Trade ID",
      "Symbol",
      "Side",
      "Status",
      "Volume",
      "Open Price",
      "Close Price",
      "Profit",
      "Currency",
      "Opened At",
      "Closed At",
    ];

    const rows = report.trades.map((trade) => [
      trade.shortTradeId,
      trade.symbol,
      trade.side,
      trade.status,
      String(trade.volume),
      String(trade.openPrice ?? ""),
      String(trade.closePrice ?? ""),
      String(trade.profit.amount),
      trade.profit.currency,
      trade.openedAt,
      trade.closedAt ?? "",
    ]);

    const csv = [header, ...rows]
      .map((row) =>
        row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","),
      )
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.name.toLowerCase().replace(/\s+/g, "-")}-${report.period
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function exportPdf(report: ReportRow) {
    const { generateTradeReportPdf } = await import("@/lib/pdf/tradeReportPdf");
    const currency = report.trades[0]?.profit.currency ?? "USD";
    const pdf = await generateTradeReportPdf({
      reportName: report.name,
      period: report.period,
      trades: report.trades,
      currency,
    });
    const blob = new Blob([pdf], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.name.toLowerCase().replace(/\s+/g, "-")}-${report.period
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <WorkspacePage
      eyebrow="Reports"
      title="Export-ready reporting"
      description="Client-ready performance packets and risk summaries from the live trade ledger."
    >
      <InlineStatusStrip
        items={[
          { label: "Ready reports", value: reports.length, helper: "Derived from live trades", tone: "lime" },
          { label: "Closed trades", value: closedCount, helper: "Export basis" },
          { label: "Export format", value: "CSV / PDF", helper: "Branded direct download" },
        ]}
      />

      <div className="mt-5">
        {reports.length === 0 ? (
          <EmptyState
            title="No reportable trade history"
            description="Reports appear once your live ledger has closed trades."
          />
        ) : (
          <DataTable
            headers={["Report", "Period", "Status", "Trades", "Net P&L", "Format", "Export"]}
            paginated
            initialPageSize={10}
            rows={reports.map((report) => [
              <span key="name" className="font-semibold text-foreground">
                {report.name}
              </span>,
              report.period,
              <StatusPill key="status" tone="lime">
                {report.status}
              </StatusPill>,
              report.tradeCount,
              <span
                key="pnl"
                className={`font-semibold ${
                  report.pnl >= 0 ? "text-accent-2" : "text-danger"
                }`}
              >
                {formatMoney({ amount: report.pnl, currency: "USD" })}
              </span>,
              report.format,
              <div key="export" className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => exportCsv(report)}
                  className="flex items-center gap-1 text-xs font-semibold text-accent hover:text-accent/80"
                >
                  <Download className="h-3.5 w-3.5" />
                  CSV
                </button>
                <button
                  type="button"
                  onClick={() => void exportPdf(report)}
                  className="flex items-center gap-1 text-xs font-semibold text-accent-2 hover:text-accent-2/80"
                >
                  <Download className="h-3.5 w-3.5" />
                  PDF
                </button>
              </div>,
            ])}
          />
        )}
      </div>

      <div className="mt-5 grid items-stretch gap-4 xl:h-[380px] xl:grid-cols-[0.62fr_0.38fr]">
        <Panel className="min-h-0 xl:h-full">
          <h2 className="text-lg font-semibold text-foreground">Report structure</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Every row on this page is derived from persisted trade history only. No client-side
            queueing or fake report generation is used here.
          </p>
          <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2">
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Total trades
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">{trades.length}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Closed
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">{closedCount}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Open
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">{openCount}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Closed P&L
              </p>
              <p
                className={`mt-1 text-sm font-semibold ${
                  totalClosedPnl >= 0 ? "text-accent-2" : "text-danger"
                }`}
              >
                {formatMoney({ amount: totalClosedPnl, currency: "USD" })}
              </p>
            </div>
          </div>
        </Panel>

        <Panel className="flex min-h-0 flex-col overflow-hidden xl:h-full">
          <h2 className="text-lg font-semibold text-foreground">Export readiness</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Reports can be exported directly as CSV or branded PDF from the live trade ledger.
          </p>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {reports.length === 0 ? (
              <p className="text-sm text-muted">No export-ready reports yet.</p>
            ) : (
              reports.map((report) => (
                <div
                  key={`${report.name}-${report.period}`}
                  className="border-b border-line bg-background px-4 py-3 last:border-b-0"
                >
                  <p className="text-sm font-semibold text-foreground">{report.name}</p>
                  <p className="mt-1 text-xs text-muted">
                    {report.period} · {report.tradeCount} trades · {report.format}
                  </p>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
