"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { DataTable, StatusPill } from "@/components/app/WorkspaceUI";
import { EquityCurve } from "@/components/dashboard/EquityCurve";
import type {
  CrmNoteDto,
  EquityPoint,
  MoneyValue,
  RiskEventDto,
  RiskRuleDto,
  TradeDto,
  TraderAccountSummary,
  TraderProfileDto,
} from "@/lib/domain/types";
import { formatMoney, formatPercent } from "@/lib/utils/format";

export type AdminOverviewView = "OVERVIEW" | "ACCOUNTS" | "RISK_QUEUE" | "CRM";

type AdminOverviewOverlayProps = {
  open: boolean;
  view: AdminOverviewView | null;
  onOpenChange: (open: boolean) => void;
  activeTraders: number;
  connectedAccounts: number;
  openRiskEvents: number;
  monthlyRecurringRevenue: MoneyValue;
  equityCurve: EquityPoint[];
  trades: TradeDto[];
  tradingAccounts: TraderAccountSummary[];
  traders: TraderProfileDto[];
  riskEvents: RiskEventDto[];
  riskRules: RiskRuleDto[];
  crmNotes: CrmNoteDto[];
};

function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
          {eyebrow}
        </p>
        <h3 className="mt-1.5 text-base font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-sm leading-5 text-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

