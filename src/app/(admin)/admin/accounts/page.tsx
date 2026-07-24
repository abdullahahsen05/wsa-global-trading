"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, Search, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DirectorySearchOverlay } from "@/components/app/DirectorySearchOverlay";
import {
  GhostButton,
  FilterChipRow,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField } from "@/components/app/FormFields";
import type { TraderAccountSummary } from "@/lib/domain/types";
import { formatMoney, formatPercent } from "@/lib/utils/format";

const STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  CONNECTED: "lime",
  SYNCING: "accent",
  PENDING: "accent",
  DISCONNECTED: "muted",
  RESTRICTED: "danger",
  INACTIVE: "muted",
};

export default function AdminAccountsPage() {
  const queryClient = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [accountMessage, setAccountMessage] = useState("");

  // Auto-dismiss success messages after 6 seconds
  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(""), 6000);
    return () => clearTimeout(t);
  }, [successMessage]);
  const [selectedId, setSelectedId] = useState("");
  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);
  const [confirmReactivateOpen, setConfirmReactivateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"ALL" | "CONNECTED" | "SYNCING" | "DISCONNECTED" | "RESTRICTED" | "PENDING" | "INACTIVE">(
    "ALL",
  );
  const [credForm, setCredForm] = useState({
    platform: "MT5",
    login: "",
    password: "",
    server: "",
    brokerName: "",
  });

  const { data: accounts = [], isLoading } = useQuery<TraderAccountSummary[]>({
    queryKey: ["admin-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/admin/accounts");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
  });

  const filteredAccounts = accounts.filter(
    (account) => statusFilter === "ALL" || account.status === statusFilter,
  );
  const effectiveSelectedId = selectedId || accounts[0]?.accountId || "";
  const selectedAccount =
    filteredAccounts.find((account) => account.accountId === effectiveSelectedId) ??
    filteredAccounts[0] ??
    accounts[0];

  const handleVerify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setVerifyOpen(false);
    setSuccessMessage("Verification queued (feature coming soon — no API call made).");
  };

  const storeCreds = useMutation({
    mutationFn: async () => {
      if (!effectiveSelectedId) throw new Error("No account selected.");
      const res = await fetch(`/api/trading-accounts/${effectiveSelectedId}/broker-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: credForm.platform,
          login: credForm.login.trim(),
          password: credForm.password,
          server: credForm.server.trim(),
          brokerName: credForm.brokerName.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to store credentials");
      return json.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["admin-accounts"] });
      setCredOpen(false);
      setCredForm({ platform: "MT5", login: "", password: "", server: "", brokerName: "" });
      setSuccessMessage(
        data.connected
          ? "Credentials stored and the selected account synced successfully."
          : data.message ?? "Credentials stored, but the selected account is not connected yet.",
      );
    },
    onError: (err: Error) => setAccountMessage(err.message),
  });

  const syncAccount = useMutation({
    mutationFn: async () => {
      if (!effectiveSelectedId) throw new Error("No account selected.");
      const res = await fetch(`/api/trading-accounts/${effectiveSelectedId}/sync`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Sync failed");
      return json.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["admin-accounts"] });
      setSuccessMessage(
        data.status === "PENDING"
          ? `MetaAPI is still deploying — sync will complete automatically. Check back in a minute.`
          : `Sync complete: ${data.tradesUpserted} trade${data.tradesUpserted !== 1 ? "s" : ""} updated.`,
      );
    },
    onError: (err: Error) => setAccountMessage(err.message),
  });

  const deactivateAccount = useMutation({
    mutationFn: async () => {
      if (!effectiveSelectedId) throw new Error("No account selected.");
      const res = await fetch(`/api/admin/accounts/${effectiveSelectedId}/deactivate`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Deactivation failed");
      return json.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["admin-accounts"] });
      setSuccessMessage(
        `Account deactivated. MetaAPI: ${data.providerResult}.${data.providerError ? ` Note: ${data.providerError}` : ""}`,
      );
    },
    onError: (err: Error) => setAccountMessage(err.message),
  });

  const reactivateAccount = useMutation({
    mutationFn: async () => {
      if (!effectiveSelectedId) throw new Error("No account selected.");
      const res = await fetch(`/api/admin/accounts/${effectiveSelectedId}/reactivate`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Reactivation failed");
      return json.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["admin-accounts"] });
      setSuccessMessage(
        `Account reactivated (${data.status}). MetaAPI: ${data.providerResult}.${data.providerError ? ` Note: ${data.providerError}` : ""}`,
      );
    },
    onError: (err: Error) => setAccountMessage(err.message),
  });

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Account supervision"
      description="Overlay-first directory for broker-linked accounts, drawdown review, and queue-based verification."
      action={
        <PageActionGroup>
          <GhostButton type="button" onClick={() => setSearchOpen(true)}>
            <Search className="mr-2 inline-block h-4 w-4" />
            Search
          </GhostButton>
          <Dialog.Root open={verifyOpen} onOpenChange={setVerifyOpen}>
            <Dialog.Trigger asChild>
              <PrimaryButton type="button">
                <CheckCircle2 className="mr-2 inline-block h-4 w-4" />
                Verify selected
              </PrimaryButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
                <Dialog.Title className="text-xl font-semibold text-foreground">Verify accounts</Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  Queue broker connection verification for the selected trading accounts.
                </Dialog.Description>
                <form className="mt-6 grid gap-4" onSubmit={handleVerify}>
                  <SelectField label="Verification scope" defaultValue="ALL">
                    <option value="ALL">All visible accounts</option>
                    <option value="CONNECTED">Connected only</option>
                    <option value="SYNCING">Syncing only</option>
                  </SelectField>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                    <p className="text-sm text-muted">Verification updates the queue and clears no data.</p>
                    <div className="flex gap-3">
                      <Dialog.Close asChild>
                        <GhostButton type="button">Cancel</GhostButton>
                      </Dialog.Close>
                      <PrimaryButton type="submit">Queue verification</PrimaryButton>
                    </div>
                  </div>
                </form>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close dialog"
                    className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-[4px] border border-line bg-background text-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Accounts", value: isLoading ? "..." : accounts.length },
          {
            label: "Connected",
            value: accounts.filter((a) => a.status === "CONNECTED").length,
            tone: "lime",
          },
          {
            label: "Pending",
            value: accounts.filter((a) => a.status === "PENDING").length,
            tone: "accent",
          },
          {
            label: "Inactive",
            value: accounts.filter((a) => a.status === "INACTIVE").length,
          },
          {
            label: "Open trades",
            value: accounts.reduce((sum, a) => sum + a.openTradeCount, 0),
          },
        ]}
      />

      <div className="mt-5 invisible-scrollbar overflow-x-auto border-b border-line pb-3">
        <FilterChipRow
          chips={[
            {
              label: `All (${accounts.length})`,
              active: statusFilter === "ALL",
              onClick: () => {
                setStatusFilter("ALL");
                setSelectedId(accounts[0]?.accountId ?? "");
              },
            },
            {
              label: `Connected (${accounts.filter((a) => a.status === "CONNECTED").length})`,
              active: statusFilter === "CONNECTED",
              onClick: () => {
                setStatusFilter("CONNECTED");
                setSelectedId(accounts.find((a) => a.status === "CONNECTED")?.accountId ?? accounts[0]?.accountId ?? "");
              },
            },
            {
              label: `Pending (${accounts.filter((a) => a.status === "PENDING").length})`,
              active: statusFilter === "PENDING",
              onClick: () => {
                setStatusFilter("PENDING");
                setSelectedId(accounts.find((a) => a.status === "PENDING")?.accountId ?? accounts[0]?.accountId ?? "");
              },
            },
            {
              label: `Disconnected (${accounts.filter((a) => a.status === "DISCONNECTED").length})`,
              active: statusFilter === "DISCONNECTED",
              onClick: () => {
                setStatusFilter("DISCONNECTED");
                setSelectedId(accounts.find((a) => a.status === "DISCONNECTED")?.accountId ?? accounts[0]?.accountId ?? "");
              },
            },
            {
              label: `Restricted (${accounts.filter((a) => a.status === "RESTRICTED").length})`,
              active: statusFilter === "RESTRICTED",
              onClick: () => {
                setStatusFilter("RESTRICTED");
                setSelectedId(accounts.find((a) => a.status === "RESTRICTED")?.accountId ?? accounts[0]?.accountId ?? "");
              },
            },
            {
              label: `Inactive (${accounts.filter((a) => a.status === "INACTIVE").length})`,
              active: statusFilter === "INACTIVE",
              onClick: () => {
                setStatusFilter("INACTIVE");
                setSelectedId(accounts.find((a) => a.status === "INACTIVE")?.accountId ?? accounts[0]?.accountId ?? "");
              },
            },
          ]}
        />
      </div>

      {successMessage ? (
        <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
          {successMessage}
        </div>
      ) : null}

      {accountMessage ? (
        <div className="mt-3 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
          {accountMessage}
        </div>
      ) : null}

      {selectedAccount ? (
        <div className="mt-5">
          <Panel className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Selected account</p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">{selectedAccount.accountName}</h2>
                <p className="mt-1 text-sm text-muted">{selectedAccount.brokerName}</p>
              </div>
              <StatusPill tone={STATUS_TONE[selectedAccount.status] ?? "muted"}>
                {selectedAccount.status}
              </StatusPill>
            </div>

            <div className="mt-4 grid gap-0 overflow-hidden rounded-[4px] border-l border-t border-line sm:grid-cols-2 xl:grid-cols-3">
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Balance</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{formatMoney(selectedAccount.balance)}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Equity</p>
                <p className="mt-1 text-sm font-semibold text-accent-2">{formatMoney(selectedAccount.equity)}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Drawdown</p>
                <p className="mt-1 text-sm font-semibold text-danger">{formatPercent(selectedAccount.drawdownPercent)}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Open trades</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{selectedAccount.openTradeCount}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Floating P&L</p>
                <p className={`mt-1 text-sm font-semibold ${selectedAccount.floatingPnl.amount >= 0 ? "text-accent-2" : "text-danger"}`}>
                  {formatMoney(selectedAccount.floatingPnl)}
                </p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Last updated</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{new Date(selectedAccount.updatedAt).toLocaleString()}</p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <GhostButton
                type="button"
                onClick={() => { setAccountMessage(""); setSuccessMessage(""); setCredOpen(true); }}
              >
                Store MT5 credentials
              </GhostButton>
              <GhostButton
                type="button"
                disabled={syncAccount.isPending}
                onClick={() => { setAccountMessage(""); setSuccessMessage(""); syncAccount.mutate(); }}
              >
                {syncAccount.isPending ? "Syncing…" : "Sync account"}
              </GhostButton>
              {selectedAccount.status === "INACTIVE" ? (
                <GhostButton
                  type="button"
                  disabled={reactivateAccount.isPending}
                  onClick={() => { setAccountMessage(""); setSuccessMessage(""); setConfirmReactivateOpen(true); }}
                >
                  Reactivate
                </GhostButton>
              ) : (
                <GhostButton
                  type="button"
                  disabled={deactivateAccount.isPending}
                  onClick={() => { setAccountMessage(""); setSuccessMessage(""); setConfirmDeactivateOpen(true); }}
                >
                  Deactivate
                </GhostButton>
              )}
              <GhostButton
                type="button"
                onClick={() => setAccountMessage("Remove from queue is coming soon — no action taken.")}
              >
                Remove from queue
              </GhostButton>
            </div>
          </Panel>
        </div>
      ) : isLoading ? (
        <div className="mt-5 rounded-[4px] border border-line bg-panel p-8 text-center text-sm text-muted">
          Loading accounts...
        </div>
      ) : null}

      <DirectorySearchOverlay<TraderAccountSummary>
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Find accounts"
        description="Search and filters stay in the overlay so the supervision page remains minimal."
        items={accounts}
        selectedId={selectedAccount?.accountId ?? ""}
        onSelect={(id) => {
          setSelectedId(id);
          setSearchOpen(false);
        }}
        searchLabel="Search accounts"
        searchPlaceholder="Search by account or broker"
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "ALL", label: "All statuses" },
              { value: "CONNECTED", label: "Connected" },
              { value: "PENDING", label: "Pending" },
              { value: "DISCONNECTED", label: "Disconnected" },
              { value: "RESTRICTED", label: "Restricted" },
              { value: "INACTIVE", label: "Inactive" },
            ],
          },
        ]}
        emptyTitle="No accounts match"
        emptyDescription="Adjust the search term or status filter."
        getId={(account) => account.accountId}
        matches={(account, state) => {
          const search = state.query.trim().toLowerCase();
          const matchesQuery =
            search.length === 0 ||
            account.accountName.toLowerCase().includes(search) ||
            account.brokerName.toLowerCase().includes(search);
          const matchesStatus = state.filters.status === "ALL" || account.status === state.filters.status;
          return matchesQuery && matchesStatus;
        }}
        renderRow={(account) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{account.accountName}</p>
                <p className="mt-1 truncate text-xs text-muted">{account.brokerName}</p>
                <p className="mt-1 truncate text-xs text-muted">
                  {[account.platform, account.serverName].filter(Boolean).join(" · ") || "Details pending"}
                </p>
              </div>
              <StatusPill tone={STATUS_TONE[account.status] ?? "muted"}>{account.status}</StatusPill>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {formatMoney(account.equity)}
              </span>
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {formatPercent(account.drawdownPercent)} DD
              </span>
            </div>
          </>
        )}
        renderPreview={(account) => (
          <Panel className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Account preview</p>
                <h3 className="mt-2 text-lg font-semibold text-foreground">{account.accountName}</h3>
                <p className="mt-1 text-sm text-muted">{account.brokerName}</p>
                <p className="mt-1 text-xs text-muted">
                  {[account.platform, account.serverName].filter(Boolean).join(" · ") || "Details pending"}
                </p>
              </div>
              <StatusPill tone={STATUS_TONE[account.status] ?? "muted"}>{account.status}</StatusPill>
            </div>
            <div className="mt-4 grid gap-0 overflow-hidden rounded-[4px] border-l border-t border-line sm:grid-cols-2">
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Balance</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{formatMoney(account.balance)}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Equity</p>
                <p className="mt-1 text-sm font-semibold text-accent-2">{formatMoney(account.equity)}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Drawdown</p>
                <p className="mt-1 text-sm font-semibold text-danger">{formatPercent(account.drawdownPercent)}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Open trades</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{account.openTradeCount}</p>
              </div>
            </div>
          </Panel>
        )}
      />

      {/* Deactivate confirmation */}
      <Dialog.Root open={confirmDeactivateOpen} onOpenChange={setConfirmDeactivateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-danger/30 bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="text-xl font-semibold text-foreground">Deactivate account?</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              <strong className="text-foreground">{selectedAccount?.accountName}</strong> will be undeployed from MetaAPI (saves cost). The account data stays intact — you can reactivate at any time.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-3 border-t border-line pt-4">
              <Dialog.Close asChild>
                <GhostButton type="button">Cancel</GhostButton>
              </Dialog.Close>
              <GhostButton
                type="button"
                disabled={deactivateAccount.isPending}
                onClick={() => { setConfirmDeactivateOpen(false); deactivateAccount.mutate(); }}
              >
                {deactivateAccount.isPending ? "Deactivating…" : "Yes, deactivate"}
              </GhostButton>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-[4px] border border-line bg-background text-muted">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Reactivate confirmation */}
      <Dialog.Root open={confirmReactivateOpen} onOpenChange={setConfirmReactivateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-accent/30 bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="text-xl font-semibold text-foreground">Reactivate account?</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              <strong className="text-foreground">{selectedAccount?.accountName}</strong> will be redeployed on MetaAPI. This will resume MetaAPI billing for this account.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-3 border-t border-line pt-4">
              <Dialog.Close asChild>
                <GhostButton type="button">Cancel</GhostButton>
              </Dialog.Close>
              <PrimaryButton
                type="button"
                disabled={reactivateAccount.isPending}
                onClick={() => { setConfirmReactivateOpen(false); reactivateAccount.mutate(); }}
              >
                {reactivateAccount.isPending ? "Reactivating…" : "Yes, reactivate"}
              </PrimaryButton>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-[4px] border border-line bg-background text-muted">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Store MT5 credentials dialog for selected account */}
      <Dialog.Root open={credOpen} onOpenChange={setCredOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="text-xl font-semibold text-foreground">Store MT5 credentials</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              For: <strong>{selectedAccount?.accountName ?? "selected account"}</strong>. Credentials are encrypted with AES-256-GCM and never returned or logged.
            </Dialog.Description>
            <form
              className="mt-5 grid gap-4"
              onSubmit={(e) => { e.preventDefault(); storeCreds.mutate(); }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Platform</label>
                  <select
                    value={credForm.platform}
                    onChange={(e) => setCredForm((f) => ({ ...f, platform: e.target.value }))}
                    className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                  >
                    <option value="MT5">MT5</option>
                    <option value="MT4">MT4</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Broker name (optional)</label>
                  <input
                    type="text"
                    value={credForm.brokerName}
                    onChange={(e) => setCredForm((f) => ({ ...f, brokerName: e.target.value }))}
                    placeholder="e.g. ICMarkets"
                    maxLength={100}
                    className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Login *</label>
                <input
                  type="text"
                  required
                  value={credForm.login}
                  onChange={(e) => setCredForm((f) => ({ ...f, login: e.target.value }))}
                  placeholder="MT5 account number"
                  maxLength={50}
                  className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Password *</label>
                  <input
                    type="password"
                    required
                    value={credForm.password}
                    onChange={(e) => setCredForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="Investor or main password"
                    maxLength={200}
                    autoComplete="new-password"
                    className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Server *</label>
                  <input
                    type="text"
                    required
                    value={credForm.server}
                    onChange={(e) => setCredForm((f) => ({ ...f, server: e.target.value }))}
                    placeholder="e.g. ICMarketsSC-Demo02"
                    maxLength={100}
                    className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
                  />
                </div>
              </div>
              {selectedAccount?.status === "CONNECTED" ? (
                <div className="rounded-[4px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                  This account is currently <strong>CONNECTED</strong>. Storing new credentials will replace the existing ones immediately.
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-xs text-muted">Storing new credentials replaces existing ones.</p>
                <div className="flex gap-3">
                  <Dialog.Close asChild>
                    <GhostButton type="button">Cancel</GhostButton>
                  </Dialog.Close>
                  <PrimaryButton type="submit" disabled={storeCreds.isPending}>
                    {storeCreds.isPending ? "Storing…" : "Store credentials"}
                  </PrimaryButton>
                </div>
              </div>
            </form>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-[4px] border border-line bg-background text-muted">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}
