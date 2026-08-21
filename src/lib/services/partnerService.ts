import { createAdminClient } from "@/lib/supabase/admin";
import { mapTradeToDto } from "@/lib/mappers/tradeMapper";
import { listPartnerTradeRebateLogs } from "@/lib/services/partnerRebateCalculationService";
import {
  PARTNER_ERROR,
  PartnerError,
  type PartnerAccountStatusSummary,
  type PartnerCommissionDto,
  type PartnerCommissionSummaryDto,
  type PartnerSummaryDto,
  type PartnerTraderDto,
  type TraderRiskStatus,
} from "@/lib/partner/types";
import type { CrmNoteDto, TradeDto } from "@/lib/domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Partner Service (server-only)
//
// Every query is scoped to traders attributed to the calling partner via
// trader_profiles.partner_id = <partnerUserId>. The admin (service-role) client
// is used the same way crmService/adminService use it — but ALWAYS behind an
// explicit partner_id filter so a partner can never read another partner's or
// an unassigned trader's data. Routes gate access with requirePartner().
// ─────────────────────────────────────────────────────────────────────────────

interface TraderProfileRow {
  id: string;
  user_id: string;
  segment: string;
  partner_assigned_at: string | null;
  profiles?: { full_name: string | null; email: string | null; status: string | null; created_at: string | null };
}

interface AccountRow {
  id: string;
  user_id: string;
  status: string;
  currency: string;
  account_name: string | null;
}

interface SnapshotRow {
  trading_account_id: string;
  balance: number | string;
  equity: number | string;
  floating_pnl: number | string;
  drawdown_percent: number | string;
}

interface AssignedContext {
  profiles: TraderProfileRow[];
  accounts: AccountRow[];
  snapshotByAccount: Map<string, SnapshotRow>;
  openRiskByAccount: Map<string, number>;
  accountToTraderUserId: Map<string, string>;
  tradeLotsByTraderUserId: Map<string, number>;
  allAccountIds: string[];
}

/** Load the partner's assigned traders + their accounts/snapshots/risk in bounded queries. */
async function loadAssignedContext(partnerUserId: string): Promise<AssignedContext> {
  const supabase = createAdminClient();

  const { data: profileRows, error: pErr } = await supabase
    .from("trader_profiles")
    // trader_profiles now has TWO FKs to profiles (user_id, partner_id), so the
    // embed must be disambiguated with the user_id column hint.
    .select("id, user_id, segment, partner_assigned_at, profiles!user_id(full_name, email, status, created_at)")
    .eq("partner_id", partnerUserId)
    .order("partner_assigned_at", { ascending: false })
    .limit(1000);
  if (pErr) throw new Error(`Failed to fetch assigned traders: ${pErr.message}`);

  const profiles = (profileRows ?? []) as unknown as TraderProfileRow[];
  const userIds = profiles.map((p) => p.user_id);
  if (userIds.length === 0) {
    return {
      profiles,
      accounts: [],
      snapshotByAccount: new Map(),
      openRiskByAccount: new Map(),
      accountToTraderUserId: new Map(),
      tradeLotsByTraderUserId: new Map(),
      allAccountIds: [],
    };
  }

  const { data: accountRows, error: aErr } = await supabase
    .from("trading_accounts")
    .select("id, user_id, status, currency, account_name")
    .in("user_id", userIds)
    .limit(2000);
  if (aErr) throw new Error(`Failed to fetch accounts: ${aErr.message}`);

  const accounts = (accountRows ?? []) as AccountRow[];
  const allAccountIds = accounts.map((a) => a.id);
  const accountToTraderUserId = new Map(accounts.map((a) => [a.id, a.user_id]));

  const snapshotByAccount = new Map<string, SnapshotRow>();
  const openRiskByAccount = new Map<string, number>();
  const tradeLotsByTraderUserId = new Map<string, number>();

  if (allAccountIds.length > 0) {
    const [{ data: snaps }, { data: riskRows }, { data: tradeRows }] = await Promise.all([
      supabase
        .from("latest_account_snapshots")
        .select("trading_account_id, balance, equity, floating_pnl, drawdown_percent")
        .in("trading_account_id", allAccountIds),
      supabase
        .from("risk_events")
        .select("trading_account_id")
        .is("acknowledged_at", null)
        .in("trading_account_id", allAccountIds)
        .limit(5000),
      supabase
        .from("trades")
        .select("trading_account_id, volume")
        .in("trading_account_id", allAccountIds)
        .limit(20000),
    ]);
    for (const s of (snaps ?? []) as SnapshotRow[]) snapshotByAccount.set(s.trading_account_id, s);
    for (const r of riskRows ?? []) {
      openRiskByAccount.set(r.trading_account_id, (openRiskByAccount.get(r.trading_account_id) ?? 0) + 1);
    }
    for (const trade of tradeRows ?? []) {
      const traderUserId = accountToTraderUserId.get(trade.trading_account_id as string);
      if (!traderUserId) continue;
      tradeLotsByTraderUserId.set(
        traderUserId,
        (tradeLotsByTraderUserId.get(traderUserId) ?? 0) + Math.abs(Number(trade.volume ?? 0)),
      );
    }
  }

  return { profiles, accounts, snapshotByAccount, openRiskByAccount, accountToTraderUserId, tradeLotsByTraderUserId, allAccountIds };
}

