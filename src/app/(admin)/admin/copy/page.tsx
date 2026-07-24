"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Pencil, Plus, Power, Repeat, Trash2, X } from "lucide-react";
import Link from "next/link";
import { BrokerConnectPanel } from "@/components/accounts/BrokerConnectPanel";
import { CopyRulesAdminPanel } from "@/components/copy/CopyRulesAdminPanel";
import { MasterAccountConnectDialog } from "@/components/copy/MasterAccountConnectDialog";
import { GhostButton, InlineStatusStrip, Panel, PrimaryButton, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { SearchField, SelectField } from "@/components/app/FormFields";
import type { CopyStrategyDto } from "@/lib/copy/types";
import { formatMoney } from "@/lib/utils/format";

type MasterAccount = {
  accountId: string;
  accountName: string;
  brokerName: string;
  serverName: string | null;
  platform: string | null;
  status: string;
  providerAccountId: string | null;
  currency: string;
};

type RuntimeStatus = { configured: boolean; enabled: boolean; executionEnabled: boolean; provider: "WSA_ENGINE" };

const MASTER_PAGE_SIZE = 8;
const STRATEGY_PAGE_SIZE = 10;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data;
}

export default function AdminCopyPage() {
  const queryClient = useQueryClient();
  const [masterOpen, setMasterOpen] = useState(false);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null);
  const [editingMaster, setEditingMaster] = useState<MasterAccount | null>(null);
  const [masterSearch, setMasterSearch] = useState("");
  const [masterStatus, setMasterStatus] = useState("ALL");
  const [masterPage, setMasterPage] = useState(1);
  const [strategySearch, setStrategySearch] = useState("");
  const [strategyStatus, setStrategyStatus] = useState("ALL");
  const [strategyPage, setStrategyPage] = useState(1);
  const [connectionAccountId, setConnectionAccountId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [strategyForm, setStrategyForm] = useState({
    name: "",
    description: "",
    masterAccountId: "",
    standardMonthlyPrice: "10",
    premiumMonthlyPrice: "15",
    currency: "USD",
  });
  const [masterForm, setMasterForm] = useState({
    accountName: "",
    brokerName: "",
    currency: "USD",
  });

  const { data: runtime } = useQuery<RuntimeStatus>({
    queryKey: ["wsa-copy-runtime"],
    queryFn: () => api("/api/admin/copy/runtime"),
  });
  const { data: accounts = [] } = useQuery<MasterAccount[]>({
    queryKey: ["copy-master-accounts"],
    queryFn: () => api("/api/admin/copy/master-accounts"),
  });
  const { data: strategies = [], isLoading } = useQuery<CopyStrategyDto[]>({
    queryKey: ["admin-copy-strategies"],
    queryFn: () => api("/api/admin/copy/strategies"),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["copy-master-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["admin-copy-strategies"] });
  };

  const saveStrategy = useMutation({
    mutationFn: () => api<CopyStrategyDto>(
      editingStrategyId
        ? `/api/admin/copy/strategies/${editingStrategyId}`
        : "/api/admin/copy/strategies",
      {
      method: editingStrategyId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: strategyForm.name,
        description: strategyForm.description,
        ...(!editingStrategyId ? { masterAccountId: strategyForm.masterAccountId } : {}),
        standardMonthlyPrice: Number(strategyForm.standardMonthlyPrice),
        premiumMonthlyPrice: Number(strategyForm.premiumMonthlyPrice),
        ...(!editingStrategyId ? {
          currency: strategyForm.currency,
          riskMultiplier: 1,
          defaultScalingMode: "EQUITY_PROPORTIONAL",
        } : {}),
      }),
    }),
    onSuccess: () => {
      refresh();
      setStrategyOpen(false);
      const wasEditing = Boolean(editingStrategyId);
      setEditingStrategyId(null);
      setStrategyForm({ name: "", description: "", masterAccountId: "", standardMonthlyPrice: "10", premiumMonthlyPrice: "15", currency: "USD" });
      setNotice({
        tone: "ok",
        text: wasEditing
          ? "Strategy details updated."
          : "Draft strategy created. Publish it only after its master account is connected.",
      });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const strategyAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "publish" | "archive" }) =>
      api(`/api/admin/copy/strategies/${id}/${action}`, { method: "POST" }),
    onSuccess: (_data, variables) => {
      refresh();
      setNotice({
        tone: "ok",
        text: variables.action === "publish"
          ? "Strategy is live on the WSA engine and available for monthly subscriptions."
          : "Strategy is draining; the WSA engine will close its copied follower positions.",
      });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const deleteStrategy = useMutation({
    mutationFn: (id: string) => api(`/api/admin/copy/strategies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      setNotice({ tone: "ok", text: "Unused strategy deleted." });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const saveMaster = useMutation({
    mutationFn: () => {
      if (!editingMaster) throw new Error("No master account selected.");
      return api(`/api/admin/copy/master-accounts/${editingMaster.accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(masterForm),
      });
    },
    onSuccess: () => {
      refresh();
      setEditingMaster(null);
      setNotice({ tone: "ok", text: "Master account details updated." });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const masterLifecycle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "deactivate" | "reactivate" | "delete" }) => (
      action === "delete"
        ? api(`/api/admin/copy/master-accounts/${id}`, { method: "DELETE" })
        : api(`/api/admin/accounts/${id}/${action}`, { method: "POST" })
    ),
    onSuccess: (_data, variables) => {
      refresh();
      setNotice({
        tone: "ok",
        text: variables.action === "delete"
          ? "Unused master account deleted."
          : variables.action === "deactivate"
            ? "Master account archived and provider deployment stopped where available."
            : "Master account reactivated.",
      });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const openCreateStrategy = () => {
    setEditingStrategyId(null);
    setStrategyForm({
      name: "",
      description: "",
      masterAccountId: "",
      standardMonthlyPrice: "10",
      premiumMonthlyPrice: "15",
      currency: "USD",
    });
    setStrategyOpen(true);
  };

  const openEditStrategy = (strategy: CopyStrategyDto) => {
    setEditingStrategyId(strategy.id);
    setStrategyForm({
      name: strategy.name,
      description: strategy.description ?? "",
      masterAccountId: strategy.masterAccountId,
      standardMonthlyPrice: String(strategy.standardMonthlyPrice),
      premiumMonthlyPrice: String(strategy.premiumMonthlyPrice),
      currency: strategy.currency,
    });
    setStrategyOpen(true);
  };

  const openEditMaster = (account: MasterAccount) => {
    setEditingMaster(account);
    setMasterForm({
      accountName: account.accountName,
      brokerName: account.brokerName,
      currency: account.currency || "USD",
    });
  };

  const connectedMasters = accounts.filter((account) => account.status === "CONNECTED" && account.providerAccountId);
  const normalizedMasterSearch = masterSearch.trim().toLowerCase();
  const filteredMasters = accounts.filter((account) => (
    (masterStatus === "ALL" || account.status === masterStatus)
    && (
      normalizedMasterSearch.length === 0
      || account.accountName.toLowerCase().includes(normalizedMasterSearch)
      || account.brokerName.toLowerCase().includes(normalizedMasterSearch)
      || account.serverName?.toLowerCase().includes(normalizedMasterSearch) === true
    )
  ));
  const masterPageSafe = Math.min(masterPage, Math.max(1, Math.ceil(filteredMasters.length / MASTER_PAGE_SIZE)));
  const visibleMasters = filteredMasters.slice(
    (masterPageSafe - 1) * MASTER_PAGE_SIZE,
    masterPageSafe * MASTER_PAGE_SIZE,
  );
  const normalizedStrategySearch = strategySearch.trim().toLowerCase();
  const filteredStrategies = strategies.filter((strategy) => (
    (strategyStatus === "ALL" || strategy.status === strategyStatus || strategy.engineStatus === strategyStatus)
    && (
      normalizedStrategySearch.length === 0
      || strategy.name.toLowerCase().includes(normalizedStrategySearch)
      || strategy.masterAccountName?.toLowerCase().includes(normalizedStrategySearch) === true
    )
  ));
  const strategyPageSafe = Math.min(strategyPage, Math.max(1, Math.ceil(filteredStrategies.length / STRATEGY_PAGE_SIZE)));
  const visibleStrategies = filteredStrategies.slice(
    (strategyPageSafe - 1) * STRATEGY_PAGE_SIZE,
    strategyPageSafe * STRATEGY_PAGE_SIZE,
  );

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Live Copy Trading"
      description="Connect master accounts, publish monthly strategies, and control their WSA engine lifecycle."
      action={
        <div className="flex flex-wrap justify-end gap-3">
          <GhostButton type="button" onClick={() => setMasterOpen(true)}><Copy className="mr-2 inline h-4 w-4" />New master account</GhostButton>
          <PrimaryButton type="button" onClick={openCreateStrategy}><Plus className="mr-2 inline h-4 w-4" />New strategy</PrimaryButton>
        </div>
      }
    >
      <div className={`mb-5 rounded-[4px] border px-4 py-3 text-sm ${runtime?.configured ? "border-lime/30 bg-lime/10 text-lime" : "border-accent/30 bg-accent/10 text-accent"}`}>
        <strong>WSA engine:</strong> {runtime?.configured ? "configured for explicit live publishing" : "not enabled on this server"}.
        {!runtime?.configured ? " Set METAAPI_TOKEN and WSA_COPY_ENGINE_ENABLED=true before publishing; no order will be copied until then." : runtime.executionEnabled ? " Live execution is enabled and can affect connected brokerage accounts." : " Monitoring is configured, but broker execution is still disabled."}
      </div>

      {notice ? <div className={`mb-5 rounded-[4px] border px-4 py-3 text-sm ${notice.tone === "ok" ? "border-lime/30 bg-lime/10 text-lime" : "border-danger/30 bg-danger/10 text-danger"}`}>{notice.text}</div> : null}

      <InlineStatusStrip items={[
        { label: "Engine", value: "WSA GLOBAL", tone: "accent" },
        { label: "Master accounts", value: accounts.length },
        { label: "Connected masters", value: connectedMasters.length, tone: connectedMasters.length ? "lime" : "accent" },
        { label: "Live strategies", value: strategies.filter((item) => item.engineStatus === "LIVE").length, tone: "lime" },
        { label: "Monthly billing", value: "PER STRATEGY", tone: "accent" },
      ]} />

      <Panel className="mt-5 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Master account directory</h2>
            <p className="mt-1 text-sm text-muted">Search, connect, edit, archive, or remove unused admin-owned masters.</p>
          </div>
          <Link href="/admin/accounts" className="inline-flex items-center gap-2 text-sm font-semibold text-accent">
            Manage credentials <ExternalLink className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-4 grid gap-3 border-y border-line py-4 sm:grid-cols-[minmax(0,1fr)_220px]">
          <SearchField
            aria-label="Search master accounts"
            placeholder="Account, broker, or server"
            value={masterSearch}
            onChange={(event) => {
              setMasterSearch(event.target.value);
              setMasterPage(1);
            }}
          />
          <SelectField
            label="Connection status"
            value={masterStatus}
            onChange={(event) => {
              setMasterStatus(event.target.value);
              setMasterPage(1);
            }}
          >
            <option value="ALL">All statuses</option>
            <option value="CONNECTED">Connected</option>
            <option value="PENDING">Pending</option>
            <option value="DISCONNECTED">Disconnected</option>
            <option value="INACTIVE">Archived</option>
          </SelectField>
        </div>
        <div className="mt-4 grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-4">
          {visibleMasters.map((account) => (
            <div key={account.accountId} className="flex h-full flex-col rounded-[4px] border border-line bg-background p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">{account.accountName}</p>
                  <p className="mt-1 truncate text-xs text-muted">
                    {[account.brokerName, account.serverName].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <StatusPill tone={account.status === "CONNECTED" ? "lime" : account.status === "INACTIVE" ? "muted" : "accent"}>
                  {account.status === "INACTIVE" ? "ARCHIVED" : account.status}
                </StatusPill>
              </div>
              {!account.providerAccountId ? <p className="mt-3 text-xs text-accent">Credentials/provider connection required before publishing.</p> : null}
              <div className="mt-auto grid grid-cols-2 gap-2 pt-4">
                <GhostButton type="button" className="col-span-2 w-full" onClick={() => setConnectionAccountId(account.accountId)}>
                  {account.providerAccountId ? "Manage connection" : "Connect MT4 / MT5"}
                </GhostButton>
                <GhostButton type="button" onClick={() => openEditMaster(account)}>
                  <Pencil className="mr-1 inline h-3.5 w-3.5" /> Edit
                </GhostButton>
                {account.status === "INACTIVE" ? (
                  <GhostButton
                    type="button"
                    disabled={masterLifecycle.isPending}
                    onClick={() => masterLifecycle.mutate({ id: account.accountId, action: "reactivate" })}
                  >
                    Reactivate
                  </GhostButton>
                ) : (
                  <GhostButton
                    type="button"
                    disabled={masterLifecycle.isPending}
                    onClick={() => window.confirm("Archive this master and stop its provider deployment?") && masterLifecycle.mutate({ id: account.accountId, action: "deactivate" })}
                  >
                    <Power className="mr-1 inline h-3.5 w-3.5" /> Archive
                  </GhostButton>
                )}
                {!account.providerAccountId ? (
                  <GhostButton
                    type="button"
                    className="col-span-2 text-danger"
                    disabled={masterLifecycle.isPending}
                    onClick={() => window.confirm("Permanently delete this unused master account?") && masterLifecycle.mutate({ id: account.accountId, action: "delete" })}
                  >
                    <Trash2 className="mr-1 inline h-3.5 w-3.5" /> Delete unused master
                  </GhostButton>
                ) : null}
              </div>
            </div>
          ))}
          {!filteredMasters.length ? <p className="text-sm text-muted">No master accounts match these filters.</p> : null}
        </div>
        <Pagination page={masterPageSafe} pageSize={MASTER_PAGE_SIZE} totalItems={filteredMasters.length} onPageChange={setMasterPage} />
      </Panel>

      <Panel className="mt-5 overflow-hidden">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Strategy directory</h2>
          <p className="mt-1 text-sm text-muted">Edit drafts and pricing, publish live, archive safely, or delete unused records.</p>
        </div>
        <div className="mt-4 grid gap-3 border-y border-line py-4 sm:grid-cols-[minmax(0,1fr)_220px]">
          <SearchField
            aria-label="Search strategies"
            placeholder="Strategy or master account"
            value={strategySearch}
            onChange={(event) => {
              setStrategySearch(event.target.value);
              setStrategyPage(1);
            }}
          />
          <SelectField
            label="Strategy status"
            value={strategyStatus}
            onChange={(event) => {
              setStrategyStatus(event.target.value);
              setStrategyPage(1);
            }}
          >
            <option value="ALL">All statuses</option>
            <option value="LIVE">Live</option>
            <option value="DRAFT">Draft</option>
            <option value="PAUSED">Paused</option>
            <option value="ARCHIVED">Archived</option>
            <option value="ERROR">Error</option>
          </SelectField>
        </div>
        <div className="mt-4 space-y-3">
          {visibleStrategies.map((strategy) => (
            <div key={strategy.id} className="grid gap-4 rounded-[4px] border border-line bg-background p-4 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-foreground">{strategy.name}</p>
                  <StatusPill tone={strategy.engineStatus === "LIVE" ? "lime" : strategy.engineStatus === "ERROR" ? "danger" : strategy.status === "ARCHIVED" ? "muted" : "accent"}>
                    {strategy.engineStatus}
                  </StatusPill>
                </div>
                <p className="mt-1 text-sm text-muted">
                  Master: {strategy.masterAccountName ?? "Unknown"} · {strategy.followerCount} follower(s)
                </p>
                {strategy.engineError ? <p className="mt-2 text-xs text-danger">{strategy.engineError}</p> : null}
              </div>
              <div>
                <p className="font-semibold text-foreground">
                  {formatMoney({ amount: strategy.standardMonthlyPrice, currency: strategy.currency })} standard
                  <span className="text-xs font-normal text-muted"> / </span>
                  {formatMoney({ amount: strategy.premiumMonthlyPrice, currency: strategy.currency })} premium
                </p>
                <p className="mt-1 text-xs text-muted">Dispatch targets: {strategy.standardDelayMs / 1000}s standard · {strategy.premiumDelayMs / 1000}s premium</p>
              </div>
              <div className="flex min-w-[210px] flex-wrap justify-end gap-2">
                <GhostButton type="button" onClick={() => openEditStrategy(strategy)}>
                  <Pencil className="mr-1 inline h-3.5 w-3.5" /> Edit
                </GhostButton>
                {strategy.engineStatus !== "LIVE" && strategy.status !== "ARCHIVED" ? <PrimaryButton type="button" disabled={strategyAction.isPending} onClick={() => strategyAction.mutate({ id: strategy.id, action: "publish" })}><Repeat className="mr-2 inline h-4 w-4" />Publish live</PrimaryButton> : null}
                {strategy.engineStatus === "LIVE" ? <GhostButton type="button" disabled={strategyAction.isPending} onClick={() => window.confirm("Archive this strategy and close its copied follower positions?") && strategyAction.mutate({ id: strategy.id, action: "archive" })}>Archive & close</GhostButton> : null}
                {(strategy.status === "DRAFT" || strategy.status === "ARCHIVED") ? (
                  <GhostButton
                    type="button"
                    className="text-danger"
                    disabled={deleteStrategy.isPending}
                    onClick={() => window.confirm("Permanently delete this unused strategy? Strategies with follower or payment history cannot be deleted.") && deleteStrategy.mutate(strategy.id)}
                  >
                    <Trash2 className="mr-1 inline h-3.5 w-3.5" /> Delete
                  </GhostButton>
                ) : null}
              </div>
            </div>
          ))}
          {!isLoading && !filteredStrategies.length ? <p className="text-sm text-muted">No strategies match these filters.</p> : null}
        </div>
        <Pagination page={strategyPageSafe} pageSize={STRATEGY_PAGE_SIZE} totalItems={filteredStrategies.length} onPageChange={setStrategyPage} />
      </Panel>

      <CopyRulesAdminPanel />

      <MasterAccountConnectDialog
        open={masterOpen}
        onClose={() => setMasterOpen(false)}
        onConnected={(message) => {
          setMasterOpen(false);
          refresh();
          setNotice({ tone: "ok", text: message });
        }}
      />

      <ConnectionDialog
        open={Boolean(connectionAccountId)}
        onClose={() => {
          setConnectionAccountId(null);
          refresh();
        }}
      >
        {connectionAccountId ? <BrokerConnectPanel accountId={connectionAccountId} /> : null}
      </ConnectionDialog>

      <SimpleDialog open={Boolean(editingMaster)} onClose={() => setEditingMaster(null)} title="Edit master account">
        <Field label="Account name" value={masterForm.accountName} onChange={(value) => setMasterForm((current) => ({ ...current, accountName: value }))} />
        <Field label="Broker name" value={masterForm.brokerName} onChange={(value) => setMasterForm((current) => ({ ...current, brokerName: value }))} />
        <Field label="Currency" value={masterForm.currency} onChange={(value) => setMasterForm((current) => ({ ...current, currency: value.toUpperCase() }))} />
        <p className="text-xs leading-5 text-muted">Broker credentials and server details remain managed through the secure connection workflow.</p>
        <PrimaryButton type="button" disabled={saveMaster.isPending} onClick={() => saveMaster.mutate()}>
          {saveMaster.isPending ? "Saving..." : "Save master"}
        </PrimaryButton>
      </SimpleDialog>

      <SimpleDialog
        open={strategyOpen}
        onClose={() => {
          setStrategyOpen(false);
          setEditingStrategyId(null);
        }}
        title={editingStrategyId ? "Edit live strategy" : "Create monthly live strategy"}
      >
        <Field label="Strategy name" value={strategyForm.name} onChange={(value) => setStrategyForm((current) => ({ ...current, name: value }))} />
        <Field label="Description" value={strategyForm.description} onChange={(value) => setStrategyForm((current) => ({ ...current, description: value }))} />
        <label className="space-y-2 text-sm font-semibold text-foreground">
          Master account
          <select
            className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm disabled:opacity-60"
            value={strategyForm.masterAccountId}
            disabled={Boolean(editingStrategyId)}
            onChange={(event) => setStrategyForm((current) => ({ ...current, masterAccountId: event.target.value }))}
          >
            <option value="">Select connected master...</option>
            {connectedMasters.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountName}</option>)}
            {editingStrategyId && !connectedMasters.some((account) => account.accountId === strategyForm.masterAccountId) ? (
              <option value={strategyForm.masterAccountId}>Current master account</option>
            ) : null}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Standard monthly price" type="number" value={strategyForm.standardMonthlyPrice} onChange={(value) => setStrategyForm((current) => ({ ...current, standardMonthlyPrice: value }))} />
          <Field label="Premium / fast monthly price" type="number" value={strategyForm.premiumMonthlyPrice} onChange={(value) => setStrategyForm((current) => ({ ...current, premiumMonthlyPrice: value }))} />
        </div>
        {!editingStrategyId ? (
          <Field label="Currency" value={strategyForm.currency} onChange={(value) => setStrategyForm((current) => ({ ...current, currency: value.toUpperCase() }))} />
        ) : null}
        <p className="text-xs leading-5 text-muted">Standard dispatches at about 2.5 seconds; Premium/Fast targets 250 ms. Broker and network latency are additional.</p>
        <PrimaryButton type="button" disabled={saveStrategy.isPending || !strategyForm.masterAccountId} onClick={() => saveStrategy.mutate()}>
          {saveStrategy.isPending ? "Saving..." : editingStrategyId ? "Save changes" : "Create draft"}
        </PrimaryButton>
      </SimpleDialog>
    </WorkspacePage>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange(value: string): void; type?: string }) {
  return <label className="space-y-2 text-sm font-semibold text-foreground">{label}<input type={type} className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm outline-none focus:border-accent" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange(page: number): void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
        {totalItems === 0 ? "No records" : `${start}-${end} of ${totalItems}`}
      </p>
      <div className="flex gap-2">
        <GhostButton type="button" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>
          Previous
        </GhostButton>
        <GhostButton type="button" disabled={page >= totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))}>
          Next
        </GhostButton>
      </div>
    </div>
  );
}

function SimpleDialog({ open, onClose, title, children }: { open: boolean; onClose(): void; title: string; children: React.ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6"><Dialog.Title className="text-xl font-semibold text-foreground">{title}</Dialog.Title><div className="mt-5 space-y-4">{children}</div><Dialog.Close className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full border border-line"><X className="h-4 w-4" /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function ConnectionDialog({ open, onClose, children }: { open: boolean; onClose(): void; children: React.ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[94vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 invisible-scrollbar overflow-y-auto rounded-[6px] border border-line bg-panel p-3 shadow-[0_24px_80px_rgba(0,0,0,0.6)] focus:outline-none"><Dialog.Title className="sr-only">Connect master trading account</Dialog.Title>{children}<Dialog.Close className="absolute right-6 top-6 z-10 grid h-9 w-9 place-items-center rounded-full border border-line bg-background text-muted hover:text-foreground"><X className="h-4 w-4" /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
