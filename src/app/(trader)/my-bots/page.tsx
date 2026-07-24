"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Download, X } from "lucide-react";
import {
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import type { BotAccessRecordDto, BotLicenseDto } from "@/lib/domain/types";

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

const STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  ACTIVE: "lime",
  REQUESTED: "accent",
  SUSPENDED: "danger",
  REVOKED: "danger",
  EXPIRED: "muted",
};

export default function MyBotsPage() {
  const queryClient = useQueryClient();
  const [licenseDialog, setLicenseDialog] = useState<{
    accessId: string;
    productName: string;
  } | null>(null);
  const [licenseForm, setLicenseForm] = useState({ mt5AccountNumber: "", platform: "MT5" });
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: accessRecords = [], isLoading } = useQuery<BotAccessRecordDto[]>({
    queryKey: ["my-bots"],
    queryFn: () => apiFetch("/api/my-bots"),
  });

  const { data: licenses = [] } = useQuery<BotLicenseDto[]>({
    queryKey: ["my-bot-licenses"],
    queryFn: () => apiFetch("/api/my-bots/licenses"),
  });

  const issueMutation = useMutation({
    mutationFn: (accessId: string) =>
      apiFetch<BotLicenseDto>(`/api/my-bots/${accessId}/licenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mt5AccountNumber: licenseForm.mt5AccountNumber.trim(),
          platform: licenseForm.platform,
        }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["my-bot-licenses"] });
      setLicenseDialog(null);
      setLicenseForm({ mt5AccountNumber: "", platform: "MT5" });
      setShownKey(data.licenseKeyPlaintext ?? null);
      setNotice({ type: "success", text: "License issued. Copy the key below — it will not be shown again." });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  const downloadMutation = useMutation({
    mutationFn: (accessId: string) =>
      apiFetch<{ downloadUrl: string }>(`/api/my-bots/${accessId}/download`),
    onSuccess: (data) => {
      window.location.assign(data.downloadUrl);
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  function handleIssueSubmit(e: FormEvent) {
    e.preventDefault();
    if (!licenseDialog) return;
    setNotice(null);
    issueMutation.mutate(licenseDialog.accessId);
  }

  function copyKey() {
    if (!shownKey) return;
    navigator.clipboard.writeText(shownKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const licensesByAccess = new Map<string, BotLicenseDto[]>();
  for (const l of licenses) {
    const arr = licensesByAccess.get(l.accessRecordId) ?? [];
    arr.push(l);
    licensesByAccess.set(l.accessRecordId, arr);
  }

  return (
    <WorkspacePage
      eyebrow="My Bots"
      title="Bot Licenses"
      description="Manage your bot access and license keys"
    >
      {/* One-time key display */}
      {shownKey ? (
        <div className="rounded-[4px] border border-accent/30 bg-accent/5 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            License key — shown once
          </p>
          <p className="mt-2 break-all font-mono text-lg font-bold text-foreground">
            {shownKey}
          </p>
          <div className="mt-3 flex gap-3">
            <GhostButton type="button" onClick={copyKey}>
              <Copy className="mr-1.5 inline-block h-3.5 w-3.5" />
              {copied ? "Copied!" : "Copy key"}
            </GhostButton>
            <GhostButton type="button" onClick={() => setShownKey(null)}>
              Dismiss
            </GhostButton>
          </div>
        </div>
      ) : null}

      {/* Notice */}
      {notice ? (
        <div
          className={`rounded-[4px] border px-4 py-3 text-sm font-medium ${
            notice.type === "success"
              ? "border-accent/20 bg-accent/10 text-accent"
              : "border-danger/20 bg-danger/10 text-danger"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {isLoading ? (
        <div className="h-32 animate-pulse rounded-[4px] bg-panel" />
      ) : accessRecords.length === 0 ? (
        <EmptyState
          title="No bot access yet"
          description="Browse the marketplace and request access to a trading bot."
          action={
            <Link href="/marketplace">
              <PrimaryButton type="button">Browse Marketplace</PrimaryButton>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4">
          {accessRecords.map((record) => {
            const recordLicenses = licensesByAccess.get(record.id) ?? [];
            const activeLicense = recordLicenses.find((l) => l.status === "ACTIVE");
            return (
              <Panel key={record.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link
                      href={`/marketplace/${record.productSlug}`}
                      className="text-base font-semibold text-foreground hover:text-accent"
                    >
                      {record.productName}
                    </Link>
                    <p className="text-xs text-muted">
                      Requested {new Date(record.createdAt).toLocaleDateString()}
                      {record.grantedAt
                        ? ` · Granted ${new Date(record.grantedAt).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <StatusPill tone={STATUS_TONE[record.status] ?? "muted"}>
                    {record.status}
                  </StatusPill>
                </div>

                {record.status === "ACTIVE" ? (
                  <div className="mt-4 border-t border-line pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                          Bot file
                        </p>
                        {record.hasPublishedRelease ? (
                          <p className="mt-0.5 text-sm text-foreground">
                            {record.releaseFileName}
                            {record.releaseVersion ? ` · v${record.releaseVersion}` : ""}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-sm text-muted">
                            The admin has not published a downloadable file yet.
                          </p>
                        )}
                      </div>
                      {record.hasPublishedRelease ? (
                        <GhostButton
                          type="button"
                          disabled={downloadMutation.isPending}
                          onClick={() => {
                            setNotice(null);
                            downloadMutation.mutate(record.id);
                          }}
                        >
                          <Download className="mr-1.5 inline-block h-3.5 w-3.5" />
                          {downloadMutation.isPending ? "Preparing..." : "Download bot"}
                        </GhostButton>
                      ) : null}
                    </div>

                    <div className="mt-4 border-t border-line pt-4">
                      {activeLicense ? (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                            License
                          </p>
                          <p className="mt-0.5 font-mono text-sm text-foreground">
                            ••••-••••-••••-••••-{activeLicense.licenseKeyLast4}
                          </p>
                          <p className="text-xs text-muted">
                            MT5: {activeLicense.mt5AccountNumber} · {activeLicense.platform}
                            {activeLicense.expiresAt
                              ? ` · Expires ${new Date(activeLicense.expiresAt).toLocaleDateString()}`
                              : ""}
                          </p>
                        </div>
                        <StatusPill tone={activeLicense.status === "ACTIVE" ? "lime" : "danger"}>
                          {activeLicense.status}
                        </StatusPill>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-muted">
                          No license issued yet. Generate one to activate your bot.
                        </p>
                        <GhostButton
                          type="button"
                          onClick={() =>
                            setLicenseDialog({ accessId: record.id, productName: record.productName })
                          }
                        >
                          Generate license
                        </GhostButton>
                      </div>
                      )}
                    </div>
                  </div>
                ) : record.status === "REQUESTED" ? (
                  <p className="mt-3 text-sm text-muted">
                    Payment confirmed. Your bot access is being activated automatically.
                  </p>
                ) : null}
              </Panel>
            );
          })}
        </div>
      )}

      {/* Generate license dialog */}
      <Dialog.Root
        open={!!licenseDialog}
        onOpenChange={(o) => { if (!o) setLicenseDialog(null); }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-background p-6">
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-base font-semibold text-foreground">
                Generate License
              </Dialog.Title>
              <Dialog.Close asChild>
                <button className="rounded-[4px] p-1 text-muted hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
            {licenseDialog ? (
              <form onSubmit={handleIssueSubmit} className="mt-4 grid gap-4">
                <p className="text-sm text-muted">
                  Generating a license for <strong>{licenseDialog.productName}</strong>. This key
                  is locked to your MT5 account number. It will be shown once.
                </p>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    MT5 Account Number <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={50}
                    value={licenseForm.mt5AccountNumber}
                    onChange={(e) =>
                      setLicenseForm((f) => ({ ...f, mt5AccountNumber: e.target.value }))
                    }
                    placeholder="Your MT5 account number"
                    className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    Platform
                  </label>
                  <select
                    value={licenseForm.platform}
                    onChange={(e) => setLicenseForm((f) => ({ ...f, platform: e.target.value }))}
                    className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                  >
                    <option value="MT5">MT5</option>
                    <option value="MT4">MT4</option>
                  </select>
                </div>
                <div className="flex justify-end gap-3">
                  <Dialog.Close asChild>
                    <GhostButton type="button">Cancel</GhostButton>
                  </Dialog.Close>
                  <PrimaryButton type="submit" disabled={issueMutation.isPending}>
                    {issueMutation.isPending ? "Generating…" : "Generate License"}
                  </PrimaryButton>
                </div>
              </form>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}