function buildTraderDto(
  profile: TraderProfileRow,
  ctx: AssignedContext,
): PartnerTraderDto {
  const traderAccounts = ctx.accounts.filter((a) => a.user_id === profile.user_id);
  let totalEquity = 0;
  let floatingPnl = 0;
  let maxDrawdown = 0;
  let connectedAccounts = 0;
  let openRiskEvents = 0;
  let restricted = false;

  for (const acc of traderAccounts) {
    if (acc.status === "CONNECTED") connectedAccounts += 1;
    if (acc.status === "RESTRICTED") restricted = true;
    openRiskEvents += ctx.openRiskByAccount.get(acc.id) ?? 0;
    const snap = ctx.snapshotByAccount.get(acc.id);
    if (snap) {
      totalEquity += Number(snap.equity);
      floatingPnl += Number(snap.floating_pnl);
      maxDrawdown = Math.max(maxDrawdown, Number(snap.drawdown_percent));
    }
  }

  const riskStatus: TraderRiskStatus = restricted
    ? "RESTRICTED"
    : openRiskEvents > 0
      ? "AT_RISK"
      : "OK";

  const accountStatuses: PartnerAccountStatusSummary[] = traderAccounts.map((acc) => {
    const snap = ctx.snapshotByAccount.get(acc.id);
    return {
      accountId: acc.id,
      accountName: acc.account_name,
      status: acc.status,
      currency: acc.currency,
      equity: snap ? Number(snap.equity) : 0,
    };
  });

  return {
    traderId: profile.user_id,
    traderProfileId: profile.id,
    name: profile.profiles?.full_name ?? "Unknown",
    email: profile.profiles?.email ?? "",
    status: profile.profiles?.status ?? "ACTIVE",
    segment: profile.segment,
    accountCount: traderAccounts.length,
    connectedAccounts,
    totalEquity: { amount: Number(totalEquity.toFixed(2)), currency: "USD" },
    floatingPnl: { amount: Number(floatingPnl.toFixed(2)), currency: "USD" },
    maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
    openRiskEvents,
    riskStatus,
    assignedAt: profile.partner_assigned_at,
    registeredAt: profile.profiles?.created_at ?? null,
    totalLotsTraded: Number((ctx.tradeLotsByTraderUserId.get(profile.user_id) ?? 0).toFixed(2)),
    accounts: accountStatuses,
  };
}

