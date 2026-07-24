"use client";

import Link from "next/link";
import {
  BarChart3,
  BookOpenCheck,
  Bot,
  CandlestickChart,
  Gauge,
  Repeat,
  Sparkles,
  WalletCards,
} from "lucide-react";
import {
  InlineStatusStrip,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionCheckoutCTA } from "@/components/app/PlatformSubscriptionCheckoutCTA";
import { useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";

const featureCards = [
  { title: "Trading Dashboard", description: "Live KPI strip, equity snapshots, and session-aware performance tracking.", icon: Gauge },
  { title: "MT5 Accounts", description: "Connect accounts, review status, and track broker-linked account performance.", icon: WalletCards },
  { title: "Copy Trading", description: "Activate per-account copy tiers after subscription approval and entitlement setup.", icon: Repeat },
  { title: "AI Assistant", description: "Get trading guidance, risk context, and chart-aware workflow assistance.", icon: Sparkles },
  { title: "Professional Terminal", description: "Use the institutional terminal layout and professional trading workflow surface.", icon: CandlestickChart },
  { title: "Analytics", description: "Review equity trends, drawdown pressure, and trade performance summaries.", icon: BarChart3 },
  { title: "Marketplace", description: "Browse bots and EAs, purchase access, and manage owned trading tools.", icon: Bot },
  { title: "Academy & Evaluations", description: "Study trading content, join mentorship, and start free evaluation challenges.", icon: BookOpenCheck },
];

export default function PlatformPreviewPage() {
  const { data: summary } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? {
    id: "",
    productCode: "PLATFORM_MONTHLY",
    productName: "Platform Subscription",
    status: "NONE" as const,
    currentPeriodEnd: null,
    approvedAt: null,
    orderId: null,
    message: "",
  };

  return (
    <WorkspacePage
      eyebrow="Platform Preview"
      title="Unlock the WSA Global Trading Platform"
      description="Access MT5 account tracking, copy trading, AI tools, and professional trading workflows."
      action={
        access.status === "ACTIVE" ? (
          <Link href="/dashboard" className="btn-dark btn-active">
            Go to Dashboard
          </Link>
        ) : (
          <PlatformSubscriptionCheckoutCTA access={access} />
        )
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Platform subscription", value: "$50/month", tone: "accent" },
          { label: "Current state", value: access.status.replace(/_/g, " "), tone: access.status === "ACTIVE" ? "lime" : access.status === "EXPIRED" ? "danger" : "accent" },
          { label: "View billing status", value: <Link href="/billing" className="underline">Open billing</Link> },
        ]}
      />

      <div className="mt-5 grid items-stretch gap-5 lg:grid-cols-[1.3fr_0.7fr]">
        <Panel className="h-full">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">What unlocks after subscribing</p>
          <h2 className="mt-2 text-xl font-semibold text-foreground">Read-only platform tour</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            This preview shows the workspace shape after activation. It does not connect brokers, does not load live data,
            and does not trigger copy trading, terminal feeds, or AI actions.
          </p>

          <div className="definition-grid mt-5 grid gap-0 md:grid-cols-2">
            {featureCards.map((card) => {
              const Icon = card.icon;
              return (
                <div key={card.title} className="rounded-[4px] border border-line bg-background p-4">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-[4px] bg-accent/10">
                    <Icon className="h-5 w-5 text-accent" />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted">{card.description}</p>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel className="h-full">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Pricing model</p>
          <div className="mt-4 overflow-hidden rounded-[4px] border border-line">
            <div className="border-b border-line bg-background p-4">
              <p className="text-sm font-semibold text-foreground">Platform subscription</p>
              <p className="mt-1 text-sm text-accent">$50/month</p>
              <p className="mt-1 text-xs text-muted">Renews monthly from your subscription start date.</p>
            </div>
            <div className="border-b border-line bg-background p-4">
              <p className="text-sm font-semibold text-foreground">Copy account tiers</p>
              <p className="mt-1 text-xs text-muted">Normal: $10/month per account</p>
              <p className="text-xs text-muted">Ultra Fast: $15/month per account</p>
            </div>
            <div className="bg-background p-4">
              <p className="text-sm font-semibold text-foreground">Independent purchases</p>
              <p className="mt-1 text-xs text-muted">Bot / EA: $500 one-time</p>
              <p className="text-xs text-muted">1-to-1 mentorship: €2,500 one-time</p>
              <p className="text-xs text-muted">Evaluations / challenges: free</p>
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid items-stretch gap-5 xl:grid-cols-2">
        <Panel className="h-full">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Dashboard Preview</p>
          <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-3">
            <div className="rounded-[4px] border border-line bg-background p-4">
              <p className="text-xs text-muted">Balance</p>
              <p className="mt-2 text-xl font-semibold text-foreground">$52,480</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background p-4">
              <p className="text-xs text-muted">Equity</p>
              <p className="mt-2 text-xl font-semibold text-accent-2">$54,120</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background p-4">
              <p className="text-xs text-muted">Floating PnL</p>
              <p className="mt-2 text-xl font-semibold text-accent">+$1,640</p>
            </div>
          </div>

          <div className="mt-4 rounded-[4px] border border-line bg-background p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Example MT5 account</p>
                <p className="text-xs text-muted">Evaluation Phase 1 · MetaTrader 5</p>
              </div>
              <StatusPill tone="lime">Connected</StatusPill>
            </div>
            <p className="mt-3 text-xs text-muted">
              After activation, your real account cards, snapshots, and risk status appear here.
            </p>
          </div>
        </Panel>

        <Panel className="h-full">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Workflow Preview</p>
          <div className="mt-4 overflow-hidden rounded-[4px] border border-line">
            <div className="border-b border-line bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Copy strategy example</p>
                  <p className="text-xs text-muted">Momentum FX · Ultra Fast tier ready</p>
                </div>
                <StatusPill tone="accent">Locked until active</StatusPill>
              </div>
            </div>
            <div className="border-b border-line bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">AI assistant example</p>
                  <p className="text-xs text-muted">Risk summary, exposure hints, and workflow guidance.</p>
                </div>
                <StatusPill tone="muted">Preview only</StatusPill>
              </div>
            </div>
            <div className="bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Professional terminal preview</p>
                  <p className="text-xs text-muted">Institutional layout, professional workflow surface, locked live features.</p>
                </div>
                <StatusPill tone="danger">Professional</StatusPill>
              </div>
              <div className="mt-3 h-24 rounded-[4px] border border-dashed border-line bg-panel-strong" />
            </div>
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
