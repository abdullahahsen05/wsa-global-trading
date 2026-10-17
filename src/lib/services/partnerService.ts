import { createAdminClient } from "@/lib/supabase/admin";
import { mapTradeToDto } from "@/lib/mappers/tradeMapper";
import {
  refreshPartnerRebatesIfStale,
  getPartnerRebateTotals,
} from "@/lib/services/partnerRebateCalculationService";
import {
  chunkArray,
  selectAllPages,
  selectAllPagesForIds,
} from "@/lib/supabase/pagedSelect";
import {
  PARTNER_ERROR,
  PartnerError,
  type PartnerAccountStatusSummary,
  type PartnerCommissionModel,
  type PartnerCommissionDto,
  type PartnerCommissionSummaryDto,
  type PartnerSummaryDto,
  type PartnerTraderDto,
  type TraderRiskStatus,
} from "@/lib/partner/types";
import {
  EARNED_REBATE_STATUSES,
  closedAfterAttribution,
  cpaTierName,
  dominantCurrency,
  isEligibleLiveAccount,
  pickBrokerConfiguration,
  rebateKind,
  roundMoney,
  type BrokerConfigCandidate,
} from "@/lib/partner/rebateRules";
import type { CrmNoteDto, TradeDto } from "@/lib/domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Partner Service (server-only)
//
// Every query is scoped to traders attributed to the calling partner via
// trader_profiles.partner_id = <partnerUserId>. The admin (service-role) client
// is used the same way crmService/adminService use it — but ALWAYS behind an
// explicit partner_id filter so a partner can never read another partner's or
// an unassigned trader's data. Routes gate access with requirePartner().
//
// Two kinds of money, never mixed:
//   • WSA commission — a percentage of what attributed traders pay WSA. The
//     only balance that can be withdrawn through WSA ("wallet").
//   • Broker earnings — IB per lot and CPA, calculated per the agreement the
//     admin entered for the partner and broker. Reporting only.
// Every list below is read page by page (PostgREST returns ≤ 1000 rows per
// request), so totals stay right for partners with thousands of trades.
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
  broker_name: string | null;
  broker_provider_id: string | null;
  initial_balance: number | string | null;
  last_synced_at: string | null;
  account_usage: string | null;
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
  rebatesByTraderUserId: Map<string, RebateAggregate>;
  commissionsByTraderUserId: Map<string, CommissionAggregate>;
  configs: BrokerConfigRow[];
  allAccountIds: string[];
}

interface RebateAggregate {
  /** APPROVED + PAID broker earnings. */
  earned: number;
  pending: number;
  ib: number;
  cpa: number;
}

interface CommissionAggregate {
  approved: number;
  pending: number;
  paid: number;
  /** Everything that still counts (PENDING + APPROVED + PAID). */
  total: number;
  grossRevenue: number;
}

interface BrokerConfigRow extends BrokerConfigCandidate {
  broker_provider_id: string | null;
  model_type: "IB" | "CPA" | "HYBRID";
  cpa_qualification_lots: number | string;
  cpa_tier_1_deposit: number | string;
  cpa_tier_2_deposit: number | string;
  cpa_tier_3_deposit: number | string;
  broker_providers?: { display_name?: string | null; name?: string | null } | null;
}

function newestIso(values: Array<string | null | undefined>): string | null {
  const timestamps = values.filter(Boolean) as string[];
  if (timestamps.length === 0) return null;
  return timestamps.reduce((latest, current) =>
    new Date(current).getTime() > new Date(latest).getTime() ? current : latest,
  );
}

function detectPipelineStage(params: {
  accountCount: number;
  connectedAccounts: number;
  latestSyncAt: string | null;
  totalLots: number;
  cpaQualified: boolean;
}): PartnerTraderDto["pipelineStage"] {
  if (params.cpaQualified) return "QUALIFIED";
  if (params.totalLots > 0) return "TRADING";
  if (params.latestSyncAt) return "LIVE_SYNCED";
  if (params.connectedAccounts > 0 || params.accountCount > 0) return "BROKER_CONNECTED";
  return "REGISTERED";
}

function cpaTierLabel(config: BrokerConfigRow | null, deposit: number): string | null {
  if (!config || config.model_type === "IB") return null;
  return cpaTierName(
    [
      { deposit: Number(config.cpa_tier_1_deposit), payout: 0 },
      { deposit: Number(config.cpa_tier_2_deposit), payout: 0 },
      { deposit: Number(config.cpa_tier_3_deposit), payout: 0 },
    ],
    deposit,
  );
}

