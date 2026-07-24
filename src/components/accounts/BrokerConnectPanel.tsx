"use client";

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCcw, ShieldCheck, X } from "lucide-react";
import { GhostButton, Panel, PrimaryButton, StatusPill } from "@/components/app/WorkspaceUI";

interface CredentialStatus {
  accountId: string;
  credentialsStored: boolean;
  provider: string | null;
  providerAccountId: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  status: string | null;
  brokerName: string | null;
  brokerProviderId: string | null;
  serverName: string | null;
  platform: "MT4" | "MT5" | null;
}

interface ConnectionResult extends SyncResult {
  credentialsStored: boolean;
  connected: boolean;
}

interface SyncResult {
  accountId: string;
  status: string;
  snapshotStored: boolean;
  tradesUpserted: number;
  lastSyncedAt?: string;
  message?: string;
}

interface VerifyResult {
  connected: boolean;
  provider: string;
  accountId: string;
  checkedAt: string;
  needsSync?: boolean;
  message?: string | null;
}

interface ConnectionStatusResult {
  accountId: string;
  status: "PENDING" | "SYNCING" | "CONNECTED" | "DISCONNECTED" | "RESTRICTED";
  providerState: string | null;
  providerConnectionStatus: string | null;
  providerReady: boolean;
  lastSyncedAt: string | null;
  message: string;
}

interface BrokerProvider {
  id: string;
  displayName: string;
  platformsSupported: Array<"MT4" | "MT5">;
}

interface BrokerServer {
  id: string;
  serverName: string;
  platform: "MT4" | "MT5";
  source: "MANUAL" | "METAAPI";
}

function isDeploymentPendingMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const value = message.toLowerCase();
  return value.includes("still pending") || value.includes("still deploying") || value.includes("timeout");
}

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

