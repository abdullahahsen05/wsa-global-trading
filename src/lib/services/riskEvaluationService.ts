if (typeof window !== "undefined") {
  throw new Error("[wsa] riskEvaluationService is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";
import { evaluateRiskRules } from "@/lib/domain/risk";
import { mapRiskRuleToDto } from "@/lib/mappers/riskMapper";
import { createRiskEvent, findActiveRiskEvent } from "@/lib/services/riskService";
import { createNotification } from "@/lib/services/notificationService";
import { writeAuditLog } from "@/lib/services/auditService";
import type {
  AccountStatus,
  RiskEnforcementStateDto,
  RiskRuleDto,
  TraderAccountSummary,
} from "@/lib/domain/types";

export type RiskEvaluationSource = RiskEnforcementStateDto["source"];

export interface LiveRiskValues {
  balance: number;
  equity: number;
  openTradeCount: number;
  dailyProfit: number;
}

export interface RiskEvaluationResult {
  accountId: string;
  blockedNewTrades: boolean;
  restricted: boolean;
  breachedRuleNames: string[];
  evaluatedAt: string;
}

type RiskAccountRow = {
  id: string;
  user_id: string;
  account_name: string;
  broker_name: string;
  currency: string | null;
  status: string;
  risk_restricted_at: string | null;
};

export function computeDailyPnl(
  trades: Array<{ profit: string | number }>,
): number {
  return trades.reduce((sum, trade) => sum + Number(trade.profit), 0);
}

export function buildAccountInput(
  accountId: string,
  accountName: string,
  brokerName: string,
  currency: string | null,
  status: string,
  snapshot: {
    balance: number | string;
    equity: number | string;
    drawdown_percent: number | string;
  } | null,
  openTradeCount: number,
): TraderAccountSummary {
  const accountCurrency = currency ?? "USD";
  return {
    accountId,
    accountName,
    brokerName,
    serverName: null,
    platform: null,
    status: status as AccountStatus,
    balance: { amount: Number(snapshot?.balance ?? 0), currency: accountCurrency },
    equity: { amount: Number(snapshot?.equity ?? 0), currency: accountCurrency },
    floatingPnl: { amount: 0, currency: accountCurrency },
    openTradeCount,
    drawdownPercent: Number(snapshot?.drawdown_percent ?? 0),
    updatedAt: new Date().toISOString(),
  };
}

async function loadEnabledRules(accountId: string): Promise<RiskRuleDto[]> {
  const supabase = createAdminClient();
  const columns = "id, trading_account_id, name, severity, action, metric, threshold, enabled";
  const [{ data: platformRules, error: platformError }, { data: accountRules, error: accountError }] =
    await Promise.all([
      supabase
        .from("risk_rules")
        .select(columns)
        .is("trading_account_id", null)
        .eq("enabled", true),
      supabase
        .from("risk_rules")
        .select(columns)
        .eq("trading_account_id", accountId)
        .eq("enabled", true),
    ]);
  if (platformError) throw new Error(`Platform risk rules could not be loaded: ${platformError.message}`);
  if (accountError) throw new Error(`Account risk rules could not be loaded: ${accountError.message}`);
  return [...(platformRules ?? []), ...(accountRules ?? [])].map(mapRiskRuleToDto);
}

async function persistEvents(params: {
  accountId: string;
  accountUserId: string;
  actorUserId: string | null;
  events: ReturnType<typeof evaluateRiskRules>;
}): Promise<void> {
  for (const event of params.events) {
    const existingId = await findActiveRiskEvent(params.accountId, event.ruleName);
    if (existingId) continue;

    let eventId: string;
    try {
      eventId = await createRiskEvent({
        accountId: params.accountId,
        ruleName: event.ruleName,
        severity: event.severity,
        message: event.message,
      });
    } catch (error) {
      console.error("[RISK_EVAL] Failed to create risk event:", error);
      continue;
    }

    void createNotification({
      userId: params.accountUserId,
      accountId: params.accountId,
      type: "RISK_EVENT",
      title: `Risk alert: ${event.ruleName}`,
      message: event.message,
      riskEventId: eventId,
    }).catch((error) => console.error("[RISK_EVAL] Notification error:", error));

    void writeAuditLog({
      actorUserId: params.actorUserId,
      action: "RISK_EVENT_CREATED",
      entityType: "risk_event",
      entityId: eventId,
      metadata: {
        ruleName: event.ruleName,
        action: event.action,
        accountId: params.accountId,
      },
    });
  }
}

async function resolveClearedEvents(accountId: string, activeRuleNames: Set<string>): Promise<void> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("risk_events")
    .select("id, rule_name")
    .eq("trading_account_id", accountId)
    .is("acknowledged_at", null);
  if (error) throw new Error(`Active risk events could not be loaded: ${error.message}`);
  const clearedIds = (data ?? [])
    .filter((event) => !activeRuleNames.has(event.rule_name))
    .map((event) => event.id);
  if (clearedIds.length > 0) {
    const { error: clearError } = await supabase
      .from("risk_events")
      .update({ acknowledged_at: new Date().toISOString() })
      .in("id", clearedIds);
    if (clearError) throw new Error(`Cleared risk events could not be resolved: ${clearError.message}`);
  }
}

export async function evaluateAndEnforceRiskValues(params: {
  accountId: string;
  actorUserId: string | null;
  values: LiveRiskValues;
  source: RiskEvaluationSource;
  accountOverride?: RiskAccountRow;
}): Promise<RiskEvaluationResult> {
  const supabase = createAdminClient();
  let account = params.accountOverride;
  if (!account) {
    const result = await supabase
      .from("trading_accounts")
      .select("id, user_id, account_name, broker_name, currency, status, risk_restricted_at")
      .eq("id", params.accountId)
      .single();
    if (result.error || !result.data) {
      throw new Error(`Trading account could not be evaluated: ${result.error?.message ?? "not found"}`);
    }
    account = result.data as RiskAccountRow;
  }

  const rules = await loadEnabledRules(params.accountId);
  const balance = Number(params.values.balance || 0);
  const equity = Number(params.values.equity || 0);
  const drawdownPercent = balance > 0 ? Math.max(0, ((balance - equity) / balance) * 100) : 0;
  const accountInput = buildAccountInput(
    account.id,
    account.account_name,
    account.broker_name,
    account.currency,
    account.status,
    { balance, equity, drawdown_percent: drawdownPercent },
    params.values.openTradeCount,
  );
  const events = evaluateRiskRules({
    account: accountInput,
    trades: [],
    rules,
    dailyProfit: params.values.dailyProfit,
  });

  const activeRuleNames = new Set(events.map((event) => event.ruleName));
  const breachedRuleIds = new Set(events.map((event) => event.ruleId));
  const breachedRules = rules
    .filter((rule) => breachedRuleIds.has(rule.id))
    .map((rule) => ({
      ruleId: rule.id,
      name: rule.name,
      metric: rule.metric,
      action: rule.action,
      threshold: rule.threshold,
    }));
  const blockedNewTrades = breachedRules.some(
    (rule) => rule.action === "LIMIT" || rule.action === "RESTRICT",
  );
  const restricted = breachedRules.some((rule) => rule.action === "RESTRICT");
  const evaluatedAt = new Date().toISOString();

  const [, , stateResult] = await Promise.all([
    persistEvents({
      accountId: account.id,
      accountUserId: account.user_id,
      actorUserId: params.actorUserId,
      events,
    }),
    resolveClearedEvents(account.id, activeRuleNames),
    supabase.from("account_risk_states").upsert({
      trading_account_id: account.id,
      blocked_new_trades: blockedNewTrades,
      restricted,
      breached_rules: breachedRules,
      source: params.source,
      last_evaluated_at: evaluatedAt,
      updated_at: evaluatedAt,
    }, { onConflict: "trading_account_id" }),
  ]);
  if (stateResult.error) {
    throw new Error(`Risk enforcement state could not be saved: ${stateResult.error.message}`);
  }

  if (restricted && account.status !== "RESTRICTED") {
    const reason = breachedRules
      .filter((rule) => rule.action === "RESTRICT")
      .map((rule) => rule.name)
      .join(", ");
    const { error } = await supabase
      .from("trading_accounts")
      .update({
        status: "RESTRICTED",
        risk_restricted_at: evaluatedAt,
        risk_restriction_reason: reason,
      })
      .eq("id", account.id);
    if (error) throw new Error(`Account could not be risk-restricted: ${error.message}`);
    void writeAuditLog({
      actorUserId: params.actorUserId,
      action: "ACCOUNT_RESTRICTED",
      entityType: "trading_account",
      entityId: account.id,
      metadata: { reason, source: params.source },
    });
  } else if (!restricted && account.status === "RESTRICTED" && account.risk_restricted_at) {
    const { error } = await supabase
      .from("trading_accounts")
      .update({
        status: "CONNECTED",
        risk_restricted_at: null,
        risk_restriction_reason: null,
      })
      .eq("id", account.id);
    if (error) throw new Error(`Risk restriction could not be released: ${error.message}`);
  }

  return {
    accountId: account.id,
    blockedNewTrades,
    restricted,
    breachedRuleNames: [...activeRuleNames],
    evaluatedAt,
  };
}

export async function evaluateAndPersistRiskEvents(
  accountId: string,
  actorUserId: string | null,
): Promise<RiskEvaluationResult> {
  const supabase = createAdminClient();
  const { data: account, error: accountError } = await supabase
    .from("trading_accounts")
    .select("id, user_id, account_name, broker_name, currency, status, risk_restricted_at")
    .eq("id", accountId)
    .single();
  if (accountError || !account) {
    return {
      accountId,
      blockedNewTrades: false,
      restricted: false,
      breachedRuleNames: [],
      evaluatedAt: new Date().toISOString(),
    };
  }
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const [{ data: snapshots, error: snapshotError }, { data: closedToday, error: closedError }, openResult] =
    await Promise.all([
      supabase
        .from("account_snapshots")
        .select("balance, equity")
        .eq("trading_account_id", accountId)
        .order("captured_at", { ascending: false })
        .limit(1),
      supabase
        .from("trades")
        .select("profit")
        .eq("trading_account_id", accountId)
        .eq("status", "CLOSED")
        .gte("closed_at", todayStart.toISOString()),
      supabase
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("trading_account_id", accountId)
        .eq("status", "OPEN"),
    ]);
  if (snapshotError) throw new Error(`Live risk data could not be loaded: ${snapshotError.message}`);
  if (closedError) throw new Error(`Daily P&L could not be loaded: ${closedError.message}`);
  if (openResult.error) throw new Error(`Open trade count could not be loaded: ${openResult.error.message}`);
  const snapshot = snapshots?.[0] ?? { balance: 0, equity: 0 };
  return evaluateAndEnforceRiskValues({
    accountId,
    actorUserId,
    source: "SYNC",
    accountOverride: account as RiskAccountRow,
    values: {
      balance: Number(snapshot.balance),
      equity: Number(snapshot.equity),
      openTradeCount: openResult.count ?? 0,
      dailyProfit: computeDailyPnl(closedToday ?? []),
    },
  });
}
