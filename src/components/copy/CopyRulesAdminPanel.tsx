"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DataTable, Panel, PrimaryButton, StatusPill } from "@/components/app/WorkspaceUI";
import { SelectField, TextField } from "@/components/app/FormFields";
import type { CopyAccountRuleDto, CopyGlobalSettingsDto, CopyRuleEventDto } from "@/lib/copy/types";
import type { TraderAccountSummary } from "@/lib/domain/types";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const json = await response.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data;
}

type LimitForm = {
  maxDailyLossPercent: string;
  maxDrawdownPercent: string;
  maxCopiedOpenPositions: string;
  maxLotSize: string;
  maxSlippagePoints: string;
};

const emptyGlobal: LimitForm = {
  maxDailyLossPercent: "",
  maxDrawdownPercent: "",
  maxCopiedOpenPositions: "",
  maxLotSize: "",
  maxSlippagePoints: "",
};

const emptyAccount = {
  copyEnabled: true,
  maxDailyLossPercent: "",
  maxDrawdownPercent: "",
  maxCopiedLots: "",
  maxOpenCopiedPositions: "",
  stopAfterLosses: "",
  symbolAllowlist: "",
  symbolBlocklist: "",
};

const optionalNumber = (value: string): number | null => (value.trim() === "" ? null : Number(value));
const optionalInteger = (value: string): number | null => (value.trim() === "" ? null : Math.trunc(Number(value)));
const symbols = (value: string): string[] | null => {
  const list = value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  return list.length > 0 ? Array.from(new Set(list)) : null;
};

