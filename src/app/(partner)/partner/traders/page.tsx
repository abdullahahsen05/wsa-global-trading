"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SearchField } from "@/components/app/FormFields";
import { formatMoney } from "@/lib/utils/format";
import type { PartnerAccountStatusSummary, PartnerTraderDto, TraderRiskStatus } from "@/lib/partner/types";
import type { TradeDto } from "@/lib/domain/types";

const RISK_TONE: Record<TraderRiskStatus, "lime" | "accent" | "danger"> = {
  OK: "lime",
  AT_RISK: "accent",
  RESTRICTED: "danger",
};

type StatusFilter = "ALL" | "ACTIVE" | "AT_RISK" | "RESTRICTED";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data;
}

export default function PartnerTradersPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");

  const { data: traders = [], isLoading, isError } = useQuery<PartnerTraderDto[]>({
    queryKey: ["partner", "traders", statusFilter],
    queryFn: () => getJson(`/api/partner/traders?status=${statusFilter}`),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return traders;
    return traders.filter(
      (t) => t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q),
    );
  }, [traders, search]);

  const effectiveSelectedId = selectedId || filtered[0]?.traderId || "";
  const selected = filtered.find((t) => t.traderId === effectiveSelectedId) ?? filtered[0] ?? null;

  const { data: detail } = useQuery<{ trader: PartnerTraderDto; recentTrades: TradeDto[] }>({
    queryKey: ["partner", "trader-detail", effectiveSelectedId],
    queryFn: () => getJson(`/api/partner/traders/${effectiveSelectedId}`),
    enabled: Boolean(effectiveSelectedId),
  });

  return (
    <WorkspacePage
      eyebrow="Partner"
      title="Traders"
      description="Your assigned traders - performance, accounts, and risk status."
      action={
        <PageActionGroup>
          <div className="min-w-[240px]">
            <SearchField
              placeholder="Search name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Assigned traders", value: isLoading ? "..." : traders.length, tone: "accent" },
          { label: "At risk", value: traders.filter((t) => t.riskStatus === "AT_RISK").length, tone: "accent" },
          { label: "Restricted", value: traders.filter((t) => t.riskStatus === "RESTRICTED").length, tone: "danger" },
        ]}
      />

      <div className="mt-5 rounded-[4px] border border-line bg-panel p-4">
        <FilterChipRow
          chips={(["ALL", "ACTIVE", "AT_RISK", "RESTRICTED"] as StatusFilter[]).map((s) => ({
            label: s === "ALL" ? "All" : s === "AT_RISK" ? "At risk" : s.charAt(0) + s.slice(1).toLowerCase(),
            active: statusFilter === s,
            onClick: () => setStatusFilter(s),
          }))}
        />
      </div>

      <div className="mt-5">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-[4px] border border-line bg-panel" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load traders.
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No traders assigned yet"
            description="Traders assigned to you (or who sign up with your referral link) will appear here."
          />
        ) : (
          <div className="grid items-stretch gap-5 xl:h-[600px] xl:grid-cols-[1.4fr_1fr]">
            <Panel className="flex min-h-0 min-w-0 flex-col overflow-hidden xl:h-full">
              <div className="invisible-scrollbar min-h-0 flex-1 overflow-auto">
                <DataTable
                headers={["Trader", "Joined", "Accounts", "Equity", "Risk", ""]}
                rows={filtered.map((t) => [
                  <div key="n" className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{t.name}</p>
                    <p className="truncate text-xs text-muted">{t.email}</p>
                  </div>,
                  <span key="j" className="text-xs text-muted">
                    {t.registeredAt ? new Date(t.registeredAt).toLocaleDateString() : "-"}
                  </span>,
                  <span key="a">{t.connectedAccounts}/{t.accountCount}</span>,
                  <span key="e">{formatMoney(t.totalEquity)}</span>,
                  <StatusPill key="r" tone={RISK_TONE[t.riskStatus]}>{t.riskStatus}</StatusPill>,
                  <GhostButton key="b" type="button" onClick={() => setSelectedId(t.traderId)}>
                    View
                  </GhostButton>,
                ])}
                />
              </div>
            </Panel>

            {selected ? (
              <Panel className="invisible-scrollbar min-h-0 overflow-y-auto xl:h-full">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Trader</p>
                    <h3 className="mt-2 truncate text-lg font-semibold text-foreground">{selected.name}</h3>
                    <p className="truncate text-sm text-muted">{selected.email}</p>
                  </div>
                  <StatusPill tone={RISK_TONE[selected.riskStatus]}>{selected.riskStatus}</StatusPill>
                </div>

                <div className="definition-grid mt-4 grid grid-cols-2 gap-0">
                  <Stat label="Segment" value={selected.segment} />
                  <Stat label="Accounts" value={`${selected.connectedAccounts}/${selected.accountCount}`} />
                  <Stat label="Team equity" value={formatMoney(selected.totalEquity)} />
                  <Stat label="Floating PnL" value={formatMoney(selected.floatingPnl)} />
                  <Stat label="Max drawdown" value={`${selected.maxDrawdownPercent}%`} />
                  <Stat label="Open risk events" value={selected.openRiskEvents} />
                  <Stat label="Referred / assigned" value={selected.assignedAt ? new Date(selected.assignedAt).toLocaleDateString() : "-"} />
                </div>

                {selected.accounts && selected.accounts.length > 0 ? (
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="mb-2 text-sm font-semibold text-foreground">Accounts</p>
                    <div className="space-y-1.5">
                      {selected.accounts.map((acc) => (
                        <AccountStatusRow key={acc.accountId} acc={acc} />
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-5 border-t border-line pt-4">
                  <p className="mb-2 text-sm font-semibold text-foreground">Recent trades</p>
                  {detail && detail.recentTrades.length > 0 ? (
                    <div className="space-y-1.5">
                      {detail.recentTrades.slice(0, 8).map((tr) => (
                        <div
                          key={tr.id}
                            className="flex items-center justify-between gap-2 border-b border-line bg-background px-3 py-2 text-xs last:border-b-0"
                        >
                          <span className="font-semibold text-foreground">
                            {tr.symbol} - {tr.side}
                          </span>
                          <span className={tr.profit.amount < 0 ? "text-danger" : "text-accent-2"}>
                            {formatMoney(tr.profit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted">No trades recorded.</p>
                  )}
                </div>
              </Panel>
            ) : null}
          </div>
        )}
      </div>
    </WorkspacePage>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

const ACCOUNT_STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  CONNECTED: "lime",
  SYNCING: "accent",
  PENDING: "accent",
  DISCONNECTED: "muted",
  RESTRICTED: "danger",
  INACTIVE: "muted",
};

function AccountStatusRow({ acc }: { acc: PartnerAccountStatusSummary }) {
  const tone = ACCOUNT_STATUS_TONE[acc.status] ?? "muted";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line bg-background px-3 py-2 text-xs last:border-b-0">
      <span className="truncate font-semibold text-foreground">{acc.accountName ?? acc.accountId.slice(0, 8)}</span>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-muted">{acc.currency}</span>
        <StatusPill tone={tone}>{acc.status}</StatusPill>
      </div>
    </div>
  );
}
