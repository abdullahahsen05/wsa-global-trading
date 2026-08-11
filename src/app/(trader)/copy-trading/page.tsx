"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Network,
  Repeat,
  Search,
  ShieldCheck,
} from "lucide-react";
import { BillingCheckoutModal } from "@/components/app/BillingCheckoutModal";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { SearchField } from "@/components/app/FormFields";
import {
  DataTable,
  GhostButton,
  InlineStatusStrip,
  PaginationControls,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { AccountCombobox } from "@/components/copy/AccountCombobox";
import { CopyExecutionLog } from "@/components/copy/CopyExecutionLog";
import { SelfCopyPanel, type SelfCopyResponse } from "@/components/copy/SelfCopyPanel";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";
import type { CopyFollowerDto, CopyLogDto } from "@/lib/copy/types";
import type { TraderAccountSummary } from "@/lib/domain/types";
import type { TraderStrategyDto } from "@/lib/services/copyTradingService";
import type { CopyEntitlementDto, UserBillingSummaryDto } from "@/lib/services/billingService";
import { formatMoney } from "@/lib/utils/format";

type CopyView = "STRATEGIES" | "CONNECTIONS" | "SELF_COPY" | "ACTIVITY";
type ConnectionFilter = "ALL" | "ACTIVE" | "PAUSED" | "ERROR";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data;
}

function followerTone(status: CopyFollowerDto["status"]) {
  return status === "ACTIVE" ? "lime" as const : status === "REVOKED" ? "danger" as const : "accent" as const;
}

function engineTone(status: CopyFollowerDto["engineStatus"]) {
  return status === "LIVE" ? "lime" as const : status === "ERROR" ? "danger" as const : "accent" as const;
}

export default function CopyTradingPage() {
  const { data: access, isLoading } = useTraderAccessSummary();
  const platform = access?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;
  if (isLoading && !access) {
    return (
      <WorkspacePage eyebrow="Copy Trading" title="Copy operations" description="Loading access...">
        <Panel><p className="text-sm text-muted">Loading...</p></Panel>
      </WorkspacePage>
    );
  }
  if (platform.status !== "ACTIVE") {
    return (
      <WorkspacePage eyebrow="Copy Trading" title="Copy operations" description="Activate the platform before configuring live copying.">
        <PlatformSubscriptionLocked
          access={platform}
          description="An active WSA Global platform subscription is required before buying a strategy or creating self-copy routes."
        />
      </WorkspacePage>
    );
  }
  return <LiveCopyContent initialBilling={access} />;
}

