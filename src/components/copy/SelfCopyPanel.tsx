"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Link2, Pause, Play, Repeat, Search, Settings2, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { AccountCombobox } from "@/components/copy/AccountCombobox";
import { SearchField, SelectField, TextField } from "@/components/app/FormFields";
import {
  EmptyState,
  GhostButton,
  InlineStatusStrip,
  PaginationControls,
  Panel,
  PrimaryButton,
  StatusPill,
} from "@/components/app/WorkspaceUI";
import type { TraderAccountSummary } from "@/lib/domain/types";

type SelfCopyMode = "BALANCE_RATIO" | "LOT_MULTIPLIER" | "FIXED_LOT";
type SelfCopyFilter = "ALL" | "LIVE" | "PAUSED";

interface SelfCopySettings {
  copyEnabled: boolean;
  copyMode: SelfCopyMode;
  fixedLot: number | null;
  lotMultiplier: number | null;
  minLot: number | null;
  maxLot: number | null;
  maxOpenTrades: number | null;
  maxDailyLossPercent: number | null;
  maxDrawdownPercent: number | null;
  allowedSymbols: string[] | null;
  blockedSymbols: string[] | null;
  symbolMapping: Record<string, string>;
  copyNewTradesOnly: true;
  reverseCopy: boolean;
  pauseOnDisconnect: boolean;
  emergencyStop: boolean;
}

export interface SelfCopyRelationship {
  id: string;
  sourceAccountId: string;
  sourceAccountName: string;
  sourceStatus: string;
  followerAccountId: string;
  followerAccountName: string;
  followerStatus: string;
  status: "LIVE" | "PAUSED";
  copySettings: SelfCopySettings;
  createdAt: string;
  updatedAt: string;
}

export interface SelfCopyResponse {
  relationships: SelfCopyRelationship[];
}

const EMPTY_RELATIONSHIPS: SelfCopyRelationship[] = [];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data as T;
}

function numberOrNull(value: string) {
  return value.trim() ? Number(value) : null;
}

function symbolList(value: string) {
  const symbols = [...new Set(value.split(",").map((entry) => entry.trim().toUpperCase()).filter(Boolean))];
  return symbols.length ? symbols : null;
}

function modeLabel(mode: SelfCopyMode) {
  if (mode === "FIXED_LOT") return "Fixed lot";
  if (mode === "LOT_MULTIPLIER") return "Lot multiplier";
  return "Balance ratio";
}

