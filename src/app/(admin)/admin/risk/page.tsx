"use client";

import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bell, ChevronRight, Clock3, ShieldAlert, X } from "lucide-react";
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
  const [allEventsOpen, setAllEventsOpen] = useState(false);
  const [acknowledgingEventId, setAcknowledgingEventId] = useState<string | null>(null);
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
  const recentRiskEvents = riskEvents.slice(0, 3);
  const accountNames = new Map(
    tradingAccounts.map((account) => [account.accountId, account.accountName]),
  );

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
    setAcknowledgingEventId(eventId);
    setMessage("");
    setErrorMessage("");
    try {
      const response = await fetch(`/api/risk/events/${eventId}/acknowledge`, { method: "POST" });
      const json = await response.json();
      if (!json.ok) {
        throw new Error(json.error?.message ?? "Risk event could not be acknowledged.");
      }
      await queryClient.invalidateQueries({ queryKey: ["risk-events"] });
      setMessage("Risk event acknowledged. If the breach still exists, the live monitor will raise it again.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Risk event could not be acknowledged.");
    } finally {
      setAcknowledgingEventId(null);
    }
  };

  const eventCard = (event: RiskEventDto, expanded = false) => {
    const accountName = accountNames.get(event.accountId) ?? "Trading account";
    const isAcknowledging = acknowledgingEventId === event.id;
    const severityTone = event.severity === "CRITICAL"
      ? "danger"
      : event.severity === "WARNING"
        ? "accent"
        : "muted";
    const severityRail = event.severity === "CRITICAL"
      ? "bg-danger"
      : event.severity === "WARNING"
        ? "bg-accent"
        : "bg-muted";

    return (
      <article
        key={event.id}
        className={`relative overflow-hidden rounded-[5px] border border-line bg-background transition-colors hover:border-accent/30 ${
          expanded ? "p-5" : "p-4"
        }`}
      >
        <span className={`absolute inset-y-0 left-0 w-0.5 ${severityRail}`} aria-hidden="true" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-foreground">{event.ruleName}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-[0.12em] text-muted">
              {accountName}
            </p>
          </div>
          <StatusPill tone={severityTone}>{event.severity}</StatusPill>
        </div>
        <p className={`text-sm leading-6 text-muted ${expanded ? "mt-4" : "mt-3 line-clamp-2"}`}>
          {event.message}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <span className="flex items-center gap-2 text-xs text-muted">
            <Clock3 className="h-3.5 w-3.5" />
            {new Date(event.createdAt).toLocaleString()}
          </span>
          <GhostButton
            type="button"
            disabled={isAcknowledging}
            onClick={() => void acknowledgeEvent(event.id)}
            className="min-h-9 px-3 py-2 text-xs"
          >
            {isAcknowledging ? "Acknowledging…" : "Acknowledge"}
          </GhostButton>
        </div>
      </article>
    );
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
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">
                Live event feed
              </p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">Recent risk events</h2>
              <p className="mt-1 text-sm text-muted">
                Latest unresolved breaches, ordered newest first.
              </p>
            </div>
            <StatusPill tone="accent">{riskEvents.length} open</StatusPill>
          </div>
          <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {riskEvents.length === 0 ? (
              <div className="grid min-h-44 place-items-center rounded-[5px] border border-dashed border-line bg-background/50 px-6 text-center">
                <div>
                  <div className="mx-auto grid h-10 w-10 place-items-center rounded-full border border-accent-2/20 bg-accent-2/10 text-accent-2">
                    <ShieldAlert className="h-4 w-4" />
                  </div>
                  <p className="mt-3 font-semibold text-foreground">No open risk events</p>
                  <p className="mt-1 text-sm text-muted">All monitored accounts are clear.</p>
                </div>
              </div>
            ) : recentRiskEvents.map((event) => eventCard(event))}
          </div>
          <button
            type="button"
            disabled={riskEvents.length === 0}
            onClick={() => setAllEventsOpen(true)}
            className="mt-4 flex shrink-0 items-center justify-between border-t border-line pt-4 text-sm font-semibold text-foreground transition-colors hover:text-accent disabled:cursor-not-allowed disabled:text-muted"
          >
            <span>View all open events</span>
            <span className="flex items-center gap-2 text-xs uppercase tracking-[0.12em]">
              {riskEvents.length}
              <ChevronRight className="h-4 w-4" />
            </span>
          </button>
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

      <Dialog.Root open={allEventsOpen} onOpenChange={setAllEventsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[94vw] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[6px] border border-line bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.65)] focus:outline-none">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">
                  Live event feed
                </p>
                <Dialog.Title className="mt-2 text-xl font-semibold text-foreground">
                  All open risk events
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  {riskEvents.length} unresolved {riskEvents.length === 1 ? "breach" : "breaches"} across monitored trading accounts.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close all risk events"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] border border-line bg-background text-muted transition-colors hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="invisible-scrollbar min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
              {riskEvents.length === 0 ? (
                <div className="grid min-h-64 place-items-center rounded-[5px] border border-dashed border-line bg-background/50 px-6 text-center">
                  <div>
                    <ShieldAlert className="mx-auto h-6 w-6 text-accent-2" />
                    <p className="mt-3 font-semibold text-foreground">No open risk events</p>
                    <p className="mt-1 text-sm text-muted">All monitored accounts are clear.</p>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {riskEvents.map((event) => eventCard(event, true))}
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-background/50 px-5 py-4 sm:px-6">
              <p className="text-xs text-muted">
                Acknowledging removes an alert. A continuing live breach will be raised again.
              </p>
              <Dialog.Close asChild>
                <GhostButton type="button">Close</GhostButton>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}