function LiveCopyContent({ initialBilling }: { initialBilling?: UserBillingSummaryDto }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<CopyView>("STRATEGIES");
  const [accountByStrategy, setAccountByStrategy] = useState<Record<string, string>>({});
  const [tierByStrategy, setTierByStrategy] = useState<Record<string, "NORMAL" | "PREMIUM">>({});
  const [expandedStrategyId, setExpandedStrategyId] = useState<string | null>(null);
  const [strategySearch, setStrategySearch] = useState("");
  const [strategyPage, setStrategyPage] = useState(1);
  const [strategyPageSize, setStrategyPageSize] = useState(10);
  const [connectionSearch, setConnectionSearch] = useState("");
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>("ALL");
  const [checkout, setCheckout] = useState<{ strategy: TraderStrategyDto; accountId: string; tier: "NORMAL" | "PREMIUM" } | null>(null);
  const [follow, setFollow] = useState<{ strategy: TraderStrategyDto; accountId: string; tier: "NORMAL" | "PREMIUM" } | null>(null);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const { data: billing = initialBilling } = useQuery<UserBillingSummaryDto>({
    queryKey: ["billing-me"],
    queryFn: () => api("/api/billing/me"),
    initialData: initialBilling,
  });
  const { data: strategies = [], isLoading: strategiesLoading } = useQuery<TraderStrategyDto[]>({
    queryKey: ["copy-strategies"],
    queryFn: () => api("/api/copy/strategies"),
  });
  const { data: accounts = [] } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts"],
    queryFn: () => api("/api/trading-accounts"),
  });
  const { data: subscriptions = [] } = useQuery<CopyFollowerDto[]>({
    queryKey: ["copy-my-subscriptions"],
    queryFn: () => api("/api/copy/my-subscriptions"),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const { data: selfCopy = { relationships: [] } } = useQuery<SelfCopyResponse>({
    queryKey: ["self-copy-relationships"],
    queryFn: () => api("/api/copy-trading/self-copy"),
  });
  const { data: copyLogs = [], isLoading: copyLogsLoading } = useQuery<CopyLogDto[]>({
    queryKey: ["copy-logs"],
    queryFn: () => api("/api/copy/logs"),
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const connectedAccounts = useMemo(
    () => accounts.filter((account) => account.status === "CONNECTED"),
    [accounts],
  );
  const currentSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => subscription.status !== "REVOKED"),
    [subscriptions],
  );

  const entitlementMap = useMemo(() => new Map(
    (billing?.copyEntitlements ?? [])
      .filter((entry): entry is CopyEntitlementDto & { strategyId: string; tradingAccountId: string } => Boolean(entry.strategyId && entry.tradingAccountId))
      .map((entry) => [`${entry.strategyId}:${entry.tradingAccountId}`, entry]),
  ), [billing?.copyEntitlements]);

  const normalizedStrategySearch = strategySearch.trim().toLowerCase();
  const filteredStrategies = useMemo(
    () => strategies.filter((strategy) => {
      if (!normalizedStrategySearch) return true;
      return [
        strategy.name,
        strategy.description ?? "",
        strategy.currency,
      ].some((entry) => entry.toLowerCase().includes(normalizedStrategySearch));
    }),
    [normalizedStrategySearch, strategies],
  );
  const strategyTotalPages = Math.max(1, Math.ceil(filteredStrategies.length / strategyPageSize));
  const safeStrategyPage = Math.min(strategyPage, strategyTotalPages);
  const visibleStrategies = filteredStrategies.slice(
    (safeStrategyPage - 1) * strategyPageSize,
    safeStrategyPage * strategyPageSize,
  );

  const normalizedConnectionSearch = connectionSearch.trim().toLowerCase();
  const filteredConnections = useMemo(
    () => currentSubscriptions.filter((subscription) => {
      if (connectionFilter === "ACTIVE" && subscription.status !== "ACTIVE") return false;
      if (connectionFilter === "PAUSED" && subscription.status !== "PAUSED") return false;
      if (connectionFilter === "ERROR" && subscription.engineStatus !== "ERROR") return false;
      if (!normalizedConnectionSearch) return true;
      return [
        subscription.strategyName ?? "",
        subscription.followerAccountName ?? "",
        subscription.status,
        subscription.engineStatus,
        subscription.tier,
        subscription.engineError ?? "",
      ].some((entry) => entry.toLowerCase().includes(normalizedConnectionSearch));
    }),
    [connectionFilter, currentSubscriptions, normalizedConnectionSearch],
  );

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
    onSuccess: () => {
      refresh();
      setFollow(null);
      setConsent(false);
      setView("CONNECTIONS");
      setNotice({ tone: "ok", text: "WSA live copying is active. New master trades, changes, and closes will synchronize automatically." });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "ACTIVE" | "PAUSED" | "REVOKED" }) => api(`/api/copy/subscriptions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }),
    onSuccess: () => {
      refresh();
      setNotice({ tone: "ok", text: "Live copy connection updated in the WSA engine." });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const tabs: Array<{ id: CopyView; label: string; count: number; icon: typeof Repeat }> = [
    { id: "STRATEGIES", label: "Browse strategies", count: strategies.length, icon: Repeat },
    { id: "CONNECTIONS", label: "My connections", count: currentSubscriptions.length, icon: Network },
    { id: "SELF_COPY", label: "Self copy", count: selfCopy.relationships.length, icon: ArrowRight },
    { id: "ACTIVITY", label: "Activity", count: copyLogs.length, icon: Activity },
  ];

  return (
    <>
      <WorkspacePage
        eyebrow="Copy Trading"
        title="Copy operations"
        description="Browse live strategies, manage account-level subscriptions, and route trades between your own connected accounts."
      >
        <InlineStatusStrip
          items={[
            { label: "Published strategies", value: strategies.length, helper: "Available monthly", tone: "accent" },
            { label: "Active connections", value: currentSubscriptions.filter((item) => item.status === "ACTIVE").length, helper: "Strategy to account", tone: "lime" },
            { label: "Self-copy routes", value: selfCopy.relationships.filter((item) => item.status === "LIVE").length, helper: "Account to account", tone: "lime" },
            { label: "Connected accounts", value: connectedAccounts.length, helper: "Eligible destinations" },
          ]}
        />

        <div className="mt-5 invisible-scrollbar overflow-x-auto border-b border-line">
          <div className="flex min-w-max gap-1" role="tablist" aria-label="Copy trading sections">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = view === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setView(tab.id)}
                  className={`flex h-12 items-center gap-2 border-b-2 px-4 text-sm font-semibold transition-colors ${
                    active ? "border-accent text-accent" : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${active ? "bg-accent/15 text-accent" : "bg-panel text-muted"}`}>{tab.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="my-5 flex items-center gap-3 border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p>Live copying can place, change, and close real orders on connected accounts. Review lot sizing and risk limits before activating a route.</p>
        </div>
        {notice ? (
          <div className={`mb-5 rounded-[4px] border px-4 py-3 text-sm ${notice.tone === "ok" ? "border-lime/30 bg-lime/10 text-lime" : "border-danger/30 bg-danger/10 text-danger"}`}>
            {notice.text}
          </div>
        ) : null}

        {view === "STRATEGIES" ? (
          <Panel className="overflow-visible p-0">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-5 py-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Available live strategies</h2>
                <p className="mt-1 text-sm text-muted">Choose a strategy, speed tier, and connected follower account.</p>
              </div>
              <div className="relative w-full sm:w-96">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <SearchField
                  aria-label="Search strategies"
                  placeholder="Search strategy name or description"
                  value={strategySearch}
                  onChange={(event) => {
                    setStrategySearch(event.target.value);
                    setStrategyPage(1);
                  }}
                  className="h-10 pl-9"
                />
              </div>
            </div>

            {strategiesLoading ? (
              <p className="px-5 py-9 text-sm text-muted">Loading live strategies...</p>
            ) : visibleStrategies.length ? (
              <div>
                <div className="divide-y divide-line">
                  {visibleStrategies.map((strategy) => {
                    const accountId = accountByStrategy[strategy.id] ?? connectedAccounts[0]?.accountId ?? "";
                    const tier = tierByStrategy[strategy.id] ?? "NORMAL";
                    const access = entitlementMap.get(`${strategy.id}:${accountId}`);
                    const activeFollower = subscriptions.find(
                      (subscription) => subscription.strategyId === strategy.id
                        && subscription.followerAccountId === accountId
                        && subscription.status !== "REVOKED",
                    );
                    const expanded = expandedStrategyId === strategy.id;
                    return (
                      <div key={strategy.id} className="px-5 py-4 transition-colors hover:bg-white/[0.015]">
                        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Repeat className="h-4 w-4 text-lime" />
                              <h3 className="truncate font-semibold text-foreground">{strategy.name}</h3>
                              <StatusPill tone="lime">LIVE</StatusPill>
                            </div>
                            <p className="mt-1 line-clamp-1 text-sm text-muted">{strategy.description || "Live WSA strategy."}</p>
                          </div>
                          <div className="flex flex-wrap gap-2 lg:justify-end">
                            <StatusPill tone="muted">
                              Standard {formatMoney({ amount: strategy.standardMonthlyPrice, currency: strategy.currency })}
                            </StatusPill>
                            <StatusPill tone="accent">
                              Fast {formatMoney({ amount: strategy.premiumMonthlyPrice, currency: strategy.currency })}
                            </StatusPill>
                          </div>
                          <GhostButton
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedStrategyId(expanded ? null : strategy.id)}
                          >
                            {expanded ? "Close setup" : activeFollower ? "Manage" : "Configure"}
                          </GhostButton>
                        </div>

                        {expanded ? (
                          <div className="mt-4 grid gap-5 border-t border-line pt-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(300px,1.2fr)]">
                            <div className="grid grid-cols-2 border border-line bg-background">
                              {(["NORMAL", "PREMIUM"] as const).map((option, index) => {
                                const premium = option === "PREMIUM";
                                const selected = tier === option;
                                return (
                                  <button
                                    key={option}
                                    type="button"
                                    onClick={() => setTierByStrategy((current) => ({ ...current, [strategy.id]: option }))}
                                    className={`p-4 text-left transition-colors ${index === 0 ? "border-r border-line" : ""} ${selected ? "bg-accent/10" : "hover:bg-panel-strong/50"}`}
                                  >
                                    <p className="text-[10px] uppercase tracking-widest text-muted">{premium ? "Premium / Fast" : "Standard"}</p>
                                    <p className="mt-1 font-semibold text-foreground">
                                      {formatMoney({ amount: premium ? strategy.premiumMonthlyPrice : strategy.standardMonthlyPrice, currency: strategy.currency })} / month
                                    </p>
                                    <p className="mt-1 text-xs text-muted">
                                      {premium ? `${strategy.premiumDelayMs} ms` : `${strategy.standardDelayMs / 1000}s`} dispatch target
                                    </p>
                                  </button>
                                );
                              })}
                            </div>
                            <div className="space-y-4">
                              <AccountCombobox
                                accounts={connectedAccounts}
                                value={accountId}
                                onChange={(selectedAccountId) => setAccountByStrategy((current) => ({ ...current, [strategy.id]: selectedAccountId }))}
                                label="Follower account"
                                placeholder="Search connected follower accounts"
                              />
                              <div className="flex min-h-10 flex-wrap items-center gap-2">
                                {!accountId ? (
                                  <p className="text-sm text-accent">Connect a trading account before subscribing.</p>
                                ) : activeFollower ? (
                                  <>
                                    <StatusPill tone={engineTone(activeFollower.engineStatus)}>{activeFollower.engineStatus}</StatusPill>
                                    <StatusPill tone={activeFollower.tier === "PREMIUM" ? "accent" : "muted"}>{activeFollower.tier}</StatusPill>
                                    {activeFollower.status === "ACTIVE" ? (
                                      <GhostButton type="button" onClick={() => updateMutation.mutate({ id: activeFollower.id, status: "PAUSED" })}>Pause new trades</GhostButton>
                                    ) : (
                                      <PrimaryButton type="button" onClick={() => updateMutation.mutate({ id: activeFollower.id, status: "ACTIVE" })}>Resume</PrimaryButton>
                                    )}
                                    <GhostButton
                                      type="button"
                                      onClick={() => window.confirm("Stop following? Existing copied positions remain linked and close when the master closes them.") && updateMutation.mutate({ id: activeFollower.id, status: "REVOKED" })}
                                    >
                                      Stop gracefully
                                    </GhostButton>
                                  </>
                                ) : access?.status === "ACTIVE" ? (
                                  <PrimaryButton type="button" onClick={() => {
                                    setFollow({ strategy, accountId, tier: access.tier === "PREMIUM" ? "PREMIUM" : "NORMAL" });
                                    setConsent(false);
                                  }}>
                                    Start live copying
                                  </PrimaryButton>
                                ) : (
                                  <PrimaryButton type="button" onClick={() => setCheckout({ strategy, accountId, tier })}>
                                    Subscribe {tier === "PREMIUM" ? "Premium" : "Standard"}
                                  </PrimaryButton>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="px-5 pb-4">
                  <PaginationControls
                    currentPage={safeStrategyPage}
                    totalItems={filteredStrategies.length}
                    pageSize={strategyPageSize}
                    pageSizeOptions={[10, 20, 50]}
                    onPageChange={setStrategyPage}
                    onPageSizeChange={(size) => { setStrategyPageSize(size); setStrategyPage(1); }}
                  />
                </div>
              </div>
            ) : (
              <div className="px-5 py-9">
                <p className="font-semibold text-foreground">{strategies.length ? "No matching strategies" : "No live strategies are published"}</p>
                <p className="mt-1 text-sm text-muted">{strategies.length ? "Try another search term." : "Published monthly strategies will appear here."}</p>
              </div>
            )}
          </Panel>
        ) : null}

        {view === "CONNECTIONS" ? (
          <Panel className="overflow-hidden p-0">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-5 py-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">My strategy connections</h2>
                <p className="mt-1 text-sm text-muted">Each row is one purchased strategy connected to one follower account.</p>
              </div>
              <div className="relative w-full sm:w-96">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <SearchField
                  aria-label="Search strategy connections"
                  placeholder="Search strategy, account, or status"
                  value={connectionSearch}
                  onChange={(event) => setConnectionSearch(event.target.value)}
                  className="h-10 pl-9"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
              {(["ALL", "ACTIVE", "PAUSED", "ERROR"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={connectionFilter === filter}
                  onClick={() => setConnectionFilter(filter)}
                  className={`btn-dark h-9 px-3 text-xs ${connectionFilter === filter ? "btn-active" : ""}`}
                >
                  {filter === "ALL" ? "All" : filter.charAt(0) + filter.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            {filteredConnections.length ? (
              <DataTable
                headers={["Strategy", "Follower account", "Speed", "Subscription", "Engine", "Last sync", "Action"]}
                initialPageSize={20}
                pageSizeOptions={[20, 50, 100]}
                maxBodyHeight="620px"
                rows={filteredConnections.map((subscription) => [
                  <div key="strategy">
                    <p className="font-semibold text-foreground">{subscription.strategyName ?? "Strategy"}</p>
                    {subscription.engineError ? <p className="mt-1 max-w-xs text-xs text-danger">{subscription.engineError}</p> : null}
                  </div>,
                  <span key="account" className="font-semibold text-foreground">{subscription.followerAccountName ?? "Connected account"}</span>,
                  <StatusPill key="tier" tone={subscription.tier === "PREMIUM" ? "accent" : "muted"}>{subscription.tier}</StatusPill>,
                  <StatusPill key="status" tone={followerTone(subscription.status)}>{subscription.status}</StatusPill>,
                  <StatusPill key="engine" tone={engineTone(subscription.engineStatus)}>{subscription.engineStatus}</StatusPill>,
                  <span key="sync" className="whitespace-nowrap text-xs text-muted">
                    {subscription.engineSyncedAt ? new Date(subscription.engineSyncedAt).toLocaleString() : "Pending"}
                  </span>,
                  <div key="action" className="flex justify-end gap-2">
                    {subscription.status === "ACTIVE" ? (
                      <GhostButton type="button" onClick={() => updateMutation.mutate({ id: subscription.id, status: "PAUSED" })}>Pause</GhostButton>
                    ) : (
                      <PrimaryButton type="button" onClick={() => updateMutation.mutate({ id: subscription.id, status: "ACTIVE" })}>Resume</PrimaryButton>
                    )}
                    <GhostButton
                      type="button"
                      onClick={() => window.confirm("Stop following? Existing copied positions remain linked and close when the master closes them.") && updateMutation.mutate({ id: subscription.id, status: "REVOKED" })}
                    >
                      Stop
                    </GhostButton>
                  </div>,
                ])}
              />
            ) : (
              <div className="px-5 py-9">
                <p className="font-semibold text-foreground">{currentSubscriptions.length ? "No matching connections" : "No strategy connections yet"}</p>
                <p className="mt-1 text-sm text-muted">
                  {currentSubscriptions.length ? "Adjust the search or status filter." : "Buy a strategy for a connected account from Browse strategies."}
                </p>
              </div>
            )}
          </Panel>
        ) : null}

        {view === "SELF_COPY" ? <SelfCopyPanel accounts={accounts} /> : null}
        {view === "ACTIVITY" ? <CopyExecutionLog logs={copyLogs} loading={copyLogsLoading} /> : null}
      </WorkspacePage>

      {checkout ? (
        <BillingCheckoutModal
          open
          onClose={() => setCheckout(null)}
          product={{
            code: checkout.tier === "PREMIUM" ? checkout.strategy.premiumBillingProductCode : checkout.strategy.standardBillingProductCode,
            name: `${checkout.strategy.name} · ${checkout.tier === "PREMIUM" ? "Premium / Fast" : "Standard"}`,
            amount: checkout.tier === "PREMIUM" ? checkout.strategy.premiumMonthlyPrice : checkout.strategy.standardMonthlyPrice,
            currency: checkout.strategy.currency,
            billingInterval: "MONTHLY",
            description: `Monthly ${checkout.tier === "PREMIUM" ? "premium fast" : "standard"} live copy access for ${checkout.strategy.name} on the selected account.`,
          }}
          tradingAccountId={checkout.accountId}
          copyStrategyId={checkout.strategy.id}
        />
      ) : null}

      {follow ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-[4px] border border-line bg-panel p-6">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-accent" />
              <h2 className="text-xl font-semibold text-foreground">Confirm live copying</h2>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted">
              This authorizes the WSA engine to place, modify, and close trades from{" "}
              <strong className="text-foreground">{follow.strategy.name}</strong> on your selected account.
              Master closes will close the corresponding follower positions.
            </p>
            <label className="mt-4 flex items-start gap-3 rounded-[4px] border border-line bg-background p-3 text-sm text-muted">
              <input type="checkbox" className="mt-1" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>I understand that this is live trading and can cause financial loss.</span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <GhostButton type="button" onClick={() => setFollow(null)}>Cancel</GhostButton>
              <PrimaryButton type="button" disabled={!consent || followMutation.isPending} onClick={() => followMutation.mutate()}>
                {followMutation.isPending ? "Connecting..." : "Start live copying"}
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