function Section({
  eyebrow,
  title,
  description,
  action,
  children,
  className = "",
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col overflow-hidden rounded-[4px] border border-line bg-panel ${className}`}>
      <SectionHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        action={action}
      />
      {children}
    </section>
  );
}

function MetricRail({
  activeTraders,
  connectedAccounts,
  openRiskEvents,
  monthlyRecurringRevenue,
}: Pick<
  AdminOverviewOverlayProps,
  "activeTraders" | "connectedAccounts" | "openRiskEvents" | "monthlyRecurringRevenue"
>) {
  const metrics = [
    { label: "Active traders", value: activeTraders, helper: "Across all programs", tone: "text-foreground" },
    { label: "Connected accounts", value: connectedAccounts, helper: "Broker-linked", tone: "text-accent-2" },
    { label: "Open risk events", value: openRiskEvents, helper: "Needs admin review", tone: "text-danger" },
    { label: "MRR", value: formatMoney(monthlyRecurringRevenue), helper: "Subscription records", tone: "text-accent-2" },
  ];

  return (
    <section className="overflow-hidden rounded-[4px] border border-line bg-panel">
      <div className="grid sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="border-b border-line px-5 py-4 sm:border-r sm:[&:nth-child(even)]:border-r-0 xl:border-b-0 xl:[&:nth-child(even)]:border-r xl:last:border-r-0"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              {metric.label}
            </p>
            <p className={`mt-2 text-2xl font-semibold tabular-nums ${metric.tone}`}>
              {metric.value}
            </p>
            <p className="mt-1 text-xs text-muted">{metric.helper}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function AdminOverviewOverlay({
  open,
  view,
  onOpenChange,
  activeTraders,
  connectedAccounts,
  openRiskEvents,
  monthlyRecurringRevenue,
  equityCurve,
  trades,
  tradingAccounts,
  traders,
  riskEvents,
  riskRules,
  crmNotes,
}: AdminOverviewOverlayProps) {
  const title =
    view === "ACCOUNTS"
      ? "Account supervision"
      : view === "RISK_QUEUE"
        ? "Risk queue"
        : view === "CRM"
          ? "Trader CRM"
          : "Platform overview";

  const description =
    view === "ACCOUNTS"
      ? "Broker-linked supervision details and account states."
      : view === "RISK_QUEUE"
        ? "Platform rules and active escalation signals."
        : view === "CRM"
          ? "Trader profiles and relationship notes in one place."
          : "Platform-wide oversight summary for admin review.";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/82" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[94vw] max-w-[1280px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[7px] border border-line bg-panel shadow-[0_24px_64px_rgba(0,0,0,0.5)] focus:outline-none">
          <header className="flex shrink-0 items-start justify-between gap-5 border-b border-line px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
                Admin workspace
              </p>
              <Dialog.Title className="mt-1.5 text-xl font-semibold text-foreground sm:text-2xl">
                {title}
              </Dialog.Title>
              <Dialog.Description className="mt-1 max-w-3xl text-sm leading-5 text-muted">
                {description}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close admin overlay"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-[4px] border border-line bg-background text-muted transition-colors hover:border-line-strong hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </header>

          <div className="min-h-0 invisible-scrollbar overflow-y-auto p-4 sm:p-5">
            {view === "OVERVIEW" ? (
              <div className="grid gap-4">
                <MetricRail
                  activeTraders={activeTraders}
                  connectedAccounts={connectedAccounts}
                  openRiskEvents={openRiskEvents}
                  monthlyRecurringRevenue={monthlyRecurringRevenue}
                />

                <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(300px,0.8fr)]">
                  <EquityCurve
                    data={equityCurve}
                    title="Platform oversight"
                    description="A calm trend line for operational health and account movement across the platform."
                  />
                  <Section
                    eyebrow="Health"
                    title="Platform health"
                    description="A concise view of the current supervision posture."
                    action={<StatusPill tone="lime">Stable</StatusPill>}
                    className="h-72"
                  >
                    <dl>
                      {[
                        ["Closed trades", trades.filter((trade) => trade.status === "CLOSED").length, "text-foreground"],
                        ["Watchlist", traders.length, "text-foreground"],
                        ["Risk rules", riskRules.length, "text-danger"],
                        ["Notes", crmNotes.length, "text-accent"],
                      ].map(([label, value, tone]) => (
                        <div
                          key={String(label)}
                          className="flex min-h-10 items-center justify-between gap-4 border-b border-line px-5 last:border-b-0"
                        >
                          <dt className="text-sm text-muted">{label}</dt>
                          <dd className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </Section>
                </div>
              </div>
            ) : null}

            {view === "ACCOUNTS" ? (
              <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,0.8fr)]">
                <Section
                  eyebrow="Accounts"
                  title="Account supervision"
                  description="Broker-linked accounts and their current status."
                  action={<StatusPill tone="accent">{tradingAccounts.length} accounts</StatusPill>}
                  className="h-[clamp(320px,52vh,520px)]"
                >
                  <div className="-mx-px -mb-px min-h-0 flex-1 invisible-scrollbar overflow-auto">
                    <DataTable
                      headers={["Account", "Broker", "Status", "Balance", "Equity", "Drawdown"]}
                      rows={tradingAccounts.map((account) => [
                        <span key="account" className="font-semibold text-foreground">{account.accountName}</span>,
                        account.brokerName,
                        <StatusPill key="status" tone={account.status === "CONNECTED" ? "lime" : "accent"}>
                          {account.status}
                        </StatusPill>,
                        formatMoney(account.balance),
                        <span key="equity" className="font-semibold text-accent-2">{formatMoney(account.equity)}</span>,
                        formatPercent(account.drawdownPercent),
                      ])}
                    />
                  </div>
                </Section>

                <Section
                  eyebrow="Snapshot"
                  title="Account notes"
                  description="A short view of the current supervision state."
                  action={<StatusPill tone="muted">{tradingAccounts.length}</StatusPill>}
                  className="h-[clamp(320px,52vh,520px)]"
                >
                  <div className="min-h-0 flex-1 invisible-scrollbar overflow-y-auto">
                    {tradingAccounts.map((account) => (
                      <div key={account.accountId} className="border-b border-line px-5 py-4 last:border-b-0">
                        <div className="flex items-start justify-between gap-3">
                          <p className="min-w-0 truncate font-semibold text-foreground">{account.accountName}</p>
                          <StatusPill tone={account.status === "CONNECTED" ? "lime" : "accent"}>
                            {account.status}
                          </StatusPill>
                        </div>
                        <p className="mt-1.5 text-sm text-muted">
                          {account.openTradeCount} open trades
                          <span className="mx-2 text-line-strong">/</span>
                          {formatPercent(account.drawdownPercent)} drawdown
                        </p>
                      </div>
                    ))}
                  </div>
                </Section>
              </div>
            ) : null}

            {view === "RISK_QUEUE" ? (
              <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(340px,0.9fr)]">
                <Section
                  eyebrow="Risk queue"
                  title="Risk rules"
                  description="Platform guardrails and their current enabled state."
                  action={<StatusPill tone="accent">{riskRules.length} rules</StatusPill>}
                  className="h-[clamp(320px,52vh,520px)]"
                >
                  <div className="-mx-px -mb-px min-h-0 flex-1 invisible-scrollbar overflow-auto">
                    <DataTable
                      headers={["Rule", "Scope", "Metric", "Threshold", "Severity", "Enabled"]}
                      rows={riskRules.map((rule) => [
                        <span key="name" className="font-semibold text-foreground">{rule.name}</span>,
                        rule.scope,
                        rule.metric,
                        rule.threshold,
                        <StatusPill
                          key="severity"
                          tone={rule.severity === "CRITICAL" ? "danger" : rule.severity === "WARNING" ? "accent" : "muted"}
                        >
                          {rule.severity}
                        </StatusPill>,
                        rule.enabled ? "Enabled" : "Disabled",
                      ])}
                    />
                  </div>
                </Section>

                <Section
                  eyebrow="Events"
                  title="Active risk events"
                  description="The queue that needs admin attention."
                  action={<StatusPill tone={riskEvents.length > 0 ? "danger" : "lime"}>{riskEvents.length} open</StatusPill>}
                  className="h-[clamp(320px,52vh,520px)]"
                >
                  <div className="min-h-0 flex-1 invisible-scrollbar overflow-y-auto">
                    {riskEvents.length > 0 ? (
                      riskEvents.map((event) => (
                        <div key={event.id} className="relative border-b border-line border-l-2 border-l-danger px-5 py-4 last:border-b-0">
                          <div className="flex items-start justify-between gap-3">
                            <p className="font-semibold leading-5 text-foreground">{event.ruleName}</p>
                            <StatusPill tone="accent">{event.severity}</StatusPill>
                          </div>
                          <p className="mt-1.5 text-sm leading-6 text-muted">{event.message}</p>
                        </div>
                      ))
                    ) : (
                      <div className="px-5 py-6">
                        <p className="text-sm font-semibold text-foreground">No active risk events</p>
                        <p className="mt-1 text-sm text-muted">The active escalation queue is clear.</p>
                      </div>
                    )}
                  </div>
                </Section>
              </div>
            ) : null}

            {view === "CRM" ? (
              <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(340px,0.9fr)]">
                <Section
                  eyebrow="CRM"
                  title="Trader watchlist"
                  description="Profiles, activity, and relationship context."
                  action={<StatusPill tone="muted">Live review</StatusPill>}
                  className="h-[clamp(320px,52vh,520px)]"
                >
                  <div className="-mx-px -mb-px min-h-0 flex-1 invisible-scrollbar overflow-auto">
                    <DataTable
                      headers={["Trader", "Segment", "Accounts", "Equity", "Last active"]}
                      rows={traders.map((trader) => [
                        <span key="name" className="font-semibold text-foreground">{trader.name}</span>,
                        <StatusPill key="segment" tone={trader.segment === "AT_RISK" ? "accent" : "lime"}>
                          {trader.segment}
                        </StatusPill>,
                        trader.accountCount,
                        <span key="equity" className="font-semibold text-accent-2">{formatMoney(trader.totalEquity)}</span>,
                        new Date(trader.lastActivityAt).toLocaleString(),
                      ])}
                    />
                  </div>
                </Section>

                <Section
                  eyebrow="Notes"
                  title="Recent CRM notes"
                  description="A compact timeline for follow-ups and support context."
                  action={<StatusPill tone="muted">{crmNotes.length}</StatusPill>}
                  className="h-[clamp(320px,52vh,520px)]"
                >
                  {crmNotes.length > 0 ? (
                    <div className="min-h-0 flex-1 invisible-scrollbar overflow-y-auto">
                      {crmNotes.map((note) => (
                        <div key={note.id} className="border-b border-line px-5 py-4 last:border-b-0">
                          <p className="text-sm leading-6 text-foreground">{note.note}</p>
                          <p className="mt-2 text-xs text-muted">
                            {note.authorName} - {new Date(note.createdAt).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-5 py-6">
                      <p className="text-sm font-semibold text-foreground">No recent CRM notes</p>
                      <p className="mt-1 text-sm leading-5 text-muted">
                        Notes added by admins and support staff will appear here.
                      </p>
                    </div>
                  )}
                </Section>
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