export async function getPartnerSummary(partnerUserId: string): Promise<PartnerSummaryDto> {
  const ctx = await loadAssignedContext(partnerUserId);
  const traders = ctx.profiles.map((p) => buildTraderDto(p, ctx));

  const totalEquity = traders.reduce((s, t) => s + t.totalEquity.amount, 0);
  const floatingPnl = traders.reduce((s, t) => s + t.floatingPnl.amount, 0);
  const connectedAccounts = traders.reduce((s, t) => s + t.connectedAccounts, 0);
  const openRiskEvents = traders.reduce((s, t) => s + t.openRiskEvents, 0);
  const activeTraders = traders.filter((t) => t.status === "ACTIVE").length;

  const commission = await getPartnerCommissionSummary(partnerUserId);
  const rebateLogs = await listPartnerTradeRebateLogs(partnerUserId, 5000);
  const totalTeamLots = traders.reduce((sum, trader) => sum + trader.totalLotsTraded, 0);
  const ibEarnings = rebateLogs
    .filter((row) => row.calculationType === "IB_VOLUME")
    .reduce((sum, row) => sum + row.rebateAmount, 0);
  const cpaEarnings = rebateLogs
    .filter((row) => row.calculationType === "CPA_TIER")
    .reduce((sum, row) => sum + row.rebateAmount, 0);
  const totalRebatesEarned = rebateLogs
    .filter((row) => row.status === "APPROVED" || row.status === "PAID")
    .reduce((sum, row) => sum + row.rebateAmount, 0);

  const supabase = createAdminClient();
  const { data: profileRow } = await supabase
    .from("partner_profiles")
    .select("referral_code")
    .eq("user_id", partnerUserId)
    .maybeSingle();

  return {
    assignedTraders: traders.length,
    activeTraders,
    connectedAccounts,
    totalEquity: { amount: Number(totalEquity.toFixed(2)), currency: "USD" },
    aggregateFloatingPnl: { amount: Number(floatingPnl.toFixed(2)), currency: "USD" },
    openRiskEvents,
    pendingCommission: commission.pending,
    earnedCommission: { amount: commission.approved.amount + commission.paid.amount, currency: commission.currency },
    totalTeamLots: Number(totalTeamLots.toFixed(2)),
    totalRebatesEarned: { amount: Number(totalRebatesEarned.toFixed(2)), currency: commission.currency },
    ibEarnings: { amount: Number(ibEarnings.toFixed(2)), currency: commission.currency },
    cpaEarnings: { amount: Number(cpaEarnings.toFixed(2)), currency: commission.currency },
    commissionPercent: commission.commissionPercent,
    referralCode: (profileRow?.referral_code as string | null) ?? null,
  };
}

export async function listPartnerTraders(
  partnerUserId: string,
  filters?: { status?: "ALL" | "ACTIVE" | "AT_RISK" | "RESTRICTED"; search?: string },
): Promise<PartnerTraderDto[]> {
  const ctx = await loadAssignedContext(partnerUserId);
  let traders = ctx.profiles.map((p) => buildTraderDto(p, ctx));

  const status = filters?.status ?? "ALL";
  if (status === "ACTIVE") traders = traders.filter((t) => t.riskStatus === "OK");
  else if (status === "AT_RISK") traders = traders.filter((t) => t.riskStatus === "AT_RISK");
  else if (status === "RESTRICTED") traders = traders.filter((t) => t.riskStatus === "RESTRICTED");

  const search = filters?.search?.trim().toLowerCase();
  if (search) {
    traders = traders.filter(
      (t) => t.name.toLowerCase().includes(search) || t.email.toLowerCase().includes(search),
    );
  }
  return traders;
}

/** Throws TRADER_NOT_ASSIGNED if the trader is not attributed to this partner. Returns trader_profiles.id. */
async function assertTraderAssigned(partnerUserId: string, traderUserId: string): Promise<string> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("trader_profiles")
    .select("id")
    .eq("user_id", traderUserId)
    .eq("partner_id", partnerUserId)
    .maybeSingle();
  if (!data) {
    throw new PartnerError(PARTNER_ERROR.TRADER_NOT_ASSIGNED, "This trader is not assigned to you.", 403);
  }
  return data.id as string;
}

