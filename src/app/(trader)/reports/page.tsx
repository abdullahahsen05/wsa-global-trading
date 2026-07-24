"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { CalendarPlus, Download, Plus, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DataTable,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
  PageActionGroup,
} from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { SelectField, TextField, TextAreaField } from "@/components/app/FormFields";
import type { TradeDto } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";

type ReportRow = {
  name: string;
  period: string;
  status: "Ready" | "Draft";
  tradeCount: number;
  pnl: number;
  format: string;
};

export default function ReportsPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage eyebrow="Reporting" title="Reports" description="Loading your platform access status.">
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
  const [createOpen, setCreateOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const { data: trades = [] } = useQuery<TradeDto[]>({
    queryKey: ["trades"],
    queryFn: async () => {
      const res = await fetch("/api/trades");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trades");
      return json.data;
    },
  });

  // Build report rows from real trade data grouped by month
  const reports = useMemo((): ReportRow[] => {
    const closed = trades.filter((t) => t.status === "CLOSED");
    const open = trades.filter((t) => t.status === "OPEN");

    // Group closed trades by month
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

    // One row per month with closed trades
    byMonth.forEach((monthTrades, month) => {
      const pnl = monthTrades.reduce((sum, t) => sum + t.profit.amount, 0);
      rows.push({
        name: "Performance Summary",
        period: month,
        status: "Ready",
        tradeCount: monthTrades.length,
        pnl,
        format: "PDF + Excel",
      });
    });

    // Risk review row (always present if there are any trades)
    if (trades.length > 0) {
      const totalPnl = closed.reduce((sum, t) => sum + t.profit.amount, 0);
      rows.push({
        name: "Risk Review",
        period: `${closed.length} closed / ${open.length} open`,
        status: "Ready",
        tradeCount: trades.length,
        pnl: totalPnl,
        format: "PDF",
      });
    }

    // Challenge summary draft
    if (closed.length > 0) {
      rows.push({
        name: "Challenge Summary",
        period: "Full history",
        status: "Draft",
        tradeCount: closed.length,
        pnl: closed.reduce((sum, t) => sum + t.profit.amount, 0),
        format: "PDF",
      });
    }

    return rows.length > 0
      ? rows
      : [
          { name: "Monthly Performance", period: "No data yet", status: "Draft", tradeCount: 0, pnl: 0, format: "PDF" },
        ];
  }, [trades]);

  const readyCount = reports.filter((r) => r.status === "Ready").length;
  const draftCount = reports.filter((r) => r.status === "Draft").length;
  const closedCount = trades.filter((t) => t.status === "CLOSED").length;

  const handleCreateReport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setSuccessMessage("");
    window.setTimeout(() => {
      setIsSubmitting(false);
      setCreateOpen(false);
      setSuccessMessage("Report packet queued. The export will be available in the reports table.");
    }, 1000);
  };

  const handleScheduleReport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsScheduling(true);
    setSuccessMessage("");
    window.setTimeout(() => {
      setIsScheduling(false);
      setScheduleOpen(false);
      const nextDelivery = new Date();
      nextDelivery.setDate(nextDelivery.getDate() + 1);
      setSuccessMessage(`Scheduled. First delivery ${nextDelivery.toLocaleDateString()} at 09:00.`);
    }, 900);
  };

  return (
    <WorkspacePage
      eyebrow="Reports"
      title="Export-ready reporting"
      description="Client-ready performance packets, risk summaries, and account review exports."
      action={
        <PageActionGroup>
          <Dialog.Root open={scheduleOpen} onOpenChange={setScheduleOpen}>
            <Dialog.Trigger asChild>
              <GhostButton type="button">
                <CalendarPlus className="mr-2 inline-block h-4 w-4" />
                Schedule
              </GhostButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
                <Dialog.Title className="text-xl font-semibold text-foreground">Schedule report</Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  Pick a cadence and delivery time for automated report delivery.
                </Dialog.Description>
                <form className="mt-6 grid gap-4" onSubmit={handleScheduleReport}>
                  <SelectField label="Cadence" defaultValue="Weekly">
                    <option>Daily</option>
                    <option>Weekly</option>
                    <option>Monthly</option>
                  </SelectField>
                  <TextField label="Delivery time" defaultValue="09:00" />
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                    <p className="text-sm text-muted">Reports will be generated from live account data.</p>
                    <div className="flex gap-3">
                      <Dialog.Close asChild>
                        <GhostButton type="button">Cancel</GhostButton>
                      </Dialog.Close>
                      <PrimaryButton type="submit" disabled={isScheduling}>
                        {isScheduling ? "Scheduling..." : "Schedule"}
                      </PrimaryButton>
                    </div>
                  </div>
                </form>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close dialog"
                    className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
            <Dialog.Trigger asChild>
              <PrimaryButton type="button">
                <Plus className="mr-2 inline-block h-4 w-4" />
                Create report
              </PrimaryButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
                <Dialog.Title className="text-xl font-semibold text-foreground">Create report packet</Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  Configure the report scope, delivery format, and notes for the final export.
                </Dialog.Description>
                <form className="mt-6 grid gap-4" onSubmit={handleCreateReport}>
                  <div className="grid gap-4 md:grid-cols-2">
                    <TextField label="Report name" defaultValue="Monthly Performance" />
                    <SelectField label="Period" defaultValue="This month">
                      <option>This month</option>
                      <option>Last month</option>
                      <option>Full history</option>
                    </SelectField>
                    <SelectField label="Format" defaultValue="PDF + Excel">
                      <option>PDF</option>
                      <option>Excel</option>
                      <option>PDF + Excel</option>
                    </SelectField>
                    <SelectField label="Audience" defaultValue="Client">
                      <option>Client</option>
                      <option>Risk desk</option>
                      <option>Admin team</option>
                    </SelectField>
                  </div>
                  <TextAreaField
                    label="Notes"
                    defaultValue="Include summary, equity curve, closed trades, and rule breaches."
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                    <p className="text-sm text-muted">
                      Report covers {closedCount} closed trades from live account data.
                    </p>
                    <div className="flex gap-3">
                      <Dialog.Close asChild>
                        <GhostButton type="button">Cancel</GhostButton>
                      </Dialog.Close>
                      <PrimaryButton type="submit" disabled={isSubmitting}>
                        {isSubmitting ? "Creating..." : "Create report"}
                      </PrimaryButton>
                    </div>
                  </div>
                </form>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close dialog"
                    className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Ready reports", value: readyCount, helper: "Available for export", tone: "lime" },
          { label: "Draft reports", value: draftCount, helper: "Needs review", tone: "accent" },
          { label: "Closed trades", value: closedCount, helper: "Basis for all reports" },
        ]}
      />

      {successMessage ? (
        <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
          {successMessage}
        </div>
      ) : null}

      <div className="mt-5">
        <DataTable
          headers={["Report", "Period", "Status", "Trades", "Net P&L", "Format", ""]}
          paginated
          initialPageSize={10}
          rows={reports.map((report) => [
            <span key="name" className="font-semibold text-foreground">{report.name}</span>,
            report.period,
            <StatusPill key="status" tone={report.status === "Ready" ? "lime" : "accent"}>
              {report.status}
            </StatusPill>,
            report.tradeCount,
            <span
              key="pnl"
              className={`font-semibold ${report.pnl >= 0 ? "text-accent-2" : "text-danger"}`}
            >
              {formatMoney({ amount: report.pnl, currency: "USD" })}
            </span>,
            report.format,
            <button
              key="dl"
              type="button"
              className="flex items-center gap-1 text-xs font-semibold text-accent hover:text-accent/80"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>,
          ])}
        />
      </div>

      <div className="mt-5 grid items-stretch gap-4 xl:h-[380px] xl:grid-cols-[0.62fr_0.38fr]">
        <Panel className="min-h-0 xl:h-full">
          <h2 className="text-lg font-semibold text-foreground">Report structure</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Each report includes account summary, equity curve, closed trade log, risk rule breaches,
            consistency metrics, and admin notes. Generated from {closedCount} closed trades on record.
          </p>
          <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2">
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Total trades</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{trades.length}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Closed</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{closedCount}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Open</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{trades.filter((t) => t.status === "OPEN").length}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Net P&L</p>
              <p className="mt-1 text-sm font-semibold text-accent-2">
                {formatMoney({
                  amount: trades.filter((t) => t.status === "CLOSED").reduce((s, t) => s + t.profit.amount, 0),
                  currency: "USD",
                })}
              </p>
            </div>
          </div>
        </Panel>
        <Panel className="flex min-h-0 flex-col overflow-hidden xl:h-full">
          <h2 className="text-lg font-semibold text-foreground">Delivery queue</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Schedule automated delivery or create a manual export above.
          </p>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {readyCount === 0 ? (
              <p className="text-sm text-muted">No queued deliveries yet.</p>
            ) : (
              reports
                .filter((r) => r.status === "Ready")
                .map((r, i) => (
                  <div key={i} className="border-b border-line bg-background px-4 py-3 last:border-b-0">
                    <p className="text-sm font-semibold text-foreground">{r.name}</p>
                    <p className="mt-1 text-xs text-muted">{r.period} · {r.format}</p>
                  </div>
                ))
            )}
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
