"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  WorkspacePage,
  Panel,
  StatTile,
  PrimaryButton,
  GhostButton,
} from "@/components/app/WorkspaceUI";

interface TerminalStatusData {
  settings: {
    provider: string;
    is_enabled: boolean;
    demo_mode: boolean;
    notes: string | null;
    updated_at: string | null;
  };
  providerStatus: {
    provider: string;
    mode: string;
    connected: boolean;
    label: string;
    error?: string;
  };
  envChecks: Record<string, boolean>;
  dxfeedReady: boolean;
  dxfeedReadyCount: number;
}

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

function CheckRow({ label, ok, note }: { label: string; ok: boolean; note?: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span
        className={`mt-0.5 shrink-0 text-sm font-bold ${ok ? "text-green-400" : "text-muted-foreground"}`}
      >
        {ok ? "✓" : "○"}
      </span>
      <div>
        <span className={`text-sm ${ok ? "text-foreground" : "text-muted-foreground"}`}>
          {label}
        </span>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}

export default function AdminTerminalPage() {
  const qc = useQueryClient();
  const [healthResult, setHealthResult] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<TerminalStatusData>({
    queryKey: ["admin-terminal-status"],
    queryFn: () => apiFetch("/api/admin/terminal/status"),
    refetchInterval: 30_000,
  });

  const healthMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ connected: boolean; label: string; error?: string }>(
        "/api/admin/terminal/health-check",
        { method: "POST" }
      ),
    onSuccess: (data) => {
      setHealthResult(
        data.connected
          ? `Connected — ${data.label}`
          : `Not connected — ${data.error ?? "Unknown error"}`
      );
      qc.invalidateQueries({ queryKey: ["admin-terminal-status"] });
    },
    onError: (err) => {
      setHealthResult((err as Error).message);
    },
  });

  const switchMutation = useMutation({
    mutationFn: (provider: string) =>
      apiFetch("/api/admin/terminal/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      }),
    onSuccess: () => {
      setSettingsError(null);
      qc.invalidateQueries({ queryKey: ["admin-terminal-status"] });
    },
    onError: (err) => setSettingsError((err as Error).message),
  });

  const env = status?.envChecks ?? {};
  const s = status?.settings;
  const ps = status?.providerStatus;

  return (
    <WorkspacePage
      eyebrow="Terminal"
      title="Market Data Terminal"
      description="Provider configuration, environment readiness, and integration notes for the institutional data terminal"
    >
      {isLoading && (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      )}

      {/* Professional Tier locked status — always visible */}
      <div className="mb-6 rounded-[4px] border border-zinc-700 bg-zinc-900/60 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
              Professional Tier
            </p>
            <h3 className="mt-1 text-base font-bold text-zinc-100">
              🔒 Professional Live Market Data — Locked
            </h3>
            <p className="mt-1.5 max-w-xl text-sm text-zinc-400">
              dxFeed / Devexperts integration is built and ready. Live professional market data
              will be unlocked once a data redistribution agreement is signed and API credentials
              are configured below.
            </p>
          </div>
          <span className="shrink-0 rounded-[4px] border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-semibold text-zinc-400">
            Pending Agreement
          </span>
        </div>
        <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-3">
          {[
            { label: "Data Agreement", status: "Required", ok: false },
            { label: "dxFeed API Credentials", status: "Not configured", ok: false },
            { label: "Demo Fallback", status: "Active", ok: true },
          ].map(({ label, status: st, ok }) => (
            <div key={label} className="px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
              <p className={`mt-0.5 text-xs font-semibold ${ok ? "text-green-400" : "text-zinc-400"}`}>{st}</p>
            </div>
          ))}
        </div>
      </div>

      {status && (
        <div className="space-y-6">
          {/* Stat overview */}
          <div className="definition-grid grid grid-cols-2 gap-0 sm:grid-cols-4">
            <StatTile
              label="Active Provider"
              value={s?.provider?.toUpperCase() ?? "—"}
            />
            <StatTile
              label="Mode"
              value={ps?.connected ? (ps.mode === "live" ? "Live" : "Demo") : "Offline"}
            />
            <StatTile label="Provider Status" value={ps?.label ?? "—"} />
            <StatTile
              label="dxFeed Env Vars"
              value={`${status.dxfeedReadyCount} / 3`}
            />
          </div>

          {/* Provider switcher */}
          <Panel>
            <h3 className="mb-3 text-sm font-semibold">Provider Selection</h3>
            <div className="flex gap-3">
              <PrimaryButton
                onClick={() => switchMutation.mutate("mock")}
                disabled={switchMutation.isPending || s?.provider === "mock"}
              >
                {s?.provider === "mock" ? "Mock (active)" : "Switch to Mock"}
              </PrimaryButton>
              <GhostButton
                onClick={() => switchMutation.mutate("dxfeed")}
                disabled={switchMutation.isPending || s?.provider === "dxfeed" || !status.dxfeedReady}
                title={!status.dxfeedReady ? "Configure all 3 dxFeed env vars first" : undefined}
              >
                {s?.provider === "dxfeed" ? "dxFeed (active)" : "Switch to dxFeed"}
              </GhostButton>

              <GhostButton
                onClick={() => healthMutation.mutate()}
                disabled={healthMutation.isPending}
              >
                {healthMutation.isPending ? "Checking…" : "Run Health Check"}
              </GhostButton>
            </div>

            {healthResult && (
              <p
                className={`mt-3 text-sm ${
                  healthResult.startsWith("Connected") ? "text-green-400" : "text-danger"
                }`}
              >
                {healthResult}
              </p>
            )}
            {settingsError && (
              <p className="mt-3 text-sm text-danger">{settingsError}</p>
            )}
            {ps?.error && (
              <p className="mt-3 text-xs text-muted-foreground">Last error: {ps.error}</p>
            )}
          </Panel>

          {/* Environment variable checklist */}
          <Panel>
            <h3 className="mb-1 text-sm font-semibold">Environment Variable Checklist</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Values are never shown here — only whether each variable is set.
              Configure in your deployment environment (e.g. Vercel Project Settings).
            </p>

            <div className="divide-y divide-border">
              <CheckRow
                label="MARKET_DATA_PROVIDER"
                ok={env["MARKET_DATA_PROVIDER"]}
                note='Set to "mock" (default) or "dxfeed". Unset defaults to mock.'
              />
              <CheckRow
                label="DXFEED_API_BASE_URL"
                ok={env["DXFEED_API_BASE_URL"]}
                note="Base URL for the dxFeed REST API. Required for dxFeed provider."
              />
              <CheckRow
                label="DXFEED_API_KEY"
                ok={env["DXFEED_API_KEY"]}
                note="Server-side secret API key. Never exposed to the browser."
              />
              <CheckRow
                label="DXFEED_ACCOUNT_ID"
                ok={env["DXFEED_ACCOUNT_ID"]}
                note="dxFeed account identifier. Required for authenticated endpoints."
              />
              <CheckRow
                label="DXFEED_WIDGET_CDN_URL"
                ok={env["DXFEED_WIDGET_CDN_URL"]}
                note="Optional. CDN URL for dxFeed widget JS bundles (Phase 8.5+)."
              />
              <CheckRow
                label="DXFEED_ENVIRONMENT"
                ok={env["DXFEED_ENVIRONMENT"]}
                note='Optional. "demo" or "live". Defaults to demo if unset.'
              />
            </div>
          </Panel>

          {/* Data rights + integration notes */}
          <Panel>
            <h3 className="mb-1 text-sm font-semibold">Integration Notes</h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">Data rights:</strong> Displaying real-time
                exchange data to end users requires a valid market data redistribution agreement.
                Contact dxFeed / Devexperts to establish data rights before enabling the live
                provider.
              </p>
              <p>
                <strong className="text-foreground">API contract:</strong> The dxFeed provider
                skeleton in{" "}
                <code className="rounded bg-border px-1 text-xs">
                  src/lib/terminal/providers/dxfeedMarketDataProvider.ts
                </code>{" "}
                contains TODO markers for each endpoint. Implement these once the official API
                documentation is received from dxFeed / Devexperts.
              </p>
              <p>
                <strong className="text-foreground">Safe fallback:</strong> While the dxFeed
                provider is not configured, all terminal API endpoints automatically use the mock
                provider and clearly label data as &quot;Demo Market Data&quot;. No live data is ever
                displayed unless the provider reports{" "}
                <code className="rounded bg-border px-1 text-xs">connected: true</code>.
              </p>
              <p>
                <strong className="text-foreground">Next steps:</strong> Obtain dxFeed credentials
                and API docs → set env vars → run health check → implement TODO endpoints →
                switch provider to &quot;dxfeed&quot; here.
              </p>
            </div>
          </Panel>

          {/* Settings metadata */}
          {s?.updated_at && (
            <p className="text-right text-xs text-muted-foreground">
              Last updated: {new Date(s.updated_at).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </WorkspacePage>
  );
}
