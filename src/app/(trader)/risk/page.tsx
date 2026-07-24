"use client";

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
import { formatMoney, formatPercent } from "@/lib/utils/format";
import type { RiskEventDto, RiskRuleDto, TraderAccountSummary } from "@/lib/domain/types";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";

function RiskBar({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: "accent" | "lime" | "danger";
}) {
  return (
    <div className="rounded-[4px] border border-line bg-background p-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        <span
          className={`text-sm font-semibold ${
            tone === "danger"
              ? "text-danger"
              : tone === "lime"
                ? "text-accent-2"
                : "text-accent"
          }`}
        >
          {formatPercent(value)}
        </span>
      </div>
      <div className="mt-3 h-3 overflow-hidden rounded-full border border-line bg-panel">
        <div
          className={`h-full rounded-full ${
            tone === "danger" ? "bg-danger" : tone === "lime" ? "bg-accent-2" : "bg-accent"
          }`}
          style={{ width: `${Math.min((value / max) * 100, 100)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted">Limit {formatPercent(max)}</p>
    </div>
  );
}

export default function RiskPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage eyebrow="Risk control" title="Risk dashboard" description="Loading your platform access status.">
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Risk control"
        title="Risk dashboard"
        description="Activate your platform subscription to unlock risk monitoring and event tracking."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock risk rules, event history, and account risk monitoring."
        />
      </WorkspacePage>
    );
  }

  return <RiskContent />;
}

function RiskContent() {
  const { data: riskRules = [] } = useQuery<RiskRuleDto[]>({
    queryKey: ["risk-rules"],
    queryFn: async () => {
      const res = await fetch("/api/risk/rules");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load risk rules");
      return json.data;
    },
  });

  const { data: riskEvents = [] } = useQuery<RiskEventDto[]>({
    queryKey: ["risk-events"],
    queryFn: async () => {
      const res = await fetch("/api/risk/events");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load risk events");
      return json.data;
    },
  });

  const { data: tradingAccounts = [] } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
  });

  const { data: dailyPnlData } = useQuery<{ dailyPnl: number; currency: string }>({
    queryKey: ["daily-pnl"],
    queryFn: async () => {
      const res = await fetch("/api/trader/daily-pnl");
      const json = await res.json();
      if (!json.ok) return { dailyPnl: 0, currency: "USD" };
      return json.data;
    },
  });

  const dailyLossLimit =
    riskRules.find((rule) => rule.metric === "DAILY_LOSS")?.threshold ?? 1250;
  const maxDrawdownLimit =
    riskRules.find((rule) => rule.metric === "MAX_DRAWDOWN")?.threshold ?? 5;
  const maxDrawdown =
    tradingAccounts.length > 0
      ? Math.max(...tradingAccounts.map((a) => a.drawdownPercent))
      : 0;
  const dailyPnl = dailyPnlData?.dailyPnl ?? 0;

  return (
    <WorkspacePage
      eyebrow="Risk"
      title="Risk rule monitoring"
      description="Daily loss, drawdown, open trade concentration, and warning history."
    >
      <InlineStatusStrip
        items={[
          {
            label: "Active rules",
            value: riskRules.filter((r) => r.enabled).length,
            helper: "Platform + account rules",
          },
          {
            label: "Open events",
            value: riskEvents.length,
            helper: "Pending review by admin",
            tone: riskEvents.length > 0 ? "accent" : undefined,
          },
          {
            label: "Highest drawdown",
            value: formatPercent(maxDrawdown),
            tone: maxDrawdown >= 5 ? "danger" : "accent",
          },
          {
            label: "Restricted",
            value: tradingAccounts.filter((account) => account.status === "RESTRICTED").length,
            helper: "Live enforced account locks",
            tone: tradingAccounts.some((account) => account.status === "RESTRICTED") ? "danger" : "lime",
          },
        ]}
      />

      <div className="mt-5 grid gap-4">
        {/* ── Risk overview ──────────────────────────────────────────────── */}
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <RiskBar
            label={`Today's closed P&L: ${dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(2)}`}
            value={dailyLossLimit > 0 ? (Math.abs(Math.min(dailyPnl, 0)) / dailyLossLimit) * 100 : 0}
            max={100}
            tone={dailyPnl < -dailyLossLimit * 0.8 ? "danger" : "accent"}
          />
          <RiskBar
            label="Max drawdown protection"
            value={maxDrawdown}
            max={maxDrawdownLimit}
            tone={maxDrawdown >= maxDrawdownLimit ? "danger" : "lime"}
          />

        </div>

        <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <Panel className="flex h-[420px] min-w-0 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Rule set</h2>
                <p className="mt-1 text-sm text-muted">Active account and platform guardrails.</p>
              </div>
              <StatusPill tone="lime">{riskRules.length} rules</StatusPill>
            </div>
            <div className="invisible-scrollbar mt-4 min-h-0 flex-1 overflow-auto">
              <DataTable
                headers={["Rule", "Scope", "Metric", "Threshold", "Severity", "Action", "State"]}
                paginated
                initialPageSize={10}
                rows={riskRules.map((rule) => [
                  <span key="name" className="font-semibold text-foreground">
                    {rule.name}
                  </span>,
                  rule.scope,
                  rule.metric,
                  rule.threshold,
                  <StatusPill
                    key="severity"
                    tone={
                      rule.severity === "CRITICAL"
                        ? "danger"
                        : rule.severity === "WARNING"
                          ? "accent"
                          : "muted"
                    }
                  >
                    {rule.severity}
                  </StatusPill>,
                  rule.action,
                  rule.enabled ? "Enabled" : "Disabled",
                ])}
              />
            </div>
          </Panel>

          <Panel className="flex h-[420px] min-w-0 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Warning notifications</h3>
                <p className="mt-1 text-xs text-muted">
                  Events flagged by the risk engine. Contact your administrator to resolve.
                </p>
              </div>
              <StatusPill tone="accent">Live</StatusPill>
            </div>
            <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto">
              {riskEvents.length === 0 ? (
                <EmptyState
                  title="No active warnings"
                  description="The risk desk is currently clear."
                />
              ) : (
                riskEvents.map((event) => (
                  <div key={event.id} className="border-b border-line bg-background px-4 py-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-4">
                      <p className="font-semibold text-foreground">{event.ruleName}</p>
                      <StatusPill
                        tone={
                          event.severity === "CRITICAL"
                            ? "danger"
                            : event.severity === "WARNING"
                              ? "accent"
                              : "muted"
                        }
                      >
                        {event.severity}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted">{event.message}</p>
                    <p className="mt-2 text-xs text-muted">
                      Raised {new Date(event.createdAt).toLocaleString()} · Acknowledgement
                      by admin required
                    </p>
                  </div>
                ))
              )}
            </div>
          </Panel>
        </div>

        {/* ── Full-width account monitoring ───────────────────────────── */}
        <div className="grid min-w-0 gap-4">
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Rule-based account monitoring
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Accounts shown with current risk posture.
                </p>
              </div>
              <StatusPill tone="accent">{tradingAccounts.length} accounts</StatusPill>
            </div>
            <div className="mt-4">
              <DataTable
                headers={["Account", "Broker", "Status", "Balance", "Equity", "Drawdown", "Risk"]}
                paginated
                initialPageSize={10}
                rows={tradingAccounts.map((account) => [
                  <span key="account" className="font-semibold text-foreground">
                    {account.accountName}
                  </span>,
                  account.brokerName,
                  <StatusPill
                    key="status"
                    tone={account.status === "CONNECTED" ? "lime" : "accent"}
                  >
                    {account.status}
                  </StatusPill>,
                  formatMoney(account.balance),
                  <span key="equity" className="font-semibold text-accent-2">
                    {formatMoney(account.equity)}
                  </span>,
                  formatPercent(account.drawdownPercent),
                  account.drawdownPercent >= 5 ? (
                    <StatusPill key="risk" tone="danger">Watch</StatusPill>
                  ) : (
                    <StatusPill key="risk" tone="lime">Normal</StatusPill>
                  ),
                ])}
              />
            </div>
          </Panel>
        </div>
      </div>
    </WorkspacePage>
  );
}