/** The agreement that applies to a trader: one for an account's own broker wins over the "all brokers" default. */
function configForAccounts(accounts: AccountRow[], configs: BrokerConfigRow[]): BrokerConfigRow | null {
  let fallback: BrokerConfigRow | null = null;
  for (const account of accounts) {
    const picked = pickBrokerConfiguration(configs, account.broker_provider_id, account.broker_name);
    if (picked?.brokerProviderId) return picked;
    fallback = fallback ?? picked;
  }
  return fallback ?? pickBrokerConfiguration(configs, null, null);
}

/** Load the partner's assigned traders + their accounts/snapshots/risk in bounded queries. */
async function loadAssignedContext(partnerUserId: string): Promise<AssignedContext> {
  const supabase = createAdminClient();

  const profiles = await selectAllPages<TraderProfileRow>(
    "Failed to fetch assigned traders",
    (from, to) =>
      supabase
        .from("trader_profiles")
        // trader_profiles now has TWO FKs to profiles (user_id, partner_id), so the
        // embed must be disambiguated with the user_id column hint.
        .select("id, user_id, segment, partner_assigned_at, profiles!user_id(full_name, email, status, created_at)")
        .eq("partner_id", partnerUserId)
        .order("partner_assigned_at", { ascending: false })
        .order("id")
        .range(from, to),
  );
  const userIds = profiles.map((p) => p.user_id);
  if (userIds.length === 0) {
    return {
      profiles,
      accounts: [],
      snapshotByAccount: new Map(),
      openRiskByAccount: new Map(),
      accountToTraderUserId: new Map(),
      tradeLotsByTraderUserId: new Map(),
      rebatesByTraderUserId: new Map(),
      commissionsByTraderUserId: new Map(),
      configs: [],
      allAccountIds: [],
    };
  }

  const accounts = await selectAllPagesForIds<AccountRow>(
    "Failed to fetch accounts",
    userIds,
    (ids, from, to) =>
      supabase
        .from("trading_accounts")
        .select("id, user_id, status, currency, account_name, broker_name, broker_provider_id, initial_balance, last_synced_at, account_usage")
        .in("user_id", ids)
        .order("id")
        .range(from, to),
  );
  const liveAccounts = accounts.filter((account) => isEligibleLiveAccount(account));
  const liveCommissionAccountIds = liveAccounts.map((a) => a.id);
  const allAccountIds = accounts.map((a) => a.id);
  const accountToTraderUserId = new Map(accounts.map((a) => [a.id, a.user_id]));

  // A trade counts for the partner only from the day its trader was attributed.
  const assignedAtByTrader = new Map(profiles.map((p) => [p.user_id, p.partner_assigned_at]));
  const assignedDates = profiles.map((p) => p.partner_assigned_at);
  const earliestAssigned = assignedDates.length > 0 && assignedDates.every(Boolean)
    ? new Date(Math.min(...assignedDates.map((value) => Date.parse(value as string)))).toISOString()
    : null;

  const snapshotByAccount = new Map<string, SnapshotRow>();
  const openRiskByAccount = new Map<string, number>();
  const tradeLotsByTraderUserId = new Map<string, number>();
  const rebatesByTraderUserId = new Map<string, RebateAggregate>();
  const commissionsByTraderUserId = new Map<string, CommissionAggregate>();

  const [snaps, riskRows, tradeRows, rebateRows, commissionRows, configRows] = await Promise.all([
    selectAllPagesForIds<SnapshotRow>(
      "Failed to fetch account snapshots",
      allAccountIds,
      (ids, from, to) =>
        supabase
          .from("latest_account_snapshots")
          .select("trading_account_id, balance, equity, floating_pnl, drawdown_percent")
          .in("trading_account_id", ids)
          .order("trading_account_id")
          .range(from, to),
    ),
    selectAllPagesForIds<{ trading_account_id: string }>(
      "Failed to fetch risk events",
      allAccountIds,
      (ids, from, to) =>
        supabase
          .from("risk_events")
          .select("trading_account_id")
          .is("acknowledged_at", null)
          .in("trading_account_id", ids)
          .order("id")
          .range(from, to),
    ),
    selectAllPagesForIds<{ trading_account_id: string; volume: number | string | null; closed_at: string | null }>(
      "Failed to fetch trade volume",
      liveCommissionAccountIds,
      (ids, from, to) => {
        let query = supabase
          .from("trades")
          .select("trading_account_id, volume, closed_at")
          .in("trading_account_id", ids)
          .eq("status", "CLOSED")
          .not("closed_at", "is", null)
          .neq("volume", 0);
        if (earliestAssigned) query = query.gte("closed_at", earliestAssigned);
        return query.order("id").range(from, to);
      },
    ),
    selectAllPages<{
      trader_id: string | null;
      amount: number | string | null;
      status: string;
      calculation_type: string | null;
      source_type: string | null;
    }>("Failed to fetch partner rebates", (from, to) =>
      supabase
        .from("partner_rebates")
        .select("trader_id, amount, status, calculation_type, source_type")
        .eq("partner_id", partnerUserId)
        .order("id")
        .range(from, to),
    ),
    selectAllPages<{
      trader_id: string | null;
      gross_amount: number | string | null;
      commission_amount: number | string | null;
      status: string;
    }>("Failed to fetch partner commissions", (from, to) =>
      supabase
        .from("partner_commissions")
        .select("trader_id, gross_amount, commission_amount, status")
        .eq("partner_id", partnerUserId)
        .order("id")
        .range(from, to),
    ),
    selectAllPages<{
      broker_provider_id: string | null;
      model_type: "IB" | "CPA" | "HYBRID";
      cpa_qualification_lots: number | string;
      cpa_tier_1_deposit: number | string;
      cpa_tier_2_deposit: number | string;
      cpa_tier_3_deposit: number | string;
      broker_providers?: { display_name?: string | null; name?: string | null } | null;
    }>("Failed to fetch partner agreements", (from, to) =>
      supabase
        .from("partner_broker_configurations")
        .select("broker_provider_id, model_type, cpa_qualification_lots, cpa_tier_1_deposit, cpa_tier_2_deposit, cpa_tier_3_deposit, broker_providers(display_name, name)")
        .eq("partner_id", partnerUserId)
        .eq("is_active", true)
        .order("id")
        .range(from, to),
    ),
  ]);

  for (const s of snaps) snapshotByAccount.set(s.trading_account_id, s);
  for (const r of riskRows) {
    openRiskByAccount.set(r.trading_account_id, (openRiskByAccount.get(r.trading_account_id) ?? 0) + 1);
  }
  for (const trade of tradeRows) {
    const traderUserId = accountToTraderUserId.get(trade.trading_account_id);
    if (!traderUserId) continue;
    if (!closedAfterAttribution(trade.closed_at, assignedAtByTrader.get(traderUserId))) continue;
    tradeLotsByTraderUserId.set(
      traderUserId,
      (tradeLotsByTraderUserId.get(traderUserId) ?? 0) + Math.abs(Number(trade.volume ?? 0)),
    );
  }
  for (const rebate of rebateRows) {
    const traderId = rebate.trader_id;
    if (!traderId) continue;
    const current = rebatesByTraderUserId.get(traderId) ?? { earned: 0, pending: 0, ib: 0, cpa: 0 };
    const amount = Number(rebate.amount ?? 0);
    if (EARNED_REBATE_STATUSES.includes(rebate.status)) {
      current.earned += amount;
      const kind = rebateKind(rebate);
      if (kind === "IB") current.ib += amount;
      else if (kind === "CPA") current.cpa += amount;
    } else if (rebate.status === "PENDING") {
      current.pending += amount;
    }
    rebatesByTraderUserId.set(traderId, current);
  }
  for (const commission of commissionRows) {
    const traderId = commission.trader_id;
    if (!traderId) continue;
    const current = commissionsByTraderUserId.get(traderId) ?? {
      approved: 0,
      pending: 0,
      paid: 0,
      total: 0,
      grossRevenue: 0,
    };
    const amount = Number(commission.commission_amount ?? 0);
    // Cancelled / reversed commissions are not earnings.
    if (commission.status === "APPROVED") current.approved += amount;
    else if (commission.status === "PENDING") current.pending += amount;
    else if (commission.status === "PAID") current.paid += amount;
    if (commission.status === "PENDING" || commission.status === "APPROVED" || commission.status === "PAID") {
      current.total += amount;
      current.grossRevenue += Number(commission.gross_amount ?? 0);
    }
    commissionsByTraderUserId.set(traderId, current);
  }
  const configs: BrokerConfigRow[] = configRows.map((config) => ({
    ...config,
    brokerProviderId: config.broker_provider_id,
    brokerNames: [config.broker_providers?.display_name, config.broker_providers?.name],
  }));

  return {
    profiles,
    accounts,
    snapshotByAccount,
    openRiskByAccount,
    accountToTraderUserId,
    tradeLotsByTraderUserId,
    rebatesByTraderUserId,
    commissionsByTraderUserId,
    configs,
    allAccountIds,
  };
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

  const brokerNames = [...new Set(traderAccounts.map((acc) => acc.broker_name).filter(Boolean) as string[])];
  const latestSyncAt = newestIso(traderAccounts.map((acc) => acc.last_synced_at));
  const totalLotsTraded = Number((ctx.tradeLotsByTraderUserId.get(profile.user_id) ?? 0).toFixed(2));
  const rebates = ctx.rebatesByTraderUserId.get(profile.user_id) ?? { earned: 0, pending: 0, ib: 0, cpa: 0 };
  const commissions = ctx.commissionsByTraderUserId.get(profile.user_id) ?? {
    approved: 0,
    pending: 0,
    paid: 0,
    total: 0,
    grossRevenue: 0,
  };
  const config = configForAccounts(traderAccounts, ctx.configs);
  // The deposit tier is judged on the accounts the agreement applies to.
  const configAccounts = config
    ? traderAccounts.filter((acc) => pickBrokerConfiguration(ctx.configs, acc.broker_provider_id, acc.broker_name) === config)
    : [];
  const maxDeposit = configAccounts.reduce((max, acc) => Math.max(max, Number(acc.initial_balance ?? 0)), 0);
  // CPA qualification only exists for CPA / Hybrid agreements; a pure IB agreement has no target.
  const hasCpa = config != null && config.model_type !== "IB";
  const qualificationTargetLots = hasCpa ? Number(config.cpa_qualification_lots) : null;
  const cpaQualified = qualificationTargetLots != null && totalLotsTraded > 0 && totalLotsTraded >= qualificationTargetLots;
  const stage = detectPipelineStage({
    accountCount: traderAccounts.length,
    connectedAccounts,
    latestSyncAt,
    totalLots: totalLotsTraded,
    cpaQualified,
  });
  const commissionModel: PartnerCommissionModel = config?.model_type ?? "UNCONFIGURED";

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
    totalLotsTraded,
    commissionModel,
    pipelineStage: stage,
    brokerNames,
    latestSyncAt,
    grossRevenue: { amount: roundMoney(commissions.grossRevenue), currency: "USD" },
    // WSA payout wallet = WSA subscription commission only (broker earnings are reporting).
    approvedWalletContribution: { amount: roundMoney(commissions.approved), currency: "USD" },
    pendingWalletContribution: { amount: roundMoney(commissions.pending), currency: "USD" },
    brokerEarningsApproved: { amount: roundMoney(rebates.earned), currency: "USD" },
    brokerEarningsPending: { amount: roundMoney(rebates.pending), currency: "USD" },
    ibRebateEarned: { amount: roundMoney(rebates.ib), currency: "USD" },
    cpaEarned: { amount: roundMoney(rebates.cpa), currency: "USD" },
    wsaCommissionEarned: { amount: roundMoney(commissions.total), currency: "USD" },
    cpaQualified,
    cpaTierLabel: cpaTierLabel(config, maxDeposit),
    qualificationProgressLots: totalLotsTraded,
    qualificationTargetLots,
    accounts: accountStatuses,
  };
}