export function CopyRulesAdminPanel() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [copyEnabledDraft, setCopyEnabledDraft] = useState<boolean | null>(null);
  const [pauseOnDisconnectDraft, setPauseOnDisconnectDraft] = useState<boolean | null>(null);
  const [globalFormDraft, setGlobalFormDraft] = useState<LimitForm | null>(null);
  const [accountFormDraft, setAccountFormDraft] = useState<typeof emptyAccount | null>(null);

  const { data: settings } = useQuery<CopyGlobalSettingsDto>({
    queryKey: ["admin-copy-settings"],
    queryFn: () => getJson("/api/admin/copy/settings"),
  });
  const { data: accounts = [] } = useQuery<TraderAccountSummary[]>({
    queryKey: ["admin-accounts"],
    queryFn: () => getJson("/api/admin/accounts"),
  });
  const selectedAccountId = accountId || accounts[0]?.accountId || "";
  const { data: accountRule } = useQuery<CopyAccountRuleDto>({
    queryKey: ["admin-copy-account-rule", selectedAccountId],
    queryFn: () => getJson(`/api/admin/copy/rules?accountId=${selectedAccountId}`),
    enabled: Boolean(selectedAccountId),
  });
  const { data: events = [] } = useQuery<CopyRuleEventDto[]>({
    queryKey: ["admin-copy-rule-events"],
    queryFn: () => getJson("/api/admin/copy/rules/events?limit=30"),
  });

  const copyEnabled = copyEnabledDraft ?? settings?.copyEnabled ?? true;
  const pauseOnDisconnect = pauseOnDisconnectDraft ?? settings?.pauseOnDisconnect ?? true;
  const globalForm = globalFormDraft ?? (settings ? {
    maxDailyLossPercent: settings.maxDailyLossPercent?.toString() ?? "",
    maxDrawdownPercent: settings.maxDrawdownPercent?.toString() ?? "",
    maxCopiedOpenPositions: settings.maxCopiedOpenPositions?.toString() ?? "",
    maxLotSize: settings.maxLotSize?.toString() ?? "",
    maxSlippagePoints: settings.maxSlippagePoints?.toString() ?? "",
  } : emptyGlobal);
  const accountForm = accountFormDraft ?? (accountRule ? {
    copyEnabled: accountRule.copyEnabled,
    maxDailyLossPercent: accountRule.maxDailyLossPercent?.toString() ?? "",
    maxDrawdownPercent: accountRule.maxDrawdownPercent?.toString() ?? "",
    maxCopiedLots: accountRule.maxCopiedLots?.toString() ?? "",
    maxOpenCopiedPositions: accountRule.maxOpenCopiedPositions?.toString() ?? "",
    stopAfterLosses: accountRule.stopAfterLosses?.toString() ?? "",
    symbolAllowlist: accountRule.symbolAllowlist?.join(", ") ?? "",
    symbolBlocklist: accountRule.symbolBlocklist?.join(", ") ?? "",
  } : emptyAccount);

  const save = useMutation({
    mutationFn: async ({ url, method, body }: { url: string; method: "PATCH" | "PUT"; body: unknown }) => {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
      return json.data;
    },
    onSuccess: () => {
      setMessage("Copy stoppage rules saved.");
      queryClient.invalidateQueries({ queryKey: ["admin-copy-settings"] });
      queryClient.invalidateQueries({ queryKey: ["admin-copy-account-rule", selectedAccountId] });
      queryClient.invalidateQueries({ queryKey: ["admin-copy-rule-events"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const setGlobal = (key: keyof LimitForm, value: string) => setGlobalFormDraft((current) => ({ ...(current ?? globalForm), [key]: value }));
  const setAccount = (key: keyof typeof emptyAccount, value: string | boolean) => setAccountFormDraft((current) => ({ ...(current ?? accountForm), [key]: value }));

  return (
    <div className="mt-5 grid gap-5">
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Global stoppage rules</h2>
            <p className="mt-1 text-sm text-muted">Applied before every simulated or live copied order.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <input type="checkbox" checked={copyEnabled} onChange={(event) => setCopyEnabledDraft(event.target.checked)} />
            Copy enabled
          </label>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <TextField label="Max daily loss %" type="number" min="0.01" step="0.01" value={globalForm.maxDailyLossPercent} onChange={(e) => setGlobal("maxDailyLossPercent", e.target.value)} />
          <TextField label="Max drawdown %" type="number" min="0.01" step="0.01" value={globalForm.maxDrawdownPercent} onChange={(e) => setGlobal("maxDrawdownPercent", e.target.value)} />
          <TextField label="Max open positions" type="number" min="0" step="1" value={globalForm.maxCopiedOpenPositions} onChange={(e) => setGlobal("maxCopiedOpenPositions", e.target.value)} />
          <TextField label="Max lot size" type="number" min="0.01" step="0.01" value={globalForm.maxLotSize} onChange={(e) => setGlobal("maxLotSize", e.target.value)} />
          <TextField label="Max slippage points" type="number" min="0.01" step="0.01" value={globalForm.maxSlippagePoints} onChange={(e) => setGlobal("maxSlippagePoints", e.target.value)} />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={pauseOnDisconnect} onChange={(event) => setPauseOnDisconnectDraft(event.target.checked)} />
            Pause on account disconnect
          </label>
          <PrimaryButton
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({
              url: "/api/admin/copy/settings",
              method: "PATCH",
              body: {
                copyEnabled,
                pauseOnDisconnect,
                maxDailyLossPercent: optionalNumber(globalForm.maxDailyLossPercent),
                maxDrawdownPercent: optionalNumber(globalForm.maxDrawdownPercent),
                maxCopiedOpenPositions: optionalInteger(globalForm.maxCopiedOpenPositions),
                maxLotSize: optionalNumber(globalForm.maxLotSize),
                maxSlippagePoints: optionalNumber(globalForm.maxSlippagePoints),
              },
            })}
          >Save global rules</PrimaryButton>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <h2 className="text-lg font-semibold text-foreground">Per-account rules</h2>
        <p className="mt-1 text-sm text-muted">Override platform defaults for specific connected trading accounts.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField label="Trading account" value={selectedAccountId} onChange={(event) => { setAccountId(event.target.value); setAccountFormDraft(null); }}>
            <option value="">Select account</option>
            {accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountName} · {account.brokerName}</option>)}
          </SelectField>
          <TextField label="Max daily loss %" type="number" min="0.01" step="0.01" value={accountForm.maxDailyLossPercent} onChange={(e) => setAccount("maxDailyLossPercent", e.target.value)} />
          <TextField label="Max drawdown %" type="number" min="0.01" step="0.01" value={accountForm.maxDrawdownPercent} onChange={(e) => setAccount("maxDrawdownPercent", e.target.value)} />
          <TextField label="Max copied lots" type="number" min="0.01" step="0.01" value={accountForm.maxCopiedLots} onChange={(e) => setAccount("maxCopiedLots", e.target.value)} />
          <TextField label="Max open copied positions" type="number" min="0" step="1" value={accountForm.maxOpenCopiedPositions} onChange={(e) => setAccount("maxOpenCopiedPositions", e.target.value)} />
          <TextField label="Stop after losses" type="number" min="1" step="1" value={accountForm.stopAfterLosses} onChange={(e) => setAccount("stopAfterLosses", e.target.value)} />
          <TextField label="Allowed symbols" hint="Comma separated; blank allows all" value={accountForm.symbolAllowlist} onChange={(e) => setAccount("symbolAllowlist", e.target.value)} />
          <TextField label="Blocked symbols" hint="Comma separated" value={accountForm.symbolBlocklist} onChange={(e) => setAccount("symbolBlocklist", e.target.value)} />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
          <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <input type="checkbox" checked={accountForm.copyEnabled} onChange={(event) => setAccount("copyEnabled", event.target.checked)} />
            Copy enabled for account
          </label>
          <PrimaryButton
            type="button"
            disabled={!selectedAccountId || save.isPending}
            onClick={() => save.mutate({
              url: "/api/admin/copy/rules",
              method: "PUT",
              body: {
                accountId: selectedAccountId,
                rules: {
                  copyEnabled: accountForm.copyEnabled,
                  maxDailyLossPercent: optionalNumber(accountForm.maxDailyLossPercent),
                  maxDrawdownPercent: optionalNumber(accountForm.maxDrawdownPercent),
                  maxCopiedLots: optionalNumber(accountForm.maxCopiedLots),
                  maxOpenCopiedPositions: optionalInteger(accountForm.maxOpenCopiedPositions),
                  stopAfterLosses: optionalInteger(accountForm.stopAfterLosses),
                  symbolAllowlist: symbols(accountForm.symbolAllowlist),
                  symbolBlocklist: symbols(accountForm.symbolBlocklist),
                },
              },
            })}
          >Save account rules</PrimaryButton>
          {message ? <p className="text-sm text-muted">{message}</p> : null}
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <h2 className="mb-4 text-lg font-semibold text-foreground">Recent rule triggers</h2>
        {events.length === 0 ? (
          <p className="rounded-[4px] border border-line bg-background px-4 py-5 text-sm text-muted">
            No copy rule has blocked an event yet.
          </p>
        ) : (
          <DataTable
            headers={["Time", "Scope", "Rule", "Mode", "Reason"]}
            rows={events.map((event) => [
              <span key="time">{new Date(event.createdAt).toLocaleString()}</span>,
              <StatusPill key="scope" tone={event.scope === "GLOBAL" ? "danger" : "accent"}>{event.scope}</StatusPill>,
              <span key="rule" className="font-mono text-xs">{event.ruleCode}</span>,
              <StatusPill key="mode" tone={event.mode === "LIVE" ? "danger" : "muted"}>{event.mode}</StatusPill>,
              <span key="reason">{event.reason}</span>,
            ])}
          />
        )}
      </Panel>
    </div>
  );
}
