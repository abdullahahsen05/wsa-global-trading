"use client";

import { useState, type FormEvent } from "react";
import { Bell, ShieldAlert } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DataTable,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField, TextField } from "@/components/app/FormFields";
import { formatMoney, formatPercent } from "@/lib/utils/format";
import type {
  RiskEventDto,
  RiskRuleAction,
  RiskRuleDto,
  TraderAccountSummary,
} from "@/lib/domain/types";

type RuleDraft = {
  name: string;
  metric: RiskRuleDto["metric"];
  threshold: string;
  severity: RiskRuleDto["severity"];
  action: RiskRuleAction;
  scope: RiskRuleDto["scope"];
  accountId: string;
  enabled: boolean;
};

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  metric: "DAILY_LOSS",
  threshold: "",
  severity: "CRITICAL",
  action: "RESTRICT",
  scope: "PLATFORM",
  accountId: "",
  enabled: true,
};

export default function AdminRiskPage() {
  const queryClient = useQueryClient();
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: riskRules = [] } = useQuery<RiskRuleDto[]>({
    queryKey: ["risk-rules"],
    queryFn: async () => {
      const response = await fetch("/api/risk/rules");
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load risk rules");
      return json.data;
    },
  });
  const { data: riskEvents = [] } = useQuery<RiskEventDto[]>({
    queryKey: ["risk-events"],
    queryFn: async () => {
      const response = await fetch("/api/risk/events");
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load risk events");
      return json.data;
    },
  });
  const { data: tradingAccounts = [] } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts"],
    queryFn: async () => {
      const response = await fetch("/api/trading-accounts");
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
  });

  const startCreate = () => {
    setEditingRuleId(null);
    setDraft(EMPTY_DRAFT);
    setMessage("");
    setErrorMessage("");
    document.getElementById("risk-rule-form")?.scrollIntoView({ behavior: "smooth" });
  };

  const startEdit = (rule: RiskRuleDto) => {
    setEditingRuleId(rule.id);
    setDraft({
      name: rule.name,
      metric: rule.metric,
      threshold: String(rule.threshold),
      severity: rule.severity,
      action: rule.action,
      scope: rule.scope,
      accountId: rule.accountId ?? "",
      enabled: rule.enabled,
    });
    setMessage("");
    setErrorMessage("");
    document.getElementById("risk-rule-form")?.scrollIntoView({ behavior: "smooth" });
  };

  const saveRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setErrorMessage("");
    const threshold = Number(draft.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      setErrorMessage("Threshold must be greater than zero.");
      setSaving(false);
      return;
    }
    if (!editingRuleId && draft.scope === "ACCOUNT" && !draft.accountId) {
      setErrorMessage("Select the account this rule should apply to.");
      setSaving(false);
      return;
    }

    const body = editingRuleId
      ? {
          name: draft.name,
          severity: draft.severity,
          action: draft.action,
          threshold,
          enabled: draft.enabled,
        }
      : {
          name: draft.name,
          metric: draft.metric,
          severity: draft.severity,
          action: draft.action,
          threshold,
          ...(draft.scope === "ACCOUNT" ? { accountId: draft.accountId } : {}),
        };
    try {
      const response = await fetch(
        editingRuleId ? `/api/risk/rules/${editingRuleId}` : "/api/risk/rules",
        {
          method: editingRuleId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Risk rule could not be saved.");
      await queryClient.invalidateQueries({ queryKey: ["risk-rules"] });
      setMessage(editingRuleId ? "Risk rule updated." : "Risk rule created.");
      if (!editingRuleId) setDraft(EMPTY_DRAFT);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Risk rule could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const acknowledgeEvent = async (eventId: string) => {
    const response = await fetch(`/api/risk/events/${eventId}/acknowledge`, { method: "POST" });
    const json = await response.json();
    if (!json.ok) {
      setErrorMessage(json.error?.message ?? "Risk event could not be acknowledged.");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["risk-events"] });
    setMessage("Risk event acknowledged. If the breach still exists, the live monitor will raise it again.");
  };

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Risk configuration"
      description="Configure real-time limits for connected trader accounts and control their enforcement action."
      action={<PrimaryButton type="button" onClick={startCreate}>Create rule</PrimaryButton>}
    >
      <InlineStatusStrip
        items={[
          { label: "Rules", value: riskRules.length },
          { label: "Enabled", value: riskRules.filter((rule) => rule.enabled).length, tone: "lime" },
          {
            label: "Enforced",
            value: riskRules.filter((rule) => rule.action !== "WARN" && rule.enabled).length,
            tone: "danger",
          },
          { label: "Open events", value: riskEvents.length, tone: "accent" },
        ]}
      />

      {message ? (
        <div className="mt-5 rounded-[4px] border border-accent-2/20 bg-accent-2/10 px-4 py-3 text-sm font-medium text-accent-2">
          {message}
        </div>
      ) : null}
      {errorMessage ? (
        <div className="mt-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
          {errorMessage}
        </div>
      ) : null}

      <div className="mt-5 grid gap-5">
        <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <Panel className="flex h-[420px] min-w-0 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Risk rules</h2>
              <p className="mt-1 text-sm text-muted">
                LIMIT blocks new WSA copy openings. RESTRICT also locks the account until the breach clears.
              </p>
            </div>
            <StatusPill tone="lime">MetaApi live monitor</StatusPill>
          </div>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 overflow-auto">
            <DataTable
              headers={["Rule", "Scope", "Metric", "Threshold", "Severity", "Action", "State", ""]}
              rows={riskRules.map((rule) => [
                <span key="name" className="font-semibold text-foreground">{rule.name}</span>,
                rule.scope,
                rule.metric,
                rule.threshold,
                <StatusPill
                  key="severity"
                  tone={rule.severity === "CRITICAL" ? "danger" : rule.severity === "WARNING" ? "accent" : "muted"}
                >
                  {rule.severity}
                </StatusPill>,
                <StatusPill key="action" tone={rule.action === "RESTRICT" ? "danger" : rule.action === "LIMIT" ? "accent" : "muted"}>
                  {rule.action}
                </StatusPill>,
                rule.enabled ? "Enabled" : "Disabled",
                <button
                  key="edit"
                  type="button"
                  className="text-sm font-semibold text-accent hover:text-accent-2"
                  onClick={() => startEdit(rule)}
                >
                  Edit
                </button>,
              ])}
            />
          </div>
        </Panel>

        <Panel className="flex h-[420px] min-w-0 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Open risk events</h2>
              <p className="mt-1 text-sm text-muted">
                Acknowledging removes the alert; an unresolved live breach will be raised again.
              </p>
            </div>
            <StatusPill tone="accent">{riskEvents.length} open</StatusPill>
          </div>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto">
            {riskEvents.length === 0 ? (
              <p className="border-t border-line py-4 text-sm text-muted">
                No open risk events.
              </p>
            ) : riskEvents.map((event) => (
              <div key={event.id} className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-background px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{event.ruleName}</p>
                  <p className="mt-1 text-sm leading-5 text-muted">{event.message}</p>
                </div>
                <GhostButton type="button" onClick={() => void acknowledgeEvent(event.id)}>
                  Acknowledge
                </GhostButton>
              </div>
            ))}
          </div>
        </Panel>
        </div>

        <div id="risk-rule-form">
        <Panel className="overflow-hidden">
          <div className="flex items-start gap-4">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[4px] bg-danger/10 text-danger">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                {editingRuleId ? "Edit risk rule" : "Create risk rule"}
              </h2>
              <p className="mt-1 text-sm leading-5 text-muted">
                Rules are evaluated from the MetaApi account stream and again after every manual sync.
              </p>
            </div>
          </div>
          <form className="mt-6 grid gap-5" onSubmit={saveRule}>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <TextField
                label="Rule name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                required
              />
              <SelectField
                label="Metric"
                value={draft.metric}
                disabled={Boolean(editingRuleId)}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  metric: event.target.value as RuleDraft["metric"],
                }))}
              >
                <option value="DAILY_LOSS">Daily closed loss (account currency)</option>
                <option value="MAX_DRAWDOWN">Current drawdown (%)</option>
                <option value="OPEN_TRADES">Open positions</option>
              </SelectField>
              <TextField
                label="Threshold"
                type="number"
                min="0.01"
                step="0.01"
                value={draft.threshold}
                onChange={(event) => setDraft((current) => ({ ...current, threshold: event.target.value }))}
                required
              />
              <SelectField
                label="Severity"
                value={draft.severity}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  severity: event.target.value as RuleDraft["severity"],
                }))}
              >
                <option value="INFO">Info</option>
                <option value="WARNING">Warning</option>
                <option value="CRITICAL">Critical</option>
              </SelectField>
              <SelectField
                label="Enforcement"
                value={draft.action}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  action: event.target.value as RuleDraft["action"],
                }))}
              >
                <option value="WARN">Warn only</option>
                <option value="LIMIT">Block new WSA copy openings</option>
                <option value="RESTRICT">Restrict account and block openings</option>
              </SelectField>
              <SelectField
                label="Scope"
                value={draft.scope}
                disabled={Boolean(editingRuleId)}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  scope: event.target.value as RuleDraft["scope"],
                  accountId: "",
                }))}
              >
                <option value="PLATFORM">All trader accounts</option>
                <option value="ACCOUNT">One account</option>
              </SelectField>
              {draft.scope === "ACCOUNT" ? (
                <SelectField
                  label="Trading account"
                  value={draft.accountId}
                  disabled={Boolean(editingRuleId)}
                  onChange={(event) => setDraft((current) => ({ ...current, accountId: event.target.value }))}
                  required
                >
                  <option value="">Select an account</option>
                  {tradingAccounts.map((account) => (
                    <option key={account.accountId} value={account.accountId}>
                      {account.accountName} · {account.brokerName}
                    </option>
                  ))}
                </SelectField>
              ) : null}
              {editingRuleId ? (
                <SelectField
                  label="State"
                  value={draft.enabled ? "ENABLED" : "DISABLED"}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    enabled: event.target.value === "ENABLED",
                  }))}
                >
                  <option value="ENABLED">Enabled</option>
                  <option value="DISABLED">Disabled</option>
                </SelectField>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-sm text-muted">
                Existing positions remain closable even while new openings are blocked.
              </p>
              <div className="flex flex-wrap gap-3">
                <GhostButton type="button" onClick={startCreate}>Reset</GhostButton>
                <PrimaryButton type="submit" disabled={saving}>
                  {saving ? "Saving…" : editingRuleId ? "Update rule" : "Create rule"}
                </PrimaryButton>
              </div>
            </div>
          </form>
        </Panel>
        </div>

        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Rule-based account monitoring</h2>
              <p className="mt-1 text-sm text-muted">Live connection and restriction status for every trading account.</p>
            </div>
            <StatusPill tone="accent">{tradingAccounts.length} accounts</StatusPill>
          </div>
          <div className="invisible-scrollbar mt-4 overflow-auto">
            <DataTable
              headers={["Account", "Broker", "Status", "Balance", "Equity", "Drawdown", "Risk state"]}
              rows={tradingAccounts.map((account) => [
                <span key="account" className="font-semibold text-foreground">{account.accountName}</span>,
                account.brokerName,
                <StatusPill
                  key="status"
                  tone={account.status === "RESTRICTED" ? "danger" : account.status === "CONNECTED" ? "lime" : "accent"}
                >
                  {account.status}
                </StatusPill>,
                formatMoney(account.balance),
                <span key="equity" className="font-semibold text-accent-2">{formatMoney(account.equity)}</span>,
                formatPercent(account.drawdownPercent),
                account.status === "RESTRICTED"
                  ? <StatusPill key="risk" tone="danger">Restricted</StatusPill>
                  : account.drawdownPercent >= 5
                    ? <StatusPill key="risk" tone="accent">Watch</StatusPill>
                    : <StatusPill key="risk" tone="lime">Normal</StatusPill>,
              ])}
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted">
            <Bell className="h-4 w-4 text-accent" />
            MetaApi stream changes are evaluated without waiting for the trader to press Sync.
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
