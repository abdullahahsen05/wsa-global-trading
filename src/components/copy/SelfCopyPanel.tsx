"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Repeat, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { SelectField, TextField } from "@/components/app/FormFields";
import {
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
} from "@/components/app/WorkspaceUI";
import type { TraderAccountSummary } from "@/lib/domain/types";

interface SelfCopyRelationship {
  id: string;
  sourceAccountName: string;
  sourceStatus: string;
  followerAccountName: string;
  followerStatus: string;
  status: "LIVE" | "PAUSED";
  copySettings: {
    copyMode: "BALANCE_RATIO" | "LOT_MULTIPLIER" | "FIXED_LOT";
    maxLot: number | null;
    maxDrawdownPercent: number | null;
    reverseCopy: boolean;
  };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data as T;
}

export function SelfCopyPanel({ accounts }: { accounts: TraderAccountSummary[] }) {
  const queryClient = useQueryClient();
  const eligibleAccounts = accounts.filter((account) => account.status === "CONNECTED" || account.status === "SYNCING");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [followerAccountId, setFollowerAccountId] = useState("");
  const [copyMode, setCopyMode] = useState<"BALANCE_RATIO" | "LOT_MULTIPLIER" | "FIXED_LOT">("BALANCE_RATIO");
  const [fixedLot, setFixedLot] = useState("");
  const [lotMultiplier, setLotMultiplier] = useState("1");
  const [maxLot, setMaxLot] = useState("");
  const [maxDrawdown, setMaxDrawdown] = useState("10");
  const [reverseCopy, setReverseCopy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const relationships = useQuery<{ relationships: SelfCopyRelationship[] }>({
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
    onSuccess: async (data, input) => {
      setNotice({ tone: "success", text: String(data.message ?? `${input.label} completed.`) });
      await queryClient.invalidateQueries({ queryKey: ["self-copy-relationships"] });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  function create(event: FormEvent) {
    event.preventDefault();
    action.mutate({
      url: "/api/copy-trading/self-copy",
      method: "POST",
      label: "Self-copy setup",
      body: {
        sourceAccountId,
        followerAccountId,
        copySettings: {
          copyEnabled: true,
          copyMode,
          fixedLot: fixedLot ? Number(fixedLot) : null,
          lotMultiplier: lotMultiplier ? Number(lotMultiplier) : null,
          minLot: 0.01,
          maxLot: maxLot ? Number(maxLot) : null,
          maxOpenTrades: 10,
          maxDailyLossPercent: 5,
          maxDrawdownPercent: maxDrawdown ? Number(maxDrawdown) : null,
          allowedSymbols: null,
          blockedSymbols: null,
          symbolMapping: {},
          copyNewTradesOnly: true,
          reverseCopy,
          pauseOnDisconnect: true,
          emergencyStop: false,
        },
      },
    });
  }

  return (
    <Panel className="mt-5">
      <div className="flex items-start gap-3">
        <Repeat className="mt-0.5 h-5 w-5 text-accent" />
        <div>
          <h2 className="text-lg font-semibold text-foreground">Self Copy</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Copy real positions between your connected accounts. Opens, changes, partial closes, and full closes are synchronized; copied strategy trades can continue through this chain.
          </p>
        </div>
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

      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1.3fr]">
        <form className="space-y-4 rounded-[4px] border border-line bg-background p-4" onSubmit={create}>
          <h3 className="font-semibold text-foreground">Create live self-copy setup</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Source account" value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}>
              <option value="">Select source…</option>
              {eligibleAccounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>{account.accountName} · {account.status}</option>
              ))}
            </SelectField>
            <SelectField label="Follower account" value={followerAccountId} onChange={(event) => setFollowerAccountId(event.target.value)}>
              <option value="">Select follower…</option>
              {eligibleAccounts.filter((account) => account.accountId !== sourceAccountId).map((account) => (
                <option key={account.accountId} value={account.accountId}>{account.accountName} · {account.status}</option>
              ))}
            </SelectField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Copy mode" value={copyMode} onChange={(event) => setCopyMode(event.target.value as typeof copyMode)}>
              <option value="BALANCE_RATIO">Balance ratio</option>
              <option value="LOT_MULTIPLIER">Lot multiplier</option>
              <option value="FIXED_LOT">Fixed lot</option>
            </SelectField>
            {copyMode === "FIXED_LOT" ? (
              <TextField label="Fixed lot" type="number" min="0.01" step="0.01" required value={fixedLot} onChange={(event) => setFixedLot(event.target.value)} />
            ) : copyMode === "LOT_MULTIPLIER" ? (
              <TextField label="Lot multiplier" type="number" min="0.01" step="0.01" required value={lotMultiplier} onChange={(event) => setLotMultiplier(event.target.value)} />
            ) : (
              <TextField label="Balance multiplier" type="number" min="0.01" step="0.01" required value={lotMultiplier} onChange={(event) => setLotMultiplier(event.target.value)} />
            )}
            <TextField label="Maximum lot" type="number" min="0.01" step="0.01" value={maxLot} onChange={(event) => setMaxLot(event.target.value)} />
            <TextField label="Maximum drawdown %" type="number" min="0.01" max="100" step="0.1" value={maxDrawdown} onChange={(event) => setMaxDrawdown(event.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={reverseCopy} onChange={(event) => setReverseCopy(event.target.checked)} />
            Reverse BUY / SELL
          </label>
          <PrimaryButton
            type="submit"
            disabled={action.isPending || !sourceAccountId || !followerAccountId || sourceAccountId === followerAccountId}
          >
            Enable live self-copy
          </PrimaryButton>
          {eligibleAccounts.length < 2 ? (
            <p className="text-xs text-muted">Connect or sync at least two of your own accounts to create self-copy.</p>
          ) : null}
        </form>

        <div>
          {(relationships.data?.relationships.length ?? 0) === 0 ? (
            <EmptyState title="No self-copy setups" description="Your live account-to-account relationships will appear here." />
          ) : (
            <div className="space-y-3">
              {(relationships.data?.relationships ?? []).map((relationship) => (
                <div key={relationship.id} className="rounded-[4px] border border-line bg-background p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {relationship.sourceAccountName} → {relationship.followerAccountName}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {relationship.copySettings.copyMode.replaceAll("_", " ")}
                        {relationship.copySettings.maxLot ? ` · max ${relationship.copySettings.maxLot} lots` : ""}
                        {relationship.copySettings.reverseCopy ? " · reversed" : ""}
                      </p>
                    </div>
                    <StatusPill tone={relationship.status === "LIVE" ? "lime" : "muted"}>
                      {relationship.status}
                    </StatusPill>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                    <GhostButton
                      type="button"
                      disabled={action.isPending}
                      onClick={() => action.mutate({
                        url: `/api/copy-trading/self-copy/${relationship.id}`,
                        method: "PATCH",
                        body: { status: relationship.status === "LIVE" ? "PAUSED" : "LIVE" },
                        label: relationship.status === "LIVE" ? "Pause" : "Resume",
                      })}
                    >
                      {relationship.status === "LIVE" ? "Pause" : "Resume"}
                    </GhostButton>
                    <GhostButton
                      type="button"
                      disabled={action.isPending}
                      onClick={() => action.mutate({
                        url: `/api/copy-trading/self-copy/${relationship.id}`,
                        method: "DELETE",
                        label: "Removal",
                      })}
                    >
                      <Trash2 className="mr-2 inline-block h-4 w-4" />
                      Remove
                    </GhostButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
