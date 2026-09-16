"use client";

import dynamic from "next/dynamic";
import { Panel, WorkspacePage } from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";
import { useTradingAccountSelection } from "@/providers/TradingAccountSelectionProvider";

const TradingChart = dynamic(
  () => import("@/components/charts/TradingChart").then((mod) => mod.TradingChart),
  {
    ssr: false,
    loading: () => (
      <section className="section-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="h-6 w-48 animate-pulse rounded-full bg-panel-strong" />
            <div className="mt-3 h-4 w-40 animate-pulse rounded-full bg-panel-strong" />
          </div>
          <div className="h-9 w-52 animate-pulse rounded-[4px] bg-panel-strong" />
        </div>
        <div className="px-5 py-5">
          <div className="inner-surface h-[760px] animate-pulse" />
        </div>
      </section>
    ),
  },
);

export default function TerminalPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage eyebrow="Terminal" title="TradingView Terminal" description="Loading your platform access status.">
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Terminal"
        title="TradingView Terminal"
        description="Activate your platform subscription to unlock the chart terminal workspace."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock the TradingView terminal, chart workflow, and WSA Assistant chart review."
        />
      </WorkspacePage>
    );
  }

  return <TerminalContent />;
}

function TerminalContent() {
  const { selectedAccountId } = useTradingAccountSelection();

  return (
    <WorkspacePage
      eyebrow="Terminal"
      title="TradingView Terminal"
      description="Change pairs, zoom and inspect the chart, then ask WSA Assistant for chart review from the same workspace."
    >
      <TradingChart accountId={selectedAccountId ?? undefined} />
    </WorkspacePage>
  );
}
