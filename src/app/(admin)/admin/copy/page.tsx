"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Plus, Repeat, X } from "lucide-react";
import Link from "next/link";
import { BrokerConnectPanel } from "@/components/accounts/BrokerConnectPanel";
import { CopyRulesAdminPanel } from "@/components/copy/CopyRulesAdminPanel";
import { MasterAccountConnectDialog } from "@/components/copy/MasterAccountConnectDialog";
import { GhostButton, InlineStatusStrip, Panel, PrimaryButton, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
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
};

type RuntimeStatus = { configured: boolean; enabled: boolean; executionEnabled: boolean; provider: "WSA_ENGINE" };

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

  const createStrategy = useMutation({
    mutationFn: () => api<CopyStrategyDto>("/api/admin/copy/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...strategyForm,
        standardMonthlyPrice: Number(strategyForm.standardMonthlyPrice),
        premiumMonthlyPrice: Number(strategyForm.premiumMonthlyPrice),
        riskMultiplier: 1,
        defaultScalingMode: "EQUITY_PROPORTIONAL",
      }),
    }),
    onSuccess: () => {
      refresh();
      setStrategyOpen(false);
      setStrategyForm({ name: "", description: "", masterAccountId: "", standardMonthlyPrice: "10", premiumMonthlyPrice: "15", currency: "USD" });
      setNotice({ tone: "ok", text: "Draft strategy created. Publish it only after its master account is connected." });
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

  const connectedMasters = accounts.filter((account) => account.status === "CONNECTED" && account.providerAccountId);

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Live Copy Trading"
      description="Connect master accounts, publish monthly strategies, and control their WSA engine lifecycle."
      action={
        <div className="flex flex-wrap justify-end gap-3">
          <GhostButton type="button" onClick={() => setMasterOpen(true)}><Copy className="mr-2 inline h-4 w-4" />New master account</GhostButton>
          <PrimaryButton type="button" onClick={() => setStrategyOpen(true)}><Plus className="mr-2 inline h-4 w-4" />New strategy</PrimaryButton>
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-semibold text-foreground">Master accounts</h2><p className="mt-1 text-sm text-muted">Only dedicated admin-owned master accounts can publish strategies.</p></div>
          <Link href="/admin/accounts" className="inline-flex items-center gap-2 text-sm font-semibold text-accent">Manage credentials <ExternalLink className="h-4 w-4" /></Link>
        </div>
        <div className="mt-4 grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account) => (
            <div key={account.accountId} className="flex h-full flex-col rounded-[4px] border border-line bg-background p-4">
              <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-foreground">{account.accountName}</p><p className="mt-1 text-xs text-muted">{account.brokerName}{account.serverName ? ` · ${account.serverName}` : ""}</p></div><StatusPill tone={account.status === "CONNECTED" ? "lime" : "accent"}>{account.status}</StatusPill></div>
              {!account.providerAccountId ? <p className="mt-3 text-xs text-accent">Credentials/provider connection required before publishing.</p> : null}
              <GhostButton type="button" className="mt-auto w-full" onClick={() => setConnectionAccountId(account.accountId)}>
                {account.providerAccountId ? "Manage MT4 / MT5 connection" : "Connect MT4 / MT5"}
              </GhostButton>
            </div>
          ))}
          {!accounts.length ? <p className="text-sm text-muted">No copy-master accounts yet.</p> : null}
        </div>
      </Panel>

      <Panel className="mt-5 overflow-hidden">
        <div><h2 className="text-lg font-semibold text-foreground">Published strategies</h2><p className="mt-1 text-sm text-muted">Each live strategy renews monthly for each selected follower account.</p></div>
        <div className="mt-4 space-y-3">
          {strategies.map((strategy) => (
            <div key={strategy.id} className="grid gap-4 rounded-[4px] border border-line bg-background p-4 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center">
              <div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-foreground">{strategy.name}</p><StatusPill tone={strategy.engineStatus === "LIVE" ? "lime" : strategy.engineStatus === "ERROR" ? "danger" : "accent"}>{strategy.engineStatus}</StatusPill></div><p className="mt-1 text-sm text-muted">Master: {strategy.masterAccountName ?? "Unknown"} · {strategy.followerCount} follower(s)</p>{strategy.engineError ? <p className="mt-2 text-xs text-danger">{strategy.engineError}</p> : null}</div>
              <div>
                <p className="font-semibold text-foreground">
                  {formatMoney({ amount: strategy.standardMonthlyPrice, currency: strategy.currency })} standard
                  <span className="text-xs font-normal text-muted"> / </span>
                  {formatMoney({ amount: strategy.premiumMonthlyPrice, currency: strategy.currency })} premium
                </p>
                <p className="mt-1 text-xs text-muted">Dispatch targets: {strategy.standardDelayMs / 1000}s standard · {strategy.premiumDelayMs / 1000}s premium</p>
              </div>
              <div className="flex flex-wrap justify-end gap-3">
                {strategy.engineStatus !== "LIVE" && strategy.status !== "ARCHIVED" ? <PrimaryButton type="button" disabled={strategyAction.isPending} onClick={() => strategyAction.mutate({ id: strategy.id, action: "publish" })}><Repeat className="mr-2 inline h-4 w-4" />Publish live</PrimaryButton> : null}
                {strategy.engineStatus === "LIVE" ? <GhostButton type="button" disabled={strategyAction.isPending} onClick={() => window.confirm("Archive this strategy and close its copied follower positions?") && strategyAction.mutate({ id: strategy.id, action: "archive" })}>Archive & close</GhostButton> : null}
              </div>
            </div>
          ))}
          {!isLoading && !strategies.length ? <p className="text-sm text-muted">No strategies yet. Connect a master account, then create your first strategy.</p> : null}
        </div>
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

      <SimpleDialog open={strategyOpen} onClose={() => setStrategyOpen(false)} title="Create monthly live strategy">
        <Field label="Strategy name" value={strategyForm.name} onChange={(value) => setStrategyForm((current) => ({ ...current, name: value }))} />
        <Field label="Description" value={strategyForm.description} onChange={(value) => setStrategyForm((current) => ({ ...current, description: value }))} />
        <label className="space-y-2 text-sm font-semibold text-foreground">Master account<select className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm" value={strategyForm.masterAccountId} onChange={(event) => setStrategyForm((current) => ({ ...current, masterAccountId: event.target.value }))}><option value="">Select connected master...</option>{connectedMasters.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountName}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Standard monthly price" type="number" value={strategyForm.standardMonthlyPrice} onChange={(value) => setStrategyForm((current) => ({ ...current, standardMonthlyPrice: value }))} />
          <Field label="Premium / fast monthly price" type="number" value={strategyForm.premiumMonthlyPrice} onChange={(value) => setStrategyForm((current) => ({ ...current, premiumMonthlyPrice: value }))} />
        </div>
        <Field label="Currency" value={strategyForm.currency} onChange={(value) => setStrategyForm((current) => ({ ...current, currency: value.toUpperCase() }))} />
        <p className="text-xs leading-5 text-muted">Standard dispatches at about 2.5 seconds; Premium/Fast targets 250 ms. Broker and network latency are additional.</p>
        <PrimaryButton type="button" disabled={createStrategy.isPending || !strategyForm.masterAccountId} onClick={() => createStrategy.mutate()}>{createStrategy.isPending ? "Creating..." : "Create draft"}</PrimaryButton>
      </SimpleDialog>
    </WorkspacePage>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange(value: string): void; type?: string }) {
  return <label className="space-y-2 text-sm font-semibold text-foreground">{label}<input type={type} className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm outline-none focus:border-accent" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SimpleDialog({ open, onClose, title, children }: { open: boolean; onClose(): void; title: string; children: React.ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6"><Dialog.Title className="text-xl font-semibold text-foreground">{title}</Dialog.Title><div className="mt-5 space-y-4">{children}</div><Dialog.Close className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full border border-line"><X className="h-4 w-4" /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function ConnectionDialog({ open, onClose, children }: { open: boolean; onClose(): void; children: React.ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[94vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 invisible-scrollbar overflow-y-auto rounded-[6px] border border-line bg-panel p-3 shadow-[0_24px_80px_rgba(0,0,0,0.6)] focus:outline-none"><Dialog.Title className="sr-only">Connect master trading account</Dialog.Title>{children}<Dialog.Close className="absolute right-6 top-6 z-10 grid h-9 w-9 place-items-center rounded-full border border-line bg-background text-muted hover:text-foreground"><X className="h-4 w-4" /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