export async function getPartnerSummary(partnerUserId: string): Promise<PartnerSummaryDto> {
  await refreshPartnerRebatesIfStale(partnerUserId);
  const ctx = await loadAssignedContext(partnerUserId);
  const traders = ctx.profiles.map((p) => buildTraderDto(p, ctx));

  const totalEquity = traders.reduce((s, t) => s + t.totalEquity.amount, 0);
  const floatingPnl = traders.reduce((s, t) => s + t.floatingPnl.amount, 0);
  const connectedAccounts = traders.reduce((s, t) => s + t.connectedAccounts, 0);
  const openRiskEvents = traders.reduce((s, t) => s + t.openRiskEvents, 0);
  const activeTraders = traders.filter((t) => t.status === "ACTIVE").length;
  const totalTeamLots = traders.reduce((sum, trader) => sum + trader.totalLotsTraded, 0);

  const supabase = createAdminClient();
  const [commission, rebates, { data: profileRow }] = await Promise.all([
    getPartnerCommissionSummary(partnerUserId),
    // Totals over every rebate row (APPROVED + PAID), not just the newest page.
    getPartnerRebateTotals(partnerUserId, "ALL"),
    supabase.from("partner_profiles").select("referral_code").eq("user_id", partnerUserId).maybeSingle(),
  ]);
  const rebateCurrency = rebates.currency || commission.currency;

  return {
    assignedTraders: traders.length,
    activeTraders,
    connectedAccounts,
    totalEquity: { amount: Number(totalEquity.toFixed(2)), currency: "USD" },
    aggregateFloatingPnl: { amount: Number(floatingPnl.toFixed(2)), currency: "USD" },
    openRiskEvents,
    pendingCommission: commission.pending,
    earnedCommission: { amount: roundMoney(commission.approved.amount + commission.paid.amount), currency: commission.currency },
    totalTeamLots: Number(totalTeamLots.toFixed(2)),
    totalRebatesEarned: { amount: rebates.earned, currency: rebateCurrency },
    // IB earnings include manual admin adjustments (everything that is not a CPA payout).
    ibEarnings: { amount: roundMoney(rebates.earned - rebates.cpaEarned), currency: rebateCurrency },
    cpaEarnings: { amount: rebates.cpaEarned, currency: rebateCurrency },
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

export async function listPartnerTradersForAdmin(
  partnerUserId: string,
  filters?: { status?: "ALL" | "ACTIVE" | "AT_RISK" | "RESTRICTED"; search?: string },
): Promise<PartnerTraderDto[]> {
  return listPartnerTraders(partnerUserId, filters);
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
  // One query per 100 accounts (URL length), each limited to the newest 100.
  const batches = await Promise.all(
    chunkArray(ctx.allAccountIds).map(async (ids) => {
      const { data, error } = await supabase
        .from("risk_events")
        .select("id, trading_account_id, rule_name, severity, message, created_at")
        .is("acknowledged_at", null)
        .in("trading_account_id", ids)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(`Failed to fetch risk events: ${error.message}`);
      return data ?? [];
    }),
  );
  const newest = batches
    .flat()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 100);

  return newest.map((r) => {
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
  const batches = await Promise.all(
    chunkArray(profileIds).map(async (ids) => {
      const { data, error } = await supabase
        .from("crm_activities")
        .select("id, trader_profile_id, type, description, created_at")
        .in("trader_profile_id", ids)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(`Failed to fetch activities: ${error.message}`);
      return data ?? [];
    }),
  );
  const newest = batches
    .flat()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 50);

  return newest.map((a) => ({
    id: a.id,
    traderName: nameByProfileId.get(a.trader_profile_id) ?? "Unknown",
    type: a.type,
    description: a.description,
    createdAt: a.created_at,
  }));
}

// ── Commissions (WSA subscription sales) ─────────────────────────────────────

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
  const rows = await selectAllPages<{ commission_amount: number | string; currency: string; status: string }>(
    "Failed to fetch commission summary",
    (from, to) =>
      supabase
        .from("partner_commissions")
        .select("commission_amount, currency, status")
        .eq("partner_id", partnerUserId)
        .order("id")
        .range(from, to),
  );

  // Amounts of different currencies are never added together: the dominant currency is reported.
  const currency = dominantCurrency(rows) ?? "USD";
  let pending = 0;
  let approved = 0;
  let paid = 0;
  for (const row of rows) {
    if ((row.currency ?? "").toUpperCase() !== currency) continue;
    const amt = Number(row.commission_amount);
    if (row.status === "PENDING") pending += amt;
    else if (row.status === "APPROVED") approved += amt;
    else if (row.status === "PAID") paid += amt;
  }
  const rule = await getCommissionRule(partnerUserId);

  return {
    pending: { amount: roundMoney(pending), currency },
    approved: { amount: roundMoney(approved), currency },
    paid: { amount: roundMoney(paid), currency },
    commissionPercent: rule.percent,
    commissionType: rule.type,
    cpaAmount: rule.cpaAmount,
    currency,
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
