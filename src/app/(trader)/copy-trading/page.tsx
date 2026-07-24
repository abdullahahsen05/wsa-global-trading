"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Repeat, ShieldCheck } from "lucide-react";
import { BillingCheckoutModal } from "@/components/app/BillingCheckoutModal";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { GhostButton, Panel, PrimaryButton, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { CopyExecutionLog } from "@/components/copy/CopyExecutionLog";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";
import type { CopyFollowerDto, CopyLogDto } from "@/lib/copy/types";
import type { TraderAccountSummary } from "@/lib/domain/types";
import type { TraderStrategyDto } from "@/lib/services/copyTradingService";
import type { CopyEntitlementDto, UserBillingSummaryDto } from "@/lib/services/billingService";
import { formatMoney } from "@/lib/utils/format";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data;
}

export default function CopyTradingPage() {
  const { data: access, isLoading } = useTraderAccessSummary();
  const platform = access?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;
  if (isLoading && !access) return <WorkspacePage eyebrow="Copy Trading" title="Live Strategies" description="Loading access..."><Panel><p className="text-sm text-muted">Loading...</p></Panel></WorkspacePage>;
  if (platform.status !== "ACTIVE") {
    return <WorkspacePage eyebrow="Copy Trading" title="Live Strategies" description="Activate the platform before subscribing to live strategies."><PlatformSubscriptionLocked access={platform} description="An active WSA Global platform subscription is required before buying a live strategy subscription." /></WorkspacePage>;
  }
  return <LiveCopyContent initialBilling={access} />;
}