export interface PartnerTraderDetail {
  trader: PartnerTraderDto;
  recentTrades: TradeDto[];
}

export async function getPartnerTraderDetail(
  partnerUserId: string,
  traderUserId: string,
): Promise<PartnerTraderDetail> {
  await assertTraderAssigned(partnerUserId, traderUserId);
  const ctx = await loadAssignedContext(partnerUserId);
  const profile = ctx.profiles.find((p) => p.user_id === traderUserId);
  if (!profile) {
    throw new PartnerError(PARTNER_ERROR.TRADER_NOT_ASSIGNED, "This trader is not assigned to you.", 403);
  }
  const trader = buildTraderDto(profile, ctx);
  const traderAccountIds = ctx.accounts.filter((a) => a.user_id === traderUserId).map((a) => a.id);

  let recentTrades: TradeDto[] = [];
  if (traderAccountIds.length > 0) {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("trades")
      .select(
        "id, short_trade_id, trading_account_id, symbol, side, status, volume, open_price, close_price, profit, currency, opened_at, closed_at",
      )
      .in("trading_account_id", traderAccountIds)
      .order("opened_at", { ascending: false })
      .limit(20);
    recentTrades = (data ?? []).map(mapTradeToDto);
  }
  return { trader, recentTrades };
}

export interface PartnerRiskEventDto {
  id: string;
  traderName: string;
  ruleName: string;
  severity: string;
  message: string;
  createdAt: string;
}

export async function listPartnerRiskEvents(partnerUserId: string): Promise<PartnerRiskEventDto[]> {
  const ctx = await loadAssignedContext(partnerUserId);
  if (ctx.allAccountIds.length === 0) return [];

  const nameByUserId = new Map(
    ctx.profiles.map((p) => [p.user_id, p.profiles?.full_name ?? "Unknown"]),
  );

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("risk_events")
    .select("id, trading_account_id, rule_name, severity, message, created_at")
    .is("acknowledged_at", null)
    .in("trading_account_id", ctx.allAccountIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to fetch risk events: ${error.message}`);

  return (data ?? []).map((r) => {
    const traderUserId = ctx.accountToTraderUserId.get(r.trading_account_id);
    return {
      id: r.id,
      traderName: (traderUserId && nameByUserId.get(traderUserId)) || "Unknown",
      ruleName: r.rule_name,
      severity: r.severity,
      message: r.message,
      createdAt: r.created_at,
    };
  });
}

export interface PartnerActivityDto {
  id: string;
  traderName: string;
  type: string;
  description: string;
  createdAt: string;
}

export async function listPartnerActivities(partnerUserId: string): Promise<PartnerActivityDto[]> {
  const ctx = await loadAssignedContext(partnerUserId);
  const profileIds = ctx.profiles.map((p) => p.id);
  if (profileIds.length === 0) return [];

  const nameByProfileId = new Map(
    ctx.profiles.map((p) => [p.id, p.profiles?.full_name ?? "Unknown"]),
  );

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("crm_activities")
    .select("id, trader_profile_id, type, description, created_at")
    .in("trader_profile_id", profileIds)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Failed to fetch activities: ${error.message}`);

  return (data ?? []).map((a) => ({
    id: a.id,
    traderName: nameByProfileId.get(a.trader_profile_id) ?? "Unknown",
    type: a.type,
    description: a.description,
    createdAt: a.created_at,
  }));
}

// ── Commissions ──────────────────────────────────────────────────────────────

interface CommissionRule {
  percent: number;
  type: "CPA" | "REBATE" | "PROFIT_SHARE";
  cpaAmount: number | null;
}

