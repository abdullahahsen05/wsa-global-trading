"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DataTable,
  EmptyState,
  InlineStatusStrip,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";
import type {
  PartnerSummaryDto,
  PartnerTraderDto,
  TraderRiskStatus,
} from "@/lib/partner/types";
import type { PartnerActivityDto, PartnerRiskEventDto } from "@/lib/services/partnerService";
import type { PartnerProfileStatusDto } from "@/lib/partner/profile";
import { referralLink } from "@/lib/partner/referral";

type SessionUser = { id: string; name: string; email: string };

const RISK_TONE: Record<TraderRiskStatus, "lime" | "accent" | "danger"> = {
  OK: "lime",
  AT_RISK: "accent",
  RESTRICTED: "danger",
};

const SEVERITY_TONE: Record<string, "lime" | "accent" | "danger"> = {
  INFO: "lime",
  WARNING: "accent",
  CRITICAL: "danger",
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data;
}

export default function PartnerOverviewPage() {
  const [siteUrl] = useState(() => typeof window === "undefined" ? "" : window.location.origin);
  const { data: sessionUser } = useQuery<SessionUser>({
    queryKey: ["session"],
    queryFn: () => getJson("/api/auth/session"),
  });
  const { data: profile, isLoading: profileLoading, isError: profileError } = useQuery<PartnerProfileStatusDto>({
    queryKey: ["partner", "profile"],
    queryFn: () => getJson("/api/partner/profile"),
    retry: false,
  });

  const isPending = !profileLoading && profile?.status === "PENDING_REVIEW";
  const isActive = !profileLoading && profile?.status === "ACTIVE";

  const { data: summary, isLoading: summaryLoading } = useQuery<PartnerSummaryDto>({
    queryKey: ["partner", "summary"],
    queryFn: () => getJson("/api/partner/summary"),
    enabled: isActive,
  });
  const { data: traders = [] } = useQuery<PartnerTraderDto[]>({
    queryKey: ["partner", "traders", "all"],
    queryFn: () => getJson("/api/partner/traders"),
    enabled: isActive,
  });
  const { data: riskEvents = [] } = useQuery<PartnerRiskEventDto[]>({
    queryKey: ["partner", "risk-events"],
    queryFn: () => getJson("/api/partner/risk-events"),
    enabled: isActive,
  });
  const { data: activities = [] } = useQuery<PartnerActivityDto[]>({
    queryKey: ["partner", "activities"],
    queryFn: () => getJson("/api/partner/activities"),
    enabled: isActive,
  });

  const isLoading = profileLoading || (isActive && summaryLoading);
  const hasTraders = traders.length > 0;

  if (profileError) {
    return (
      <WorkspacePage
        eyebrow="Partner"
        title="Partner setup unavailable"
        description="Your partner profile could not be loaded. No trader or commission data was requested."
      >
        <Panel>
          <p className="text-sm leading-6 text-muted">
            Refresh the page to retry. If this continues, ask an administrator to verify your partner profile.
          </p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (!profileLoading && profile && !profile.setupComplete) {
    return (
      <WorkspacePage
        eyebrow="Partner"
        title="Partner setup incomplete"
        description="Your account has the partner role, but its partner profile has not been provisioned yet."
      >
        <Panel>
          <p className="text-sm leading-6 text-muted">
            An administrator needs to complete partner setup before referral, trader, commission, and payout data can load.
          </p>
        </Panel>
      </WorkspacePage>
    );
  }

  // ── Pending approval screen ───────────────────────────────────────────────
  if (isPending) {
    return (
      <WorkspacePage
        eyebrow="Partner"
        title="Partner Portal"
        description="Your partner application is under review."
      >
        <div className="mt-5 rounded-[4px] border border-line bg-panel p-8 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-[4px] border border-line bg-background">
            <span className="text-2xl">⏳</span>
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Application submitted
          </p>
          <h2 className="mt-2 text-xl font-semibold text-foreground">
            Partner account pending admin review
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted">
            Your partner application has been received. Once approved, you&apos;ll get access to your
            referral link, referred trader list, commission ledger, and payout history.
          </p>

          <div className="mx-auto mt-8 max-w-sm space-y-3 text-left">
            {[
              { step: "1", label: "Application submitted", done: true },
              { step: "2", label: "Admin review in progress", done: false },
              { step: "3", label: "Referral link activated", done: false },
              { step: "4", label: "Commission tracking enabled", done: false },
            ].map(({ step, label, done }) => (
              <div
                key={step}
                className="flex items-center gap-3 rounded-[4px] border border-line bg-background px-4 py-3"
              >
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
                    done
                      ? "bg-accent/20 text-accent"
                      : "bg-line text-muted"
                  }`}
                >
                  {done ? "✓" : step}
                </span>
                <p className={`text-sm font-medium ${done ? "text-foreground" : "text-muted"}`}>
                  {label}
                </p>
              </div>
            ))}
          </div>

          <p className="mt-6 text-xs text-muted">
            Questions? Contact your account manager or reply to your welcome email.
          </p>
        </div>
      </WorkspacePage>
    );
  }

  if (!profileLoading && profile?.status === "SUSPENDED") {
    return (
      <WorkspacePage
        eyebrow="Partner"
        title="Partner access paused"
        description="This partner profile is suspended."
      >
        <Panel>
          <p className="text-sm leading-6 text-muted">
            Contact an administrator to review your partner access. Trader and commission data has not been loaded.
          </p>
        </Panel>
      </WorkspacePage>
    );
  }

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (profileLoading) {
    return (
      <WorkspacePage eyebrow="Partner" title="Partner Overview" description="">
        <div className="mt-5 h-24 animate-pulse rounded-[4px] border border-line bg-panel" />
      </WorkspacePage>
    );
  }

  // ── Active partner dashboard ──────────────────────────────────────────────
  return (
    <WorkspacePage
      eyebrow="Partner"
      title={`Welcome, ${sessionUser?.name?.trim() || "Partner"}`}
      description="Monitor your assigned traders, activity, risk, and commissions."
    >
      <InlineStatusStrip
        items={[
          { label: "Assigned traders", value: isLoading ? "..." : summary?.assignedTraders ?? 0, tone: "accent" },
          { label: "Connected accounts", value: isLoading ? "..." : summary?.connectedAccounts ?? 0 },
          {
            label: "Team equity",
            value: summary ? formatMoney(summary.totalEquity) : "-",
            tone: "lime",
          },
          {
            label: "Aggregate PnL",
            value: summary ? formatMoney(summary.aggregateFloatingPnl) : "-",
            tone: (summary?.aggregateFloatingPnl.amount ?? 0) < 0 ? "danger" : "lime",
          },
          {
            label: "Open risk events",
            value: isLoading ? "..." : summary?.openRiskEvents ?? 0,
            tone: (summary?.openRiskEvents ?? 0) > 0 ? "danger" : undefined,
          },
          {
            label: "Pending commission",
            value: summary ? formatMoney(summary.pendingCommission) : "-",
            tone: "accent",
          },
        ]}
      />

      {(summary?.referralCode ?? profile?.referralCode) ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-[4px] border border-line bg-panel px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Your referral code</p>
            <p className="mt-1 font-mono text-sm font-semibold text-foreground">
              {summary?.referralCode ?? profile?.referralCode}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Share this link with traders. Valid signups are attributed to your account and eligible purchases create commission records.
            </p>
            <p className="mt-1 truncate font-mono text-xs text-foreground">
              {siteUrl
                ? referralLink(siteUrl, summary?.referralCode ?? profile?.referralCode ?? "")
                : `/register?ref=${summary?.referralCode ?? profile?.referralCode}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              const code = summary?.referralCode ?? profile?.referralCode ?? "";
              const link = referralLink(siteUrl || window.location.origin, code);
              void navigator.clipboard.writeText(link);
            }}
            className="shrink-0 rounded-[4px] border border-line bg-background px-3 py-2 text-xs font-semibold text-foreground hover:border-accent/40"
          >
            Copy link
          </button>
        </div>
      ) : null}

      {!hasTraders && !isLoading ? (
        <div className="mt-5">
          <EmptyState
            title="No traders assigned yet"
            description="Once an admin assigns traders to you (or they sign up with your referral link), their performance, risk, and activity will appear here."
          />
        </div>
      ) : (
        <div className="mt-5 grid gap-5 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-5">
            <Panel>
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-foreground">Trader watchlist</h2>
                {traders.length > 12 ? <span className="text-xs text-muted">Showing 12 of {traders.length}</span> : null}
              </div>
              {traders.length === 0 ? (
                <p className="text-sm text-muted">No traders to display.</p>
              ) : (
                <DataTable
                  headers={["Trader", "Accounts", "Team equity", "Risk"]}
                  rows={traders.slice(0, 12).map((t) => [
                    <div key="n" className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{t.name}</p>
                      <p className="truncate text-xs text-muted">{t.email}</p>
                    </div>,
                    <span key="a">
                      {t.connectedAccounts}/{t.accountCount}
                    </span>,
                    <span key="e">{formatMoney(t.totalEquity)}</span>,
                    <StatusPill key="r" tone={RISK_TONE[t.riskStatus]}>
                      {t.riskStatus}
                    </StatusPill>,
                  ])}
                />
              )}
            </Panel>

            <Panel>
              <h2 className="mb-4 text-lg font-semibold text-foreground">Recent activity</h2>
              {activities.length === 0 ? (
                <p className="text-sm text-muted">No activity recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {activities.slice(0, 10).map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between gap-3 rounded-[4px] border border-line bg-background px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{a.traderName}</p>
                        <p className="truncate text-xs text-muted">{a.description}</p>
                      </div>
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                        {new Date(a.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <Panel>
            <h2 className="mb-4 text-lg font-semibold text-foreground">Risk queue</h2>
            {riskEvents.length === 0 ? (
              <p className="text-sm text-muted">No open risk events for your traders.</p>
            ) : (
              <div className="space-y-2">
                {riskEvents.slice(0, 12).map((e) => (
                  <div key={e.id} className="rounded-[4px] border border-line bg-background px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">{e.traderName}</p>
                      <StatusPill tone={SEVERITY_TONE[e.severity] ?? "muted"}>{e.severity}</StatusPill>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted">{e.message}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
    </WorkspacePage>
  );
}