export function SelfCopyPanel({ accounts }: { accounts: TraderAccountSummary[] }) {
  const queryClient = useQueryClient();
  const eligibleAccounts = useMemo(
    () => accounts.filter((account) => account.status === "CONNECTED"),
    [accounts],
  );
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [followerAccountId, setFollowerAccountId] = useState("");
  const [copyMode, setCopyMode] = useState<SelfCopyMode>("BALANCE_RATIO");
  const [fixedLot, setFixedLot] = useState("");
  const [lotMultiplier, setLotMultiplier] = useState("1");
  const [minLot, setMinLot] = useState("0.01");
  const [maxLot, setMaxLot] = useState("");
  const [maxOpenTrades, setMaxOpenTrades] = useState("10");
  const [maxDailyLoss, setMaxDailyLoss] = useState("5");
  const [maxDrawdown, setMaxDrawdown] = useState("10");
  const [allowedSymbols, setAllowedSymbols] = useState("");
  const [blockedSymbols, setBlockedSymbols] = useState("");
  const [reverseCopy, setReverseCopy] = useState(false);
  const [pauseOnDisconnect, setPauseOnDisconnect] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SelfCopyFilter>("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const relationships = useQuery<SelfCopyResponse>({
    queryKey: ["self-copy-relationships"],
    queryFn: () => api("/api/copy-trading/self-copy"),
  });

  const action = useMutation({
    mutationFn: (input: { url: string; method: "POST" | "PATCH" | "DELETE"; body?: unknown; label: string }) =>
      api<Record<string, unknown>>(input.url, {
        method: input.method,
        headers: input.body ? { "Content-Type": "application/json" } : undefined,
        body: input.body ? JSON.stringify(input.body) : undefined,
      }),
    onSuccess: async (_data, input) => {
      setNotice({ tone: "success", text: `${input.label} completed.` });
      await queryClient.invalidateQueries({ queryKey: ["self-copy-relationships"] });
      if (input.method === "POST" || (input.method === "PATCH" && editingId)) resetForm();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const allRelationships = relationships.data?.relationships ?? EMPTY_RELATIONSHIPS;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredRelationships = useMemo(
    () => allRelationships.filter((relationship) => {
      if (statusFilter !== "ALL" && relationship.status !== statusFilter) return false;
      if (!normalizedSearch) return true;
      return [
        relationship.sourceAccountName,
        relationship.followerAccountName,
        relationship.sourceStatus,
        relationship.followerStatus,
        modeLabel(relationship.copySettings.copyMode),
      ].some((entry) => entry.toLowerCase().includes(normalizedSearch));
    }),
    [allRelationships, normalizedSearch, statusFilter],
  );
  const totalPages = Math.max(1, Math.ceil(filteredRelationships.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRelationships = filteredRelationships.slice((safePage - 1) * pageSize, safePage * pageSize);
  const liveCount = allRelationships.filter((relationship) => relationship.status === "LIVE").length;
  const pausedCount = allRelationships.filter((relationship) => relationship.status === "PAUSED").length;

  function resetForm() {
    setEditingId(null);
    setSourceAccountId("");
    setFollowerAccountId("");
    setCopyMode("BALANCE_RATIO");
    setFixedLot("");
    setLotMultiplier("1");
    setMinLot("0.01");
    setMaxLot("");
    setMaxOpenTrades("10");
    setMaxDailyLoss("5");
    setMaxDrawdown("10");
    setAllowedSymbols("");
    setBlockedSymbols("");
    setReverseCopy(false);
    setPauseOnDisconnect(true);
  }

  function settingsPayload(): SelfCopySettings {
    return {
      copyEnabled: true,
      copyMode,
      fixedLot: copyMode === "FIXED_LOT" ? numberOrNull(fixedLot) : null,
      lotMultiplier: copyMode === "FIXED_LOT" ? null : numberOrNull(lotMultiplier),
      minLot: numberOrNull(minLot),
      maxLot: numberOrNull(maxLot),
      maxOpenTrades: numberOrNull(maxOpenTrades),
      maxDailyLossPercent: numberOrNull(maxDailyLoss),
      maxDrawdownPercent: numberOrNull(maxDrawdown),
      allowedSymbols: symbolList(allowedSymbols),
      blockedSymbols: symbolList(blockedSymbols),
      symbolMapping: {},
      copyNewTradesOnly: true,
      reverseCopy,
      pauseOnDisconnect,
      emergencyStop: false,
    };
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const copySettings = settingsPayload();
    if (editingId) {
      action.mutate({
        url: `/api/copy-trading/self-copy/${editingId}`,
        method: "PATCH",
        body: { copySettings },
        label: "Self-copy settings update",
      });
      return;
    }
    action.mutate({
      url: "/api/copy-trading/self-copy",
      method: "POST",
      label: "Live self-copy setup",
      body: { sourceAccountId, followerAccountId, copySettings },
    });
  }

  function editRelationship(relationship: SelfCopyRelationship) {
    const settings = relationship.copySettings;
    setEditingId(relationship.id);
    setSourceAccountId(relationship.sourceAccountId);
    setFollowerAccountId(relationship.followerAccountId);
    setCopyMode(settings.copyMode);
    setFixedLot(settings.fixedLot?.toString() ?? "");
    setLotMultiplier(settings.lotMultiplier?.toString() ?? "1");
    setMinLot(settings.minLot?.toString() ?? "0.01");
    setMaxLot(settings.maxLot?.toString() ?? "");
    setMaxOpenTrades(settings.maxOpenTrades?.toString() ?? "10");
    setMaxDailyLoss(settings.maxDailyLossPercent?.toString() ?? "5");
    setMaxDrawdown(settings.maxDrawdownPercent?.toString() ?? "10");
    setAllowedSymbols(settings.allowedSymbols?.join(", ") ?? "");
    setBlockedSymbols(settings.blockedSymbols?.join(", ") ?? "");
    setReverseCopy(Boolean(settings.reverseCopy));
    setPauseOnDisconnect(settings.pauseOnDisconnect !== false);
    setNotice(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="space-y-5">
      <InlineStatusStrip
        items={[
          { label: "Connected accounts", value: eligibleAccounts.length, helper: "Eligible for self-copy", tone: "accent" },
          { label: "Live routes", value: liveCount, helper: "Copying new positions", tone: "lime" },
          { label: "Paused routes", value: pausedCount, helper: "No new positions", tone: pausedCount ? "danger" : "default" },
          { label: "Available pairings", value: Math.max(0, eligibleAccounts.length * (eligibleAccounts.length - 1)), helper: "Directional account pairs" },
        ]}
      />

      {notice ? (
        <div className={`rounded-[4px] border px-4 py-3 text-sm ${
          notice.tone === "success"
            ? "border-accent/20 bg-accent/10 text-accent"
            : "border-danger/20 bg-danger/10 text-danger"
        }`}>
          {notice.text}
        </div>
      ) : null}

      <Panel className="overflow-visible">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] border border-accent/25 bg-accent/10 text-accent">
              <Link2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                {editingId ? "Edit self-copy route" : "Create a self-copy route"}
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
                Choose one connected account as the source and another as the follower. New positions, changes,
                partial closes, and full closes flow in the selected direction.
              </p>
            </div>
          </div>
          {editingId ? <StatusPill tone="accent">Editing route</StatusPill> : <StatusPill tone="lime">Live execution</StatusPill>}
        </div>

        <form className="mt-5 space-y-5" onSubmit={save}>
          <div className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_44px_minmax(0,1fr)]">
            <AccountCombobox
              accounts={eligibleAccounts}
              value={sourceAccountId}
              onChange={(accountId) => {
                setSourceAccountId(accountId);
                if (accountId === followerAccountId) setFollowerAccountId("");
              }}
              label="Source account"
              placeholder="Search for the account to copy from"
              excludeAccountId={followerAccountId}
              disabled={Boolean(editingId)}
            />
            <div className="mb-1 hidden h-11 place-items-center rounded-[4px] border border-accent/20 bg-accent/10 text-accent lg:grid">
              <ArrowRight className="h-5 w-5" />
            </div>
            <AccountCombobox
              accounts={eligibleAccounts}
              value={followerAccountId}
              onChange={setFollowerAccountId}
              label="Follower account"
              placeholder="Search for the account that receives trades"
              excludeAccountId={sourceAccountId}
              disabled={Boolean(editingId)}
            />
          </div>

          <div className="grid gap-4 border-t border-line pt-5 md:grid-cols-2 xl:grid-cols-4">
            <SelectField label="Lot sizing" value={copyMode} onChange={(event) => setCopyMode(event.target.value as SelfCopyMode)}>
              <option value="BALANCE_RATIO">Balance ratio</option>
              <option value="LOT_MULTIPLIER">Lot multiplier</option>
              <option value="FIXED_LOT">Fixed lot</option>
            </SelectField>
            {copyMode === "FIXED_LOT" ? (
              <TextField label="Fixed lot" type="number" min="0.01" step="0.01" required value={fixedLot} onChange={(event) => setFixedLot(event.target.value)} />
            ) : (
              <TextField label={copyMode === "BALANCE_RATIO" ? "Balance multiplier" : "Lot multiplier"} type="number" min="0.01" max="100" step="0.01" required value={lotMultiplier} onChange={(event) => setLotMultiplier(event.target.value)} />
            )}
            <TextField label="Minimum lot" type="number" min="0.01" step="0.01" value={minLot} onChange={(event) => setMinLot(event.target.value)} />
            <TextField label="Maximum lot" type="number" min="0.01" step="0.01" value={maxLot} onChange={(event) => setMaxLot(event.target.value)} />
            <TextField label="Maximum open trades" type="number" min="1" max="10000" step="1" value={maxOpenTrades} onChange={(event) => setMaxOpenTrades(event.target.value)} />
            <TextField label="Maximum daily loss %" type="number" min="0.01" max="100" step="0.1" value={maxDailyLoss} onChange={(event) => setMaxDailyLoss(event.target.value)} />
            <TextField label="Maximum drawdown %" type="number" min="0.01" max="100" step="0.1" value={maxDrawdown} onChange={(event) => setMaxDrawdown(event.target.value)} />
            <div className="grid content-end gap-3 pb-1">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={reverseCopy} onChange={(event) => setReverseCopy(event.target.checked)} />
                Reverse BUY and SELL
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={pauseOnDisconnect} onChange={(event) => setPauseOnDisconnect(event.target.checked)} />
                Pause when disconnected
              </label>
            </div>
          </div>

          <div className="grid gap-4 border-t border-line pt-5 md:grid-cols-2">
            <TextField label="Allowed symbols" hint="Comma separated; blank allows all" placeholder="EURUSD, GBPUSD" value={allowedSymbols} onChange={(event) => setAllowedSymbols(event.target.value)} />
            <TextField label="Blocked symbols" hint="Comma separated" placeholder="XAUUSD" value={blockedSymbols} onChange={(event) => setBlockedSymbols(event.target.value)} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
            <p className="max-w-2xl text-xs leading-5 text-muted">
              Only trades opened after this route becomes live are copied. Existing source positions are not imported.
            </p>
            <div className="flex flex-wrap gap-2">
              {editingId ? <GhostButton type="button" onClick={resetForm}>Cancel editing</GhostButton> : null}
              <PrimaryButton
                type="submit"
                disabled={action.isPending || !sourceAccountId || !followerAccountId || sourceAccountId === followerAccountId}
              >
                {action.isPending ? "Saving..." : editingId ? "Save route settings" : "Enable live self-copy"}
              </PrimaryButton>
            </div>
          </div>
          {eligibleAccounts.length < 2 ? (
            <p className="text-sm text-accent">Connect at least two of your own accounts before creating a self-copy route.</p>
          ) : null}
        </form>
      </Panel>

      <Panel className="overflow-hidden p-0">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-5 py-5">
          <div>
            <div className="flex items-center gap-2">
              <Repeat className="h-5 w-5 text-accent" />
              <h2 className="text-lg font-semibold text-foreground">My self-copy routes</h2>
            </div>
            <p className="mt-1 text-sm text-muted">Search, pause, resume, edit, or archive account-to-account routes.</p>
          </div>
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <SearchField
              aria-label="Search self-copy routes"
              placeholder="Search source or follower"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              className="h-10 pl-9"
            />
          </div>
        </div>

        <div className="border-b border-line px-5 py-3">
          <div className="flex flex-wrap gap-2">
            {(["ALL", "LIVE", "PAUSED"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={statusFilter === filter}
                onClick={() => {
                  setStatusFilter(filter);
                  setPage(1);
                }}
                className={`btn-dark h-9 px-3 text-xs ${statusFilter === filter ? "btn-active" : ""}`}
              >
                {filter === "ALL" ? `All (${allRelationships.length})` : `${filter === "LIVE" ? "Live" : "Paused"} (${filter === "LIVE" ? liveCount : pausedCount})`}
              </button>
            ))}
          </div>
        </div>

        {relationships.isLoading ? (
          <p className="px-5 py-9 text-sm text-muted">Loading self-copy routes...</p>
        ) : relationships.isError ? (
          <div className="px-5 py-9">
            <p className="font-semibold text-danger">Self-copy routes could not be loaded</p>
            <GhostButton type="button" className="mt-3" onClick={() => relationships.refetch()}>Try again</GhostButton>
          </div>
        ) : visibleRelationships.length ? (
          <div>
            <div className="divide-y divide-line">
              {visibleRelationships.map((relationship) => (
                <div key={relationship.id} className="grid gap-4 px-5 py-4 transition-colors hover:bg-white/[0.02] xl:grid-cols-[minmax(0,1.3fr)_minmax(220px,0.7fr)_auto] xl:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[4px] border border-line bg-background text-accent">
                      <ArrowRight className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                        <span className="truncate">{relationship.sourceAccountName}</span>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-accent" />
                        <span className="truncate">{relationship.followerAccountName}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {relationship.sourceStatus} source · {relationship.followerStatus} follower · updated {new Date(relationship.updatedAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    <StatusPill tone="muted">{modeLabel(relationship.copySettings.copyMode)}</StatusPill>
                    {relationship.copySettings.maxLot ? <StatusPill tone="muted">Max {relationship.copySettings.maxLot} lots</StatusPill> : null}
                    {relationship.copySettings.reverseCopy ? <StatusPill tone="accent">Reversed</StatusPill> : null}
                    <StatusPill tone={relationship.status === "LIVE" ? "lime" : "muted"}>{relationship.status}</StatusPill>
                  </div>
                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    <GhostButton type="button" disabled={action.isPending} onClick={() => editRelationship(relationship)}>
                      <Settings2 className="mr-2 inline-block h-4 w-4" />Edit
                    </GhostButton>
                    <GhostButton
                      type="button"
                      disabled={action.isPending}
                      onClick={() => action.mutate({
                        url: `/api/copy-trading/self-copy/${relationship.id}`,
                        method: "PATCH",
                        body: { status: relationship.status === "LIVE" ? "PAUSED" : "LIVE" },
                        label: relationship.status === "LIVE" ? "Self-copy pause" : "Self-copy resume",
                      })}
                    >
                      {relationship.status === "LIVE" ? <Pause className="mr-2 inline-block h-4 w-4" /> : <Play className="mr-2 inline-block h-4 w-4" />}
                      {relationship.status === "LIVE" ? "Pause" : "Resume"}
                    </GhostButton>
                    <GhostButton
                      type="button"
                      disabled={action.isPending}
                      onClick={() => {
                        if (!window.confirm("Archive this self-copy route? Existing follower positions will not be force-closed.")) return;
                        action.mutate({
                          url: `/api/copy-trading/self-copy/${relationship.id}`,
                          method: "DELETE",
                          label: "Self-copy route removal",
                        });
                      }}
                    >
                      <Trash2 className="mr-2 inline-block h-4 w-4" />Remove
                    </GhostButton>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-5 pb-4">
              <PaginationControls
                currentPage={safePage}
                totalItems={filteredRelationships.length}
                pageSize={pageSize}
                pageSizeOptions={[10, 20, 50]}
                onPageChange={setPage}
                onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
              />
            </div>
          </div>
        ) : (
          <div className="px-5 py-9">
            <EmptyState
              title={allRelationships.length ? "No matching self-copy routes" : "No self-copy routes"}
              description={allRelationships.length ? "Adjust the search or status filter." : "Choose a source and follower account above to create your first live route."}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