async function getCommissionRule(partnerUserId: string): Promise<CommissionRule> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("partner_profiles")
    .select("commission_percent, commission_type, cpa_amount")
    .eq("user_id", partnerUserId)
    .maybeSingle();
  return {
    percent: data ? Number(data.commission_percent) : 0,
    type: (data?.commission_type as "CPA" | "REBATE" | "PROFIT_SHARE") ?? "REBATE",
    cpaAmount: data?.cpa_amount != null ? Number(data.cpa_amount) : null,
  };
}

export async function getPartnerCommissionSummary(
  partnerUserId: string,
): Promise<PartnerCommissionSummaryDto> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("partner_commissions")
    .select("commission_amount, currency, status")
    .eq("partner_id", partnerUserId)
    .limit(5000);
  if (error) throw new Error(`Failed to fetch commission summary: ${error.message}`);

  let pending = 0;
  let approved = 0;
  let paid = 0;
  for (const row of data ?? []) {
    const amt = Number(row.commission_amount);
    if (row.status === "PENDING") pending += amt;
    else if (row.status === "APPROVED") approved += amt;
    else if (row.status === "PAID") paid += amt;
  }
  const rule = await getCommissionRule(partnerUserId);

  return {
    pending: { amount: Number(pending.toFixed(2)), currency: "USD" },
    approved: { amount: Number(approved.toFixed(2)), currency: "USD" },
    paid: { amount: Number(paid.toFixed(2)), currency: "USD" },
    commissionPercent: rule.percent,
    commissionType: rule.type,
    cpaAmount: rule.cpaAmount,
    currency: "USD",
  };
}

export async function listPartnerCommissions(partnerUserId: string): Promise<PartnerCommissionDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("partner_commissions")
    .select(
      "id, trader_id, source_type, gross_amount, commission_percent, commission_amount, currency, status, period_start, period_end, created_at, paid_at, profiles!trader_id(full_name)",
    )
    .eq("partner_id", partnerUserId)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`Failed to fetch commissions: ${error.message}`);

  return (data ?? []).map((r) => {
    const traderName = (r as { profiles?: { full_name?: string } }).profiles?.full_name ?? null;
    return {
      id: r.id,
      traderId: r.trader_id,
      traderName,
      sourceType: r.source_type,
      grossAmount: Number(r.gross_amount),
      commissionPercent: Number(r.commission_percent),
      commissionAmount: Number(r.commission_amount),
      currency: r.currency,
      status: r.status,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      createdAt: r.created_at,
      paidAt: r.paid_at,
    };
  });
}

// ── Partner CRM notes (own notes for assigned traders only) ──────────────────

export async function listPartnerNotes(
  partnerUserId: string,
  traderUserId: string,
): Promise<CrmNoteDto[]> {
  const traderProfileId = await assertTraderAssigned(partnerUserId, traderUserId);
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("crm_notes")
    .select("id, trader_profile_id, author_name, note, created_at")
    .eq("trader_profile_id", traderProfileId)
    .eq("note_source", "PARTNER")
    .eq("author_user_id", partnerUserId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Failed to fetch notes: ${error.message}`);
  return (data ?? []).map((n) => ({
    id: n.id,
    traderId: n.trader_profile_id,
    authorName: n.author_name,
    note: n.note,
    createdAt: n.created_at,
  }));
}

export async function createPartnerNote(params: {
  partnerUserId: string;
  partnerName: string;
  traderUserId: string;
  note: string;
}): Promise<CrmNoteDto> {
  const traderProfileId = await assertTraderAssigned(params.partnerUserId, params.traderUserId);
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("crm_notes")
    .insert({
      trader_profile_id: traderProfileId,
      author_user_id: params.partnerUserId,
      author_name: params.partnerName,
      note: params.note,
      note_source: "PARTNER",
    })
    .select("id, trader_profile_id, author_name, note, created_at")
    .single();
  if (error || !data) throw new Error(`Failed to create note: ${error?.message}`);
  return {
    id: data.id,
    traderId: data.trader_profile_id,
    authorName: data.author_name,
    note: data.note,
    createdAt: data.created_at,
  };
}
