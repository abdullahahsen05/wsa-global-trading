"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Loader2, ShieldCheck, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
} from "@/components/app/WorkspaceUI";
import { TextField } from "@/components/app/FormFields";

type Provider = "GEMINI" | "OPENAI";

interface ProviderSetting {
  provider: Provider;
  configured: boolean;
  isActive: boolean;
  apiKeyHint: string | null;
  status: "NOT_CONFIGURED" | "VALID" | "INVALID";
  lastValidatedAt: string | null;
  lastError: string | null;
  environmentFallbackAvailable: boolean;
}

interface ProviderSettingsResponse {
  providers: ProviderSetting[];
  resolvedProvider: Provider | null;
  resolvedSource: "DATABASE" | "ENVIRONMENT" | null;
  canManageSecrets: boolean;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data as T;
}

function providerName(provider: Provider): string {
  return provider === "GEMINI" ? "Gemini" : "OpenAI";
}

export function AiProviderSettingsPanel() {
  const queryClient = useQueryClient();
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const settings = useQuery<ProviderSettingsResponse>({
    queryKey: ["admin-ai-providers"],
    queryFn: () => api("/api/admin/ai/providers"),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-ai-providers"] });

  const save = useMutation({
    mutationFn: (input: { provider: Provider; apiKey: string }) =>
      api("/api/admin/ai/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      setEditingProvider(null);
      setApiKey("");
      setNotice({ tone: "success", text: "Key saved encrypted. Test it before activation." });
      await refresh();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const action = useMutation({
    mutationFn: (input: { provider: Provider; action: "test" | "activate" | "delete" }) =>
      api(
        input.action === "delete"
          ? `/api/admin/ai/providers/${input.provider}`
          : `/api/admin/ai/providers/${input.provider}/${input.action}`,
        { method: input.action === "delete" ? "DELETE" : "POST" },
      ),
    onSuccess: async (_data, input) => {
      setNotice({
        tone: "success",
        text: input.action === "test"
          ? "Provider validation completed. Review its status below."
          : input.action === "activate"
            ? `${providerName(input.provider)} is now the active database provider.`
            : `${providerName(input.provider)} key deleted.`,
      });
      await refresh();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const data = settings.data;
  const busy = save.isPending || action.isPending;

  return (
    <>
      <Panel className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
              Provider security
            </p>
            <h2 className="mt-2 text-lg font-semibold text-foreground">AI provider keys</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
              Keys are encrypted server-side and are never returned after saving. A tested, active
              database key takes priority over environment fallback configuration.
            </p>
          </div>
          <StatusPill tone={data?.resolvedProvider ? "lime" : "danger"}>
            {data?.resolvedProvider
              ? `${providerName(data.resolvedProvider)} · ${data.resolvedSource}`
              : "AI UNAVAILABLE"}
          </StatusPill>
        </div>

        {notice ? (
          <div className={`mt-4 rounded-[4px] border px-4 py-3 text-sm ${
            notice.tone === "success"
              ? "border-accent/20 bg-accent/10 text-accent"
              : "border-danger/20 bg-danger/10 text-danger"
          }`}>
            {notice.text}
          </div>
        ) : null}

        {settings.isError ? (
          <div className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Provider settings could not be loaded. Apply migration 037 before using database-managed keys.
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {(data?.providers ?? []).map((provider) => (
              <div key={provider.provider} className="flex h-full flex-col rounded-[4px] border border-line bg-background p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Key className="h-4 w-4 text-accent" />
                      <h3 className="font-semibold text-foreground">{providerName(provider.provider)}</h3>
                    </div>
                    <p className="mt-2 font-mono text-xs text-muted">
                      {provider.apiKeyHint ?? (provider.environmentFallbackAvailable
                        ? "Environment fallback configured"
                        : "No database key saved")}
                    </p>
                  </div>
                  <StatusPill tone={provider.status === "VALID" ? "lime" : provider.status === "INVALID" ? "danger" : undefined}>
                    {provider.isActive ? "ACTIVE" : provider.status.replaceAll("_", " ")}
                  </StatusPill>
                </div>

                <div className="mt-4 grid gap-2 text-xs text-muted sm:grid-cols-2">
                  <p>
                    Last validated:{" "}
                    <span className="text-foreground">
                      {provider.lastValidatedAt
                        ? new Date(provider.lastValidatedAt).toLocaleString()
                        : "Never"}
                    </span>
                  </p>
                  <p>
                    Env fallback:{" "}
                    <span className="text-foreground">
                      {provider.environmentFallbackAvailable ? "Available" : "Not configured"}
                    </span>
                  </p>
                </div>
                {provider.lastError ? (
                  <p className="mt-3 rounded-[4px] border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {provider.lastError}
                  </p>
                ) : null}

                <div className="mt-auto flex flex-wrap gap-3 border-t border-line pt-4">
                  <PrimaryButton
                    type="button"
                    disabled={!data?.canManageSecrets || busy}
                    onClick={() => {
                      setApiKey("");
                      setEditingProvider(provider.provider);
                    }}
                  >
                    {provider.configured ? "Rotate key" : "Add key"}
                  </PrimaryButton>
                  <GhostButton
                    type="button"
                    disabled={!data?.canManageSecrets || !provider.configured || busy}
                    onClick={() => action.mutate({ provider: provider.provider, action: "test" })}
                  >
                    <ShieldCheck className="mr-2 inline-block h-4 w-4" />
                    Test
                  </GhostButton>
                  <GhostButton
                    type="button"
                    disabled={!data?.canManageSecrets || provider.status !== "VALID" || provider.isActive || busy}
                    onClick={() => action.mutate({ provider: provider.provider, action: "activate" })}
                  >
                    Activate
                  </GhostButton>
                  <GhostButton
                    type="button"
                    disabled={!data?.canManageSecrets || !provider.configured || busy}
                    onClick={() => action.mutate({ provider: provider.provider, action: "delete" })}
                  >
                    <Trash2 className="mr-2 inline-block h-4 w-4" />
                    Delete
                  </GhostButton>
                </div>
              </div>
            ))}
          </div>
        )}

        {data && !data.canManageSecrets ? (
          <p className="mt-4 text-xs text-muted">
            Admins can view provider status. Only Super Admins can save, test, activate, rotate, or delete keys.
          </p>
        ) : null}
      </Panel>

      <Dialog.Root
        open={Boolean(editingProvider)}
        onOpenChange={(open) => {
          if (!open && !save.isPending) {
            setEditingProvider(null);
            setApiKey("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="text-xl font-semibold text-foreground">
              {editingProvider ? `${providerName(editingProvider)} API key` : "AI provider key"}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              Paste the new key once. It will be encrypted immediately and cannot be viewed later.
            </Dialog.Description>
            <div className="mt-5">
              <TextField
                label="API key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste provider key"
              />
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-3 border-t border-line pt-4">
              <Dialog.Close asChild>
                <GhostButton type="button" disabled={save.isPending}>Cancel</GhostButton>
              </Dialog.Close>
              <PrimaryButton
                type="button"
                disabled={!editingProvider || apiKey.trim().length < 12 || save.isPending}
                onClick={() => {
                  if (editingProvider) save.mutate({ provider: editingProvider, apiKey });
                }}
              >
                {save.isPending ? <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" /> : null}
                {save.isPending ? "Encrypting…" : "Save encrypted key"}
              </PrimaryButton>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                disabled={save.isPending}
                className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
