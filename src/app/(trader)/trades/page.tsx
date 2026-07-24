"use client";

import { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DirectorySearchOverlay } from "@/components/app/DirectorySearchOverlay";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { EmptyState, GhostButton, InlineStatusStrip, Panel, PageActionGroup, PrimaryButton, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";
import type { TradeDto } from "@/lib/domain/types";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";

export default function TradesPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage eyebrow="Trade ledger" title="Trade history" description="Loading your platform access status.">
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Trade ledger"
        title="Trade history"
        description="Activate your platform subscription to unlock trade history and manual trade-sync tools."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock trade history, trade-search tools, and the trader trade ledger workspace."
        />
      </WorkspacePage>
    );
  }

  return <TradesContent />;
}

function TradesContent() {
  const queryClient = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [syncResult, setSyncResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const { data: tradeList = [], isLoading, isError } = useQuery<TradeDto[]>({
    queryKey: ["trades"],
    refetchInterval: 5_000,
    queryFn: async () => {
      const res = await fetch("/api/trades");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trades");
      return json.data;
    },
  });

  const handleSyncTrades = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/trader/sync-trades", { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Sync failed");

      type SyncResultItem = { tradesUpserted?: number; openPositions?: number; error?: string };
      const results: SyncResultItem[] = json.data?.results ?? [];
      const totalTrades = results.reduce((sum, r) => sum + (r.tradesUpserted ?? 0), 0);
      const totalOpen = results.reduce((sum, r) => sum + (r.openPositions ?? 0), 0);
      const anyError = results.find(r => r.error);

      if (anyError) {
        setSyncResult({ type: "error", text: anyError.error ?? "Unknown sync error" });
      } else {
        setSyncResult({
          type: "success",
          text: `Synced ${totalOpen} open position${totalOpen !== 1 ? "s" : ""} and ${totalTrades} trade record${totalTrades !== 1 ? "s" : ""}.`,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["trades"] });
    } catch (err) {
      setSyncResult({ type: "error", text: err instanceof Error ? err.message : "Sync failed" });
    } finally {
      setSyncing(false);
    }
  }, [queryClient]);

  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/reports/trades");
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error?.message ?? "CSV export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `wsa-global-trades-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setSyncResult({ type: "error", text: error instanceof Error ? error.message : "CSV export failed" });
    } finally {
      setExporting(false);
    }
  }, []);

  const recentTrades = useMemo(
    () => [...tradeList].sort((a, b) => {
      const aTime = new Date(a.closedAt ?? a.openedAt).getTime();
      const bTime = new Date(b.closedAt ?? b.openedAt).getTime();
      return bTime - aTime;
    }),
    [tradeList],
  );

  // Set initial selectedId once trades load
  const effectiveSelectedId = selectedId || recentTrades[0]?.id || "";

  const openTrades = useMemo(() => tradeList.filter((trade) => trade.status === "OPEN"), [tradeList]);
  const closedTrades = useMemo(() => tradeList.filter((trade) => trade.status === "CLOSED"), [tradeList]);
  const netProfit = useMemo(() => tradeList.reduce((total, trade) => total + trade.profit.amount, 0), [tradeList]);

  const uniqueSymbols = useMemo(
    () => [...new Set(tradeList.map((t) => t.symbol))],
    [tradeList],
  );

  return (
    <WorkspacePage
      eyebrow="Trade ledger"
      title="Trade history"
      description="Review recent open and closed trades, search the full ledger, or export it to CSV."
      action={
        <PageActionGroup>
          <GhostButton type="button" onClick={() => setSearchOpen(true)}>
            Search
          </GhostButton>
          <GhostButton type="button" disabled={exporting || !tradeList.length} onClick={handleExportCsv}>
            {exporting ? "Exporting…" : "Export CSV"}
          </GhostButton>
          <PrimaryButton type="button" disabled={syncing} onClick={handleSyncTrades}>
            {syncing ? "Syncing…" : "Sync Trades"}
          </PrimaryButton>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Open trades", value: openTrades.length, helper: "Across connected accounts", tone: "accent" },
          { label: "Closed trades", value: closedTrades.length, helper: "Current review period" },
          {
            label: "Net PnL",
            value: formatMoney({ amount: netProfit, currency: "USD" }),
            helper: "Ledger total",
            tone: netProfit >= 0 ? "lime" : "danger",
          },
          {
            label: "Symbols",
            value: uniqueSymbols.length,
            helper: uniqueSymbols.slice(0, 4).join(", ") || "None",
          },
        ]}
      />

      {syncResult && (
        <div
          className={`mt-4 rounded-[4px] border px-4 py-3 text-sm font-medium ${
            syncResult.type === "success"
              ? "border-accent/20 bg-accent/10 text-accent"
              : "border-danger/20 bg-danger/10 text-danger"
          }`}
        >
          {syncResult.text}
        </div>
      )}

      <div className="mt-5">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-12 rounded-[4px] border border-line bg-panel animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load trades. Please refresh the page.
          </div>
        ) : !recentTrades.length ? (
          <EmptyState
            title="No trades yet"
            description="Trades will appear here after your account syncs with your broker."
          />
        ) : (
          <Panel className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
              <div>
                <h2 className="font-semibold text-foreground">Recent trades</h2>
                <p className="mt-1 text-xs text-muted">Newest activity first · click a row for full details</p>
              </div>
              <span className="text-xs font-semibold uppercase tracking-widest text-muted">{recentTrades.length} trades</span>
            </div>
            <div className="invisible-scrollbar overflow-x-auto">
              <table className="w-full min-w-[1040px] text-left text-sm">
                <thead className="border-b border-line bg-background/60 text-[11px] uppercase tracking-widest text-muted">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Trade</th>
                    <th className="px-3 py-3 font-semibold">Side</th>
                    <th className="px-3 py-3 font-semibold">Status</th>
                    <th className="px-3 py-3 font-semibold">Volume</th>
                    <th className="px-3 py-3 font-semibold">Opened</th>
                    <th className="px-3 py-3 font-semibold">Closed</th>
                    <th className="px-5 py-3 text-right font-semibold">P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recentTrades.map((trade) => (
                    <tr
                      key={trade.id}
                      tabIndex={0}
                      className="cursor-pointer bg-panel transition-colors hover:bg-background/50 focus:bg-background/50 focus:outline-none"
                      onClick={() => { setSelectedId(trade.id); setSearchOpen(true); }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedId(trade.id);
                          setSearchOpen(true);
                        }
                      }}
                    >
                      <td className="px-5 py-3">
                        <p className="font-mono font-semibold text-foreground">{trade.symbol}</p>
                        <p className="mt-0.5 text-xs text-muted">{trade.shortTradeId}</p>
                      </td>
                      <td className={`px-3 py-3 font-semibold ${trade.side === "BUY" ? "text-lime" : "text-danger"}`}>{trade.side}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col items-start gap-1.5">
                          <StatusPill tone={trade.status === "OPEN" ? "accent" : "muted"}>{trade.status}</StatusPill>
                          {trade.copyStrategyName ? (
                            <span className="text-[11px] font-semibold text-accent">Copied by {trade.copyStrategyName}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-foreground">{trade.volume}</td>
                      <td className="px-3 py-3">
                        <p className="font-mono font-semibold text-foreground">{trade.openPrice}</p>
                        <p className="mt-0.5 text-xs text-muted">{new Date(trade.openedAt).toLocaleString()}</p>
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-mono font-semibold text-foreground">{trade.closePrice ?? "—"}</p>
                        <p className="mt-0.5 text-xs text-muted">{trade.closedAt ? new Date(trade.closedAt).toLocaleString() : "Still open"}</p>
                      </td>
                      <td className={`px-5 py-3 text-right font-mono font-semibold ${trade.profit.amount >= 0 ? "text-lime" : "text-danger"}`}>
                        {trade.copySyncPending ? <span className="text-xs text-muted">Sync pending</span> : formatMoney(trade.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>

      <DirectorySearchOverlay<TradeDto>
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search trades"
        description="Search every trade by ID, symbol, account, side, status, price, volume, or time."
        items={recentTrades}
        selectedId={effectiveSelectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setSearchOpen(false);
        }}
        searchLabel="Search ledger"
        searchPlaceholder="Search trade ID, symbol, or account"
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "ALL", label: "All trades" },
              { value: "OPEN", label: "Open" },
              { value: "CLOSED", label: "Closed" },
            ],
          },
        ]}
        emptyTitle="No trades match"
        emptyDescription="Change the search term or status filter."
        getId={(trade) => trade.id}
        matches={(trade, state) => {
          const search = state.query.trim().toLowerCase();
          const matchesQuery =
            search.length === 0 ||
            trade.shortTradeId.toLowerCase().includes(search) ||
            trade.symbol.toLowerCase().includes(search) ||
            trade.accountId.toLowerCase().includes(search) ||
            trade.side.toLowerCase().includes(search) ||
            trade.status.toLowerCase().includes(search) ||
            (trade.copyStrategyName?.toLowerCase().includes(search) ?? false) ||
            String(trade.volume).includes(search) ||
            String(trade.openPrice).includes(search) ||
            String(trade.closePrice ?? "").includes(search) ||
            new Date(trade.openedAt).toLocaleString().toLowerCase().includes(search) ||
            (trade.closedAt ? new Date(trade.closedAt).toLocaleString().toLowerCase().includes(search) : false);
          const matchesStatus = state.filters.status === "ALL" || trade.status === state.filters.status;
          return matchesQuery && matchesStatus;
        }}
        renderRow={(trade) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{trade.symbol}</p>
                <p className="mt-1 truncate text-xs text-muted">{trade.shortTradeId}</p>
                {trade.copyStrategyName ? (
                  <p className="mt-1 truncate text-xs font-semibold text-accent">Copied by {trade.copyStrategyName}</p>
                ) : null}
              </div>
              <StatusPill tone={trade.status === "OPEN" ? "accent" : "muted"}>{trade.status}</StatusPill>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {trade.side}
              </span>
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {new Date(trade.openedAt).toLocaleDateString()}
              </span>
              {trade.copyStrategyName ? (
                <span className="rounded-[4px] border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
                  Copied by {trade.copyStrategyName}
                </span>
              ) : null}
            </div>
          </>
        )}
        renderPreview={(trade) => (
          <Panel className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Trade preview</p>
                <h3 className="mt-2 text-lg font-semibold text-foreground">{trade.symbol}</h3>
                <p className="mt-1 text-sm text-muted">
                  {trade.shortTradeId} · {trade.side}
                </p>
                {trade.copyStrategyName ? (
                  <p className="mt-1 text-sm font-semibold text-accent">Copied by {trade.copyStrategyName}</p>
                ) : null}
              </div>
              <StatusPill tone={trade.status === "OPEN" ? "accent" : "muted"}>{trade.status}</StatusPill>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Volume</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{trade.volume}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Open price</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{trade.openPrice}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Profit</p>
                <p
                  className={`mt-1 text-sm font-semibold ${
                    trade.profit.amount >= 0 ? "text-accent-2" : "text-danger"
                  }`}
                >
                  {trade.copySyncPending ? "Sync pending" : formatMoney(trade.profit)}
                </p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Opened</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{new Date(trade.openedAt).toLocaleString()}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Close price</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{trade.closePrice ?? "—"}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Closed</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {trade.closedAt ? new Date(trade.closedAt).toLocaleString() : "—"}
                </p>
              </div>
            </div>
          </Panel>
        )}
      />
    </WorkspacePage>
  );
}
