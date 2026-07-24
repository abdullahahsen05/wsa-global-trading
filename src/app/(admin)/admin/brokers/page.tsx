"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw, WalletCards } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import {
  DataTable,
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField, TextField } from "@/components/app/FormFields";

type Platform = "MT4" | "MT5";

interface Provider {
  id: string;
  displayName: string;
  platformsSupported: Platform[];
  isActive: boolean;
  serverCount: number;
}

interface Server {
  id: string;
  platform: Platform;
  serverName: string;
  source: "MANUAL" | "METAAPI";
  isActive: boolean;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data as T;
}

export default function AdminBrokersPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [providerName, setProviderName] = useState("");
  const [supportsMt4, setSupportsMt4] = useState(false);
  const [supportsMt5, setSupportsMt5] = useState(true);
  const [serverName, setServerName] = useState("");
  const [serverPlatform, setServerPlatform] = useState<Platform>("MT5");
  const [editingServerId, setEditingServerId] = useState("");
  const [editingServerName, setEditingServerName] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const providers = useQuery<{ providers: Provider[]; discoveryAvailable: boolean; sourceLabel: string }>({
    queryKey: ["admin-brokers"],
    queryFn: () => api("/api/admin/brokers"),
  });
  const selected = useMemo(
    () => providers.data?.providers.find((provider) => provider.id === selectedId)
      ?? providers.data?.providers[0]
      ?? null,
    [providers.data, selectedId],
  );
  const effectiveSelectedId = selected?.id ?? "";
  const servers = useQuery<{ servers: Server[] }>({
    queryKey: ["admin-broker-servers", effectiveSelectedId],
    queryFn: () => api(`/api/admin/brokers/${effectiveSelectedId}/servers`),
    enabled: Boolean(effectiveSelectedId),
  });

  const effectiveServerPlatform = selected?.platformsSupported.includes(serverPlatform)
    ? serverPlatform
    : selected?.platformsSupported[0] ?? "MT5";

  const mutate = useMutation({
    mutationFn: (input: { url: string; method: "POST" | "PATCH"; body: Record<string, unknown>; label: string }) =>
      api(input.url, {
        method: input.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.body),
      }),
    onSuccess: async (_data, input) => {
      setNotice({ tone: "success", text: `${input.label} completed.` });
      setProviderName("");
      setServerName("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-brokers"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-broker-servers"] }),
        queryClient.invalidateQueries({ queryKey: ["broker-providers"] }),
        queryClient.invalidateQueries({ queryKey: ["broker-servers"] }),
      ]);
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  function createProvider(event: FormEvent) {
    event.preventDefault();
    const platformsSupported = [
      ...(supportsMt4 ? ["MT4" as const] : []),
      ...(supportsMt5 ? ["MT5" as const] : []),
    ];
    mutate.mutate({
      url: "/api/admin/brokers",
      method: "POST",
      body: { displayName: providerName, platformsSupported },
      label: "Broker provider creation",
    });
  }

  function createServer(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    mutate.mutate({
      url: `/api/admin/brokers/${selected.id}/servers`,
      method: "POST",
      body: { platform: effectiveServerPlatform, serverName },
      label: "Configured server addition",
    });
  }

  function manageProvider(providerId: string) {
    setSelectedId(providerId);
    setEditingServerId("");
    setEditingServerName("");
    setNotice(null);
    window.setTimeout(() => {
      document.getElementById("broker-provider-management")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);
  }

  function editServer(server: Server) {
    setEditingServerId(server.id);
    setEditingServerName(server.serverName);
  }

  function updateServer(event: FormEvent) {
    event.preventDefault();
    if (!editingServerId || !editingServerName.trim()) return;
    mutate.mutate(
      {
        url: `/api/admin/brokers/servers/${editingServerId}`,
        method: "PATCH",
        body: { serverName: editingServerName.trim() },
        label: "Server update",
      },
      {
        onSuccess: () => {
          setEditingServerId("");
          setEditingServerName("");
        },
      },
    );
  }

  return (
    <WorkspacePage
      eyebrow="Admin · Accounts"
      title="Broker catalog"
      description="Manage the broker companies and MetaTrader servers traders can select during account connection."
    >
      <div className="border border-line border-l-2 border-l-accent bg-panel px-4 py-3">
        <div className="flex items-start gap-3">
          <WalletCards className="mt-0.5 h-5 w-5 text-accent" />
          <div>
            <h2 className="font-semibold text-foreground">Admin-configured catalog</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              The installed MetaApi SDK does not provide reliable broker-server discovery. These
              entries are maintained by WSA Global administrators and are never labeled as live-discovered data.
            </p>
          </div>
        </div>
      </div>

      {notice ? (
        <div className={`mt-5 rounded-[4px] border px-4 py-3 text-sm ${
          notice.tone === "success"
            ? "border-accent/20 bg-accent/10 text-accent"
            : "border-danger/20 bg-danger/10 text-danger"
        }`}>
          {notice.text}
        </div>
      ) : null}

      <div className="mt-5 grid items-stretch gap-5 xl:h-[520px] xl:grid-cols-[minmax(0,1.8fr)_minmax(340px,0.7fr)]">
        <Panel className="flex min-h-0 flex-col overflow-hidden xl:h-full">
          <h2 className="shrink-0 text-lg font-semibold text-foreground">Broker providers</h2>
          <p className="mt-1 shrink-0 text-sm text-muted">Select a provider to manage its server list.</p>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 overflow-auto">
            {providers.isLoading ? (
              <p className="text-sm text-muted">Loading broker catalog…</p>
            ) : (providers.data?.providers.length ?? 0) === 0 ? (
              <EmptyState title="No broker providers" description="Create the first provider using the form." />
            ) : (
              <DataTable
                headers={["Provider", "Platforms", "Servers", "Status", ""]}
                rows={(providers.data?.providers ?? []).map((provider) => [
                  <span key="name" className="font-semibold text-foreground">{provider.displayName}</span>,
                  <span key="platforms">{provider.platformsSupported.join(", ")}</span>,
                  <span key="servers">{provider.serverCount}</span>,
                  <StatusPill key="status" tone={provider.isActive ? "lime" : "danger"}>
                    {provider.isActive ? "ACTIVE" : "INACTIVE"}
                  </StatusPill>,
                  <GhostButton
                    key="manage"
                    type="button"
                    aria-pressed={selected?.id === provider.id}
                    onClick={() => manageProvider(provider.id)}
                  >
                    {selected?.id === provider.id ? "Managing" : "Manage"}
                  </GhostButton>,
                ])}
              />
            )}
          </div>
        </Panel>

        <Panel className="flex min-h-0 flex-col overflow-hidden xl:h-full">
          <div className="shrink-0">
            <h2 className="text-lg font-semibold text-foreground">Add broker provider</h2>
            <p className="mt-1 text-sm text-muted">Create a broker company before assigning server options.</p>
          </div>
          <form className="invisible-scrollbar mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" onSubmit={createProvider}>
            <TextField
              label="Display name"
              required
              minLength={2}
              maxLength={100}
              value={providerName}
              onChange={(event) => setProviderName(event.target.value)}
              placeholder="Broker company name"
            />
            <div>
              <p className="text-xs font-medium text-muted">Supported platforms</p>
              <div className="mt-2 flex gap-4">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={supportsMt4} onChange={(event) => setSupportsMt4(event.target.checked)} />
                  MT4
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={supportsMt5} onChange={(event) => setSupportsMt5(event.target.checked)} />
                  MT5
                </label>
              </div>
            </div>
            <PrimaryButton
              type="submit"
              disabled={mutate.isPending || !providerName.trim() || (!supportsMt4 && !supportsMt5)}
              className="mt-auto w-full"
            >
              Create provider
            </PrimaryButton>
          </form>
        </Panel>
      </div>

      {selected ? (
        <div id="broker-provider-management" className="scroll-mt-24">
          <Panel className="mt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Selected provider</p>
              <h2 className="mt-2 text-lg font-semibold text-foreground">{selected.displayName}</h2>
              <p className="mt-1 text-sm text-muted">
                Supported: {selected.platformsSupported.join(", ")}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-3">
              <GhostButton
                type="button"
                disabled={mutate.isPending}
                onClick={() => mutate.mutate({
                  url: `/api/admin/brokers/${selected.id}`,
                  method: "PATCH",
                  body: { isActive: !selected.isActive },
                  label: selected.isActive ? "Provider deactivation" : "Provider activation",
                })}
              >
                {selected.isActive ? "Deactivate provider" : "Activate provider"}
              </GhostButton>
              <GhostButton type="button" onClick={() => void servers.refetch()} disabled={servers.isFetching}>
                <RefreshCcw className={`mr-2 inline-block h-4 w-4 ${servers.isFetching ? "animate-spin" : ""}`} />
                Refresh list
              </GhostButton>
            </div>
          </div>

          <div className="mt-5 grid items-stretch gap-5 lg:h-[500px] lg:grid-cols-[minmax(0,1.8fr)_minmax(340px,0.7fr)]">
            <div className="invisible-scrollbar min-h-0 overflow-auto lg:h-full">
              {(servers.data?.servers.length ?? 0) === 0 ? (
                <EmptyState title="No configured servers" description="Add a server name for this broker and platform." />
              ) : (
                <DataTable
                  headers={["Platform", "Server name", "Source", "Status", ""]}
                  rows={(servers.data?.servers ?? []).map((server) => [
                    <span key="platform">{server.platform}</span>,
                    <span key="name" className="font-mono text-xs text-foreground">{server.serverName}</span>,
                    <span key="source">{server.source}</span>,
                    <StatusPill key="status" tone={server.isActive ? "lime" : "danger"}>
                      {server.isActive ? "ACTIVE" : "INACTIVE"}
                    </StatusPill>,
                    <div key="actions" className="flex flex-wrap justify-end gap-3">
                      <GhostButton
                        type="button"
                        onClick={() => editServer(server)}
                      >
                        Edit
                      </GhostButton>
                      <GhostButton
                        type="button"
                        disabled={mutate.isPending}
                        onClick={() => mutate.mutate({
                          url: `/api/admin/brokers/servers/${server.id}`,
                          method: "PATCH",
                          body: { isActive: !server.isActive },
                          label: server.isActive ? "Server deactivation" : "Server activation",
                        })}
                      >
                        {server.isActive ? "Deactivate" : "Activate"}
                      </GhostButton>
                    </div>,
                  ])}
                />
              )}
            </div>
            {editingServerId ? (
              <form onSubmit={updateServer} className="invisible-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto rounded-[4px] border border-accent/30 bg-background p-4 lg:h-full">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Editing server</p>
                  <h3 className="mt-1 font-semibold text-foreground">
                    {servers.data?.servers.find((server) => server.id === editingServerId)?.platform ?? "MetaTrader"} server
                  </h3>
                </div>
                <TextField
                  label="Exact MetaTrader server name"
                  required
                  minLength={2}
                  maxLength={100}
                  value={editingServerName}
                  onChange={(event) => setEditingServerName(event.target.value)}
                  hint="Changing this updates the option shown to traders."
                />
                <div className="mt-auto flex flex-wrap gap-3 border-t border-line pt-4">
                  <PrimaryButton type="submit" disabled={mutate.isPending || editingServerName.trim().length < 2}>
                    Save server
                  </PrimaryButton>
                  <GhostButton
                    type="button"
                    disabled={mutate.isPending}
                    onClick={() => {
                      setEditingServerId("");
                      setEditingServerName("");
                    }}
                  >
                    Cancel
                  </GhostButton>
                </div>
              </form>
            ) : (
              <form onSubmit={createServer} className="invisible-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto rounded-[4px] border border-line bg-background p-4 lg:h-full">
                <h3 className="font-semibold text-foreground">Add configured server</h3>
                <SelectField
                  label="Platform"
                  value={effectiveServerPlatform}
                  onChange={(event) => setServerPlatform(event.target.value as Platform)}
                >
                  {selected.platformsSupported.map((platform) => (
                    <option key={platform} value={platform}>{platform}</option>
                  ))}
                </SelectField>
                <TextField
                  label="Exact MetaTrader server name"
                  required
                  minLength={2}
                  maxLength={100}
                  value={serverName}
                  onChange={(event) => setServerName(event.target.value)}
                  placeholder="Broker-Server-Name"
                  hint="Enter the exact server string expected by MetaApi."
                />
                <PrimaryButton type="submit" disabled={mutate.isPending || !serverName.trim()} className="mt-auto w-full">
                  Add server
                </PrimaryButton>
              </form>
            )}
          </div>
          </Panel>
        </div>
      ) : null}
    </WorkspacePage>
  );
}
