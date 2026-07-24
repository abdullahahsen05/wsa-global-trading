"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, X } from "lucide-react";
import { GhostButton, PrimaryButton } from "@/components/app/WorkspaceUI";

type Platform = "MT4" | "MT5";
type BrokerProvider = { id: string; displayName: string; platformsSupported: Platform[] };
type BrokerServer = { id: string; serverName: string; platform: Platform };

const CUSTOM = "__custom__";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data;
}

export function MasterAccountConnectDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose(): void;
  onConnected(message: string): void;
}) {
  const [platform, setPlatform] = useState<Platform>("MT5");
  const [providerId, setProviderId] = useState("");
  const [serverSelection, setServerSelection] = useState("");
  const [manualBroker, setManualBroker] = useState("");
  const [customServer, setCustomServer] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const providers = useQuery<{ providers: BrokerProvider[] }>({
    queryKey: ["broker-providers", "copy-master-connect", platform],
    queryFn: () => api(`/api/brokers?platform=${platform}`),
    enabled: open,
  });
  const servers = useQuery<{ servers: BrokerServer[] }>({
    queryKey: ["broker-servers", "copy-master-connect", providerId, platform],
    queryFn: () => api(`/api/brokers/${providerId}/servers?platform=${platform}`),
    enabled: open && Boolean(providerId && providerId !== CUSTOM),
  });

  function reset() {
    setPlatform("MT5");
    setProviderId("");
    setServerSelection("");
    setManualBroker("");
    setCustomServer("");
    setAccountLabel("");
    setLogin("");
    setPassword("");
    setCreatedAccountId(null);
    setSubmitting(false);
    setError("");
  }

  function close() {
    reset();
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const provider = providers.data?.providers.find((item) => item.id === providerId);
    const brokerName = providerId === CUSTOM ? manualBroker.trim() : provider?.displayName ?? "";
    const useCustomServer = providerId === CUSTOM || serverSelection === CUSTOM;
    const server = useCustomServer ? customServer.trim() : serverSelection;
    if (!accountLabel.trim() || !brokerName || !login.trim() || !password || !server) {
      setError("Account label, broker, server, login, and password are required.");
      return;
    }

    setSubmitting(true);
    let accountId = createdAccountId;
    try {
      if (!accountId) {
        const created = await api<{ accountId: string }>("/api/admin/copy/master-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountName: accountLabel.trim(), brokerName, currency: "USD" }),
        });
        accountId = created.accountId;
        setCreatedAccountId(accountId);
      }

      const connection = await api<{ connected: boolean; status: string; message?: string; tradesUpserted?: number }>(
        `/api/trading-accounts/${accountId}/broker-credentials`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform,
            login: login.trim(),
            password,
            server,
            brokerProviderId: providerId === CUSTOM ? undefined : providerId,
            brokerName,
            useCustomBrokerServer: useCustomServer,
            connectNow: true,
          }),
        },
      );

      setPassword("");
      if (connection.connected) {
        onConnected(`Master account connected and synchronized. ${connection.tradesUpserted ?? 0} trade(s) updated.`);
      } else if (connection.status === "PENDING" || connection.status === "SYNCING") {
        onConnected(connection.message ?? "Master credentials were stored securely. MetaApi is deploying the connection; use Check status on the account card shortly.");
      } else {
        setError(connection.message ?? "Credentials were stored, but the broker connection did not complete. Check the values and try again.");
        return;
      }
      reset();
    } catch (submitError) {
      setPassword("");
      setError(
        submitError instanceof Error
          ? submitError.message
          : accountId
            ? "The master account was created, but its broker connection failed. Correct the credentials and retry."
            : "The master account could not be connected.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const providerOptions = providers.data?.providers ?? [];
  const serverOptions = servers.data?.servers ?? [];
  const customBroker = providerId === CUSTOM;
  const customServerSelected = customBroker || serverSelection === CUSTOM;

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[94vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 invisible-scrollbar overflow-y-auto rounded-[6px] border border-line bg-panel p-6 shadow-[0_24px_80px_rgba(0,0,0,0.62)] focus:outline-none">
          <Dialog.Title className="text-2xl font-semibold text-foreground">Connect a master trading account</Dialog.Title>
          <Dialog.Description className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Add the MT4 or MT5 account that will generate the live strategy trades. Credentials are encrypted and never returned.
          </Dialog.Description>

          <form onSubmit={submit} className="mt-6 space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Account label" value={accountLabel} onChange={setAccountLabel} placeholder="e.g. Gold Master" disabled={Boolean(createdAccountId)} />
              <label className="space-y-2 text-sm font-semibold text-foreground">Platform<select value={platform} disabled={Boolean(createdAccountId)} onChange={(event) => { setPlatform(event.target.value as Platform); setProviderId(""); setServerSelection(""); }} className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm"><option value="MT5">MetaTrader 5</option><option value="MT4">MetaTrader 4</option></select></label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-semibold text-foreground">Broker<select required value={providerId} disabled={Boolean(createdAccountId) || providers.isFetching} onChange={(event) => { setProviderId(event.target.value); setServerSelection(""); }} className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm"><option value="">Select broker...</option>{providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}<option value={CUSTOM}>Enter another broker</option></select></label>
              {customBroker ? <Field label="Broker name" value={manualBroker} onChange={setManualBroker} placeholder="Broker name" disabled={Boolean(createdAccountId)} /> : <label className="space-y-2 text-sm font-semibold text-foreground">Server<select required value={serverSelection} onChange={(event) => setServerSelection(event.target.value)} disabled={!providerId || servers.isFetching} className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm"><option value="">Select server...</option>{serverOptions.map((server) => <option key={server.id} value={server.serverName}>{server.serverName}</option>)}<option value={CUSTOM}>Enter another server</option></select></label>}
            </div>

            {customServerSelected ? <Field label="Broker server" value={customServer} onChange={setCustomServer} placeholder="Exact MT4/MT5 server name" /> : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`${platform} login`} value={login} onChange={setLogin} placeholder="Trading account number" autoComplete="username" />
              <Field label="Trading password" type="password" value={password} onChange={setPassword} placeholder="Main or investor password" autoComplete="new-password" />
            </div>

            {createdAccountId ? <div className="rounded-[4px] border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-accent">The master record is saved. Correct the connection details and retry without creating another account.</div> : null}
            {error ? <div className="rounded-[4px] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
              <div className="flex items-center gap-2 text-xs text-muted"><ShieldCheck className="h-4 w-4 text-accent" />Encrypted credential storage and honest provider status.</div>
              <div className="flex gap-2"><GhostButton type="button" onClick={close}>Cancel</GhostButton><PrimaryButton type="submit" disabled={submitting || providers.isFetching || servers.isFetching}>{submitting ? "Connecting..." : createdAccountId ? "Retry connection" : "Connect master account"}</PrimaryButton></div>
            </div>
          </form>

          <Dialog.Close className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted hover:text-foreground"><X className="h-4 w-4" /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", disabled = false, autoComplete }: { label: string; value: string; onChange(value: string): void; placeholder: string; type?: string; disabled?: boolean; autoComplete?: string }) {
  return <label className="space-y-2 text-sm font-semibold text-foreground">{label}<input required type={type} value={value} disabled={disabled} autoComplete={autoComplete} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm outline-none placeholder:text-muted/50 focus:border-accent disabled:opacity-60" /></label>;
}