export function BrokerConnectPanel({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const statusPollCount = useRef(0);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    platform: "MT5",
    brokerProviderId: "",
    login: "",
    password: "",
    server: "",
  });
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const { data: credStatus, isLoading } = useQuery<CredentialStatus>({
    queryKey: ["broker-cred-status", accountId],
    queryFn: () => apiFetch(`/api/trading-accounts/${accountId}/broker-credentials`),
    refetchOnWindowFocus: false,
  });

  const providersQuery = useQuery<{ providers: BrokerProvider[]; sourceLabel: string }>({
    queryKey: ["broker-providers", form.platform],
    queryFn: () => apiFetch(`/api/brokers?platform=${form.platform}`),
    enabled: formOpen,
    refetchOnWindowFocus: false,
  });

  const serversQuery = useQuery<{ servers: BrokerServer[]; sourceLabel: string }>({
    queryKey: ["broker-servers", form.brokerProviderId, form.platform],
    queryFn: () =>
      apiFetch(`/api/brokers/${form.brokerProviderId}/servers?platform=${form.platform}`),
    enabled: formOpen && Boolean(form.brokerProviderId),
    refetchOnWindowFocus: false,
  });

  const connectionStatusQuery = useQuery<ConnectionStatusResult>({
    queryKey: ["broker-connection-status", accountId],
    queryFn: async () => {
      statusPollCount.current += 1;
      const result = await apiFetch<ConnectionStatusResult>(`/api/trading-accounts/${accountId}/connection-status`);
      if (result.status === "CONNECTED") {
        void queryClient.invalidateQueries({ queryKey: ["broker-cred-status", accountId] });
        void queryClient.invalidateQueries({ queryKey: ["trading-accounts"] });
      }
      return result;
    },
    enabled: Boolean(
      credStatus?.credentialsStored &&
      (credStatus.status === "PENDING" || credStatus.status === "SYNCING"),
    ),
    refetchInterval: (query) => {
      const status = query.state.data?.status ?? credStatus?.status;
      return statusPollCount.current < 20 && (status === "PENDING" || status === "SYNCING")
        ? 12_000
        : false;
    },
    refetchOnWindowFocus: false,
  });

  const storeMutation = useMutation({
    mutationFn: () =>
      apiFetch<ConnectionResult>(`/api/trading-accounts/${accountId}/broker-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: form.platform,
          login: form.login.trim(),
          password: form.password,
          server: form.server.trim(),
          brokerProviderId: form.brokerProviderId,
        }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["broker-cred-status", accountId] });
      queryClient.invalidateQueries({ queryKey: ["trading-accounts"] });
      setFormOpen(false);
      setForm({ platform: "MT5", brokerProviderId: "", login: "", password: "", server: "" });
      if (data.connected) {
        setNotice({
          type: "success",
          text: `Account connected and synced. ${data.tradesUpserted} trade${data.tradesUpserted === 1 ? "" : "s"} updated.`,
        });
      } else if (data.status === "PENDING" || data.status === "SYNCING") {
        statusPollCount.current = 0;
        setNotice({
          type: "info",
          text: data.message ?? "Credentials stored. The broker connection is still deploying; sync it again shortly.",
        });
      } else {
        setNotice({
          type: "error",
          text: data.message ?? "Credentials were stored, but the broker connection could not be established.",
        });
      }
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  const verifyMutation = useMutation({
    mutationFn: () =>
      apiFetch<VerifyResult>(`/api/trading-accounts/${accountId}/broker-credentials/verify`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      setVerifyResult(data);
      if (data.needsSync) {
        setNotice({ type: "info", text: "Account has not been synced yet. Run Sync Account first." });
      } else if (data.connected) {
        setNotice({ type: "success", text: "Connection verified. MetaAPI is connected to your broker account." });
      } else {
        setNotice({ type: "error", text: data.message ?? "Connection verification failed." });
      }
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: () =>
      apiFetch<SyncResult>(`/api/trading-accounts/${accountId}/sync`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["broker-cred-status", accountId] });
      if (data.status === "PENDING" || data.status === "SYNCING") {
        statusPollCount.current = 0;
        setNotice({
          type: "info",
          text: data.message ?? "MetaAPI is still deploying. Check back in a moment.",
        });
      } else {
        setNotice({
          type: "success",
          text: `Account synced. ${data.tradesUpserted} trades upserted${data.snapshotStored ? ", snapshot captured" : ""}.`,
        });
      }
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  const busy =
    storeMutation.isPending ||
    verifyMutation.isPending ||
    syncMutation.isPending ||
    providersQuery.isFetching ||
    serversQuery.isFetching ||
    connectionStatusQuery.isFetching;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    storeMutation.mutate();
  }

  if (isLoading) {
    return (
      <Panel>
        <div className="h-6 w-48 animate-pulse rounded-[4px] bg-panel" />
      </Panel>
    );
  }

  const displayedStatus = connectionStatusQuery.data?.status ?? credStatus?.status;
  const providerNotice = connectionStatusQuery.data
    ? {
        type: connectionStatusQuery.data.status === "CONNECTED"
          ? ("success" as const)
          : connectionStatusQuery.data.status === "DISCONNECTED"
            ? ("error" as const)
            : ("info" as const),
        text: connectionStatusQuery.data.message,
      }
    : null;
  const displayedNotice = notice ?? providerNotice;
  const statusTone =
    displayedStatus === "CONNECTED"
      ? ("lime" as const)
      : displayedStatus === "SYNCING" || displayedStatus === "PENDING"
        ? ("accent" as const)
        : ("muted" as const);

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
            Broker connection
          </p>
          <h2 className="mt-2 text-lg font-semibold text-foreground">MT4 / MT5 connection</h2>
          <p className="mt-1 text-sm text-muted">
            Store broker credentials and run the initial read-only account sync.
          </p>
          {credStatus?.credentialsStored ? (
            <p className="mt-2 text-xs text-muted">
              {[credStatus.brokerName, credStatus.platform, credStatus.serverName]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {displayedStatus ? (
          <StatusPill tone={statusTone}>{displayedStatus}</StatusPill>
        ) : null}
      </div>

      {/* Status indicators */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Credentials
          </p>
          <div className="mt-1 flex items-center gap-1.5">
            {credStatus?.credentialsStored ? (
              <CheckCircle2 className="h-4 w-4 text-accent-2" />
            ) : (
              <div className="h-4 w-4 rounded-full border-2 border-line" />
            )}
            <span className="text-sm font-semibold text-foreground">
              {credStatus?.credentialsStored ? "Stored" : "Not stored"}
            </span>
          </div>
        </div>
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            MetaAPI account
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {credStatus?.providerAccountId ? "Provisioned" : "Not yet synced"}
          </p>
        </div>
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Last synced
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {credStatus?.lastSyncedAt
              ? new Date(credStatus.lastSyncedAt).toLocaleString()
              : "Never"}
          </p>
        </div>
      </div>

      {/* Sync error */}
      {credStatus?.syncError && !isDeploymentPendingMessage(credStatus.syncError) ? (
        <div className="mt-3 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          <strong>Sync error:</strong> {credStatus.syncError}
        </div>
      ) : null}

      {/* Notice */}
      {displayedNotice ? (
        <div
          className={`mt-3 rounded-[4px] border px-4 py-3 text-sm font-medium ${
            displayedNotice.type === "success"
              ? "border-accent/20 bg-accent/10 text-accent"
              : displayedNotice.type === "error"
                ? "border-danger/20 bg-danger/10 text-danger"
                : "border-line bg-panel text-muted"
          }`}
        >
          {displayedNotice.text}
        </div>
      ) : null}

      {/* Verify result */}
      {verifyResult && !displayedNotice?.type.startsWith("e") ? (
        <div className="mt-3 flex items-center gap-2 rounded-[4px] border border-line bg-background px-4 py-3 text-sm">
          {verifyResult.connected ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-2" />
          ) : (
            <X className="h-4 w-4 shrink-0 text-danger" />
          )}
          <span className="text-muted">
            Checked {new Date(verifyResult.checkedAt).toLocaleTimeString()}
          </span>
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-3">
        <GhostButton type="button" onClick={() => { setFormOpen((o) => !o); setNotice(null); }}>
          {credStatus?.credentialsStored ? "Update connection" : "Add broker connection"}
        </GhostButton>
        {credStatus?.credentialsStored ? (
          <>
            <GhostButton
              type="button"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                statusPollCount.current = 0;
                void connectionStatusQuery.refetch();
              }}
            >
              <RefreshCcw className={`mr-1.5 inline-block h-3.5 w-3.5 ${connectionStatusQuery.isFetching ? "animate-spin" : ""}`} />
              {connectionStatusQuery.isFetching ? "Checking…" : "Check status"}
            </GhostButton>
            <GhostButton
              type="button"
              disabled={busy}
              onClick={() => { setNotice(null); verifyMutation.mutate(); }}
            >
              <ShieldCheck className="mr-1.5 inline-block h-3.5 w-3.5" />
              {verifyMutation.isPending ? "Verifying…" : "Verify connection"}
            </GhostButton>
            <PrimaryButton
              type="button"
              disabled={busy}
              onClick={() => { setNotice(null); syncMutation.mutate(); }}
            >
              <RefreshCcw className={`mr-1.5 inline-block h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
              {syncMutation.isPending ? "Syncing…" : "Sync account"}
            </PrimaryButton>
          </>
        ) : null}
      </div>

      {/* Credential form */}
      {formOpen ? (
        <form onSubmit={handleSubmit} className="mt-5 grid gap-4 border-t border-line pt-5">
          <p className="text-sm text-muted">
            Your password is encrypted (AES-256-GCM) before storage. It is never returned or logged.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Platform
              </label>
              <select
                value={form.platform}
                onChange={(e) => setForm((f) => ({
                  ...f,
                  platform: e.target.value,
                  brokerProviderId: "",
                  server: "",
                }))}
                className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                <option value="MT5">MT5</option>
                <option value="MT4">MT4</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Broker provider <span className="text-danger">*</span>
              </label>
              <select
                required
                value={form.brokerProviderId}
                onChange={(e) => setForm((f) => ({
                  ...f,
                  brokerProviderId: e.target.value,
                  server: "",
                }))}
                className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                <option value="">Select configured broker</option>
                {(providersQuery.data?.providers ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.displayName}</option>
                ))}
              </select>
            </div>
          </div>
          {providersQuery.isSuccess && providersQuery.data.providers.length === 0 ? (
            <div className="rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-muted">
              No broker providers are configured for {form.platform}. Contact support or an administrator.
            </div>
          ) : null}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              Login <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              required
              value={form.login}
              onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))}
              placeholder="MT5 account number"
              maxLength={50}
              className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                Password <span className="text-danger">*</span>
              </label>
              <input
                type="password"
                required
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Main or investor password"
                maxLength={200}
                autoComplete="new-password"
                className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  Server <span className="text-danger">*</span>
                </label>
                <button
                  type="button"
                  disabled={!form.brokerProviderId || serversQuery.isFetching}
                  onClick={() => void serversQuery.refetch()}
                  className="text-xs font-semibold text-accent disabled:opacity-40"
                >
                  {serversQuery.isFetching ? "Refreshing…" : "Refresh configured list"}
                </button>
              </div>
              <select
                required
                disabled={!form.brokerProviderId || serversQuery.isFetching}
                value={form.server}
                onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
                className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-50"
              >
                <option value="">
                  {!form.brokerProviderId ? "Select a broker first" : "Select configured server"}
                </option>
                {(serversQuery.data?.servers ?? []).map((server) => (
                  <option key={server.id} value={server.serverName}>{server.serverName}</option>
                ))}
              </select>
            </div>
          </div>
          {form.brokerProviderId && serversQuery.isSuccess && serversQuery.data.servers.length === 0 ? (
            <div className="rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-muted">
              No servers are configured for this broker and platform. Contact support or an administrator.
            </div>
          ) : null}
          <p className="text-xs text-muted">
            Broker and server options come from the WSA Global admin-configured catalog. They are not presented as live MetaApi discovery.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-xs text-muted">
              Saving new credentials replaces existing ones for this account.
            </p>
            <div className="flex gap-3">
              <GhostButton
                type="button"
                onClick={() => { setFormOpen(false); setNotice(null); }}
              >
                Cancel
              </GhostButton>
              <PrimaryButton
                type="submit"
                disabled={busy || !form.brokerProviderId || !form.server}
              >
                {storeMutation.isPending ? "Connecting…" : "Connect and sync"}
              </PrimaryButton>
            </div>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}