function LiveCopyContent({ initialBilling }: { initialBilling?: UserBillingSummaryDto }) {
  const queryClient = useQueryClient();
  const [accountByStrategy, setAccountByStrategy] = useState<Record<string, string>>({});
  const [tierByStrategy, setTierByStrategy] = useState<Record<string, "NORMAL" | "PREMIUM">>({});
  const [checkout, setCheckout] = useState<{ strategy: TraderStrategyDto; accountId: string; tier: "NORMAL" | "PREMIUM" } | null>(null);
  const [follow, setFollow] = useState<{ strategy: TraderStrategyDto; accountId: string; tier: "NORMAL" | "PREMIUM" } | null>(null);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const { data: billing = initialBilling } = useQuery<UserBillingSummaryDto>({ queryKey: ["billing-me"], queryFn: () => api("/api/billing/me"), initialData: initialBilling });
  const { data: strategies = [] } = useQuery<TraderStrategyDto[]>({ queryKey: ["copy-strategies"], queryFn: () => api("/api/copy/strategies") });
  const { data: accounts = [] } = useQuery<TraderAccountSummary[]>({ queryKey: ["trading-accounts"], queryFn: () => api("/api/trading-accounts") });
  const { data: subscriptions = [] } = useQuery<CopyFollowerDto[]>({ queryKey: ["copy-my-subscriptions"], queryFn: () => api("/api/copy/my-subscriptions") });
  const { data: copyLogs = [], isLoading: copyLogsLoading } = useQuery<CopyLogDto[]>({ queryKey: ["copy-logs"], queryFn: () => api("/api/copy/logs"), refetchInterval: 5_000 });
  const connectedAccounts = accounts.filter((account) => account.status === "CONNECTED");

  const entitlementMap = useMemo(() => new Map(
    (billing?.copyEntitlements ?? [])
      .filter((entry): entry is CopyEntitlementDto & { strategyId: string; tradingAccountId: string } => Boolean(entry.strategyId && entry.tradingAccountId))
      .map((entry) => [`${entry.strategyId}:${entry.tradingAccountId}`, entry]),
  ), [billing?.copyEntitlements]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["billing-me"] });
    queryClient.invalidateQueries({ queryKey: ["copy-my-subscriptions"] });
  };

  const followMutation = useMutation({
    mutationFn: () => {
      if (!follow || !consent) throw new Error("Accept the live trading risk consent first.");
      return api(`/api/copy/strategies/${follow.strategy.id}/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followerAccountId: follow.accountId, tier: follow.tier, consentAccepted: true }),
      });
    },
    onSuccess: () => { refresh(); setFollow(null); setConsent(false); setNotice({ tone: "ok", text: "WSA live copying is active. New master trades, changes, and closes will be synchronized automatically." }); },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "ACTIVE" | "PAUSED" | "REVOKED" }) => api(`/api/copy/subscriptions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    }),
    onSuccess: () => { refresh(); setNotice({ tone: "ok", text: "Live copy subscription updated in the WSA engine." }); },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  return <>
    <WorkspacePage eyebrow="Copy Trading" title="Live Strategies" description="Subscribe monthly per strategy and per follower account. The WSA engine synchronizes the copied trades.">
      <div className="mb-5 flex items-center gap-3 border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /><p>Live copy trading can place and close real orders on the selected connected account. Losses can exceed expectations; review your lot and risk settings before following.</p></div>
      {notice ? <div className={`mb-5 rounded-[4px] border px-4 py-3 text-sm ${notice.tone === "ok" ? "border-lime/30 bg-lime/10 text-lime" : "border-danger/30 bg-danger/10 text-danger"}`}>{notice.text}</div> : null}

      <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <Panel className="flex min-h-0 flex-col overflow-hidden">
          <h2 className="shrink-0 text-lg font-semibold text-foreground">Available live strategies</h2>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
            {strategies.length ? strategies.map((strategy) => {
              const accountId = accountByStrategy[strategy.id] ?? connectedAccounts[0]?.accountId ?? "";
              const tier = tierByStrategy[strategy.id] ?? "NORMAL";
              const access = entitlementMap.get(`${strategy.id}:${accountId}`);
              const activeFollower = subscriptions.find((subscription) => subscription.strategyId === strategy.id && subscription.followerAccountId === accountId && subscription.status !== "REVOKED");
              return <div key={strategy.id} className="flex flex-col border border-line bg-background p-4">
                <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Repeat className="h-4 w-4 text-lime" /><h3 className="font-semibold text-foreground">{strategy.name}</h3></div><p className="mt-2 text-sm leading-6 text-muted">{strategy.description || "Live WSA strategy."}</p></div><StatusPill tone="lime">LIVE</StatusPill></div>
                <div className="mt-4 grid grid-cols-2 border border-line">
                  {(["NORMAL", "PREMIUM"] as const).map((option, index) => {
                    const premium = option === "PREMIUM";
                    const selected = tier === option;
                    return <button key={option} type="button" onClick={() => setTierByStrategy((current) => ({ ...current, [strategy.id]: option }))} className={`p-3 text-left transition-colors ${index === 0 ? "border-r border-line" : ""} ${selected ? "bg-accent/10" : "hover:bg-panel-strong/50"}`}>
                      <p className="text-[10px] uppercase tracking-widest text-muted">{premium ? "Premium / Fast" : "Standard"}</p>
                      <p className="mt-1 font-semibold text-foreground">{formatMoney({ amount: premium ? strategy.premiumMonthlyPrice : strategy.standardMonthlyPrice, currency: strategy.currency })} / month</p>
                      <p className="mt-1 text-xs text-muted">{premium ? `${strategy.premiumDelayMs} ms` : `${strategy.standardDelayMs / 1000}s`} target</p>
                    </button>;
                  })}
                </div>
                <label className="mt-4 space-y-2 text-sm font-semibold text-foreground">Follower account<select className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm" value={accountId} onChange={(event) => setAccountByStrategy((current) => ({ ...current, [strategy.id]: event.target.value }))}><option value="">Select connected account...</option>{connectedAccounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountName} · {account.brokerName}</option>)}</select></label>
                <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-4">
                  {!accountId ? <p className="text-sm text-accent">Connect a trading account before subscribing.</p> : activeFollower ? <><StatusPill tone={activeFollower.engineStatus === "LIVE" ? "lime" : activeFollower.engineStatus === "ERROR" ? "danger" : "accent"}>{activeFollower.engineStatus}</StatusPill><StatusPill tone={activeFollower.tier === "PREMIUM" ? "accent" : "muted"}>{activeFollower.tier}</StatusPill>{activeFollower.status === "ACTIVE" ? <GhostButton type="button" onClick={() => updateMutation.mutate({ id: activeFollower.id, status: "PAUSED" })}>Pause new trades</GhostButton> : <PrimaryButton type="button" onClick={() => updateMutation.mutate({ id: activeFollower.id, status: "ACTIVE" })}>Resume</PrimaryButton>}<GhostButton type="button" onClick={() => window.confirm("Stop following and gracefully close copied positions when the master closes them?") && updateMutation.mutate({ id: activeFollower.id, status: "REVOKED" })}>Stop & close gracefully</GhostButton></> : access?.status === "ACTIVE" ? <PrimaryButton type="button" onClick={() => { setFollow({ strategy, accountId, tier: access.tier === "PREMIUM" ? "PREMIUM" : "NORMAL" }); setConsent(false); }}>Start live copying</PrimaryButton> : <PrimaryButton type="button" onClick={() => setCheckout({ strategy, accountId, tier })}>Subscribe {tier === "PREMIUM" ? "Premium" : "Standard"}</PrimaryButton>}
                </div>
              </div>;
            }) : <p className="text-sm text-muted">No live strategies are published yet.</p>}
          </div>
        </Panel>

        <Panel className="flex min-h-0 flex-col overflow-hidden">
          <h2 className="shrink-0 text-lg font-semibold text-foreground">My live copy connections</h2>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
            {subscriptions.length ? subscriptions.map((subscription) => <div key={subscription.id} className="flex flex-wrap items-center justify-between gap-3 border border-line bg-background p-4"><div><p className="font-semibold text-foreground">{subscription.strategyName}</p><p className="mt-1 text-xs text-muted">{subscription.followerAccountName} · synced {subscription.engineSyncedAt ? new Date(subscription.engineSyncedAt).toLocaleString() : "pending"}</p>{subscription.engineError ? <p className="mt-1 text-xs text-danger">{subscription.engineError}</p> : null}</div><div className="flex flex-wrap justify-end gap-2"><StatusPill tone={subscription.tier === "PREMIUM" ? "accent" : "muted"}>{subscription.tier}</StatusPill><StatusPill tone={subscription.status === "ACTIVE" ? "lime" : "accent"}>{subscription.status}</StatusPill><StatusPill tone={subscription.engineStatus === "LIVE" ? "lime" : subscription.engineStatus === "ERROR" ? "danger" : "accent"}>{subscription.engineStatus}</StatusPill></div></div>) : <p className="text-sm text-muted">No active live copy connections yet.</p>}
          </div>
        </Panel>
      </div>
      <CopyExecutionLog logs={copyLogs} loading={copyLogsLoading} />
    </WorkspacePage>

    {checkout ? <BillingCheckoutModal open onClose={() => setCheckout(null)} product={{ code: checkout.tier === "PREMIUM" ? checkout.strategy.premiumBillingProductCode : checkout.strategy.standardBillingProductCode, name: `${checkout.strategy.name} · ${checkout.tier === "PREMIUM" ? "Premium / Fast" : "Standard"}`, amount: checkout.tier === "PREMIUM" ? checkout.strategy.premiumMonthlyPrice : checkout.strategy.standardMonthlyPrice, currency: checkout.strategy.currency, billingInterval: "MONTHLY", description: `Monthly ${checkout.tier === "PREMIUM" ? "premium fast" : "standard"} live copy access for ${checkout.strategy.name} on the selected account.` }} tradingAccountId={checkout.accountId} copyStrategyId={checkout.strategy.id} /> : null}

    {follow ? <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"><div className="w-full max-w-md rounded-[4px] border border-line bg-panel p-6"><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-accent" /><h2 className="text-xl font-semibold text-foreground">Confirm live copying</h2></div><p className="mt-3 text-sm leading-6 text-muted">This authorizes the WSA engine to place, modify, and close trades from <strong className="text-foreground">{follow.strategy.name}</strong> on your selected account. Master closes will close the corresponding follower positions.</p><label className="mt-4 flex items-start gap-3 rounded-[4px] border border-line bg-background p-3 text-sm text-muted"><input type="checkbox" className="mt-1" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I understand that this is live trading and can cause financial loss.</span></label><div className="mt-5 flex justify-end gap-2"><GhostButton type="button" onClick={() => setFollow(null)}>Cancel</GhostButton><PrimaryButton type="button" disabled={!consent || followMutation.isPending} onClick={() => followMutation.mutate()}>{followMutation.isPending ? "Connecting..." : "Start live copying"}</PrimaryButton></div></div></div> : null}
  </>;
}
