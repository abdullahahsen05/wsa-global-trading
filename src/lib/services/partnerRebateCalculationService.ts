import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";
import { chunkArray, selectAllPages, selectAllPagesForIds } from "@/lib/supabase/pagedSelect";
import {
  brokerGroupKey,
  closedAfterAttribution,
  cpaPayoutForDeposit,
  dominantCurrency,
  ibRebateAmount,
  isEligibleLiveAccount,
  pickBrokerConfiguration,
  summarizeRebates,
  symbolClass,
  type BrokerConfigCandidate,
  type PartnerModelType,
  type RebateRowLike,
  type RebateTotals,
  type RebateView,
} from "@/lib/partner/rebateRules";

// ─────────────────────────────────────────────────────────────────────────────
// Partner broker earnings (IB per lot / CPA / Hybrid).
//
// The terms an admin enters per partner and per broker live in
// `partner_broker_configurations`; every closed trade of an attributed trader
// then produces one `partner_rebates` row (IB) and — once per qualified client —
// one CPA row. The maths is in `lib/partner/rebateRules.ts`; this file adds the
// database around it.
//
// SHARED: `calculatePartnerRebatesForTradingAccounts` runs inside the broker
// sync (AWS workers) — keep it free of Next / React / "server-only" imports.
// Idempotency is load-bearing: unique index (trade_id, calculation_type) and
// the existence check for CPA below.
// ─────────────────────────────────────────────────────────────────────────────

export type { PartnerModelType, RebateTotals, RebateView };

export interface PartnerBrokerConfigurationDto {
  id: string;
  partnerId: string;
  brokerProviderId: string | null;
  brokerName: string;
  modelType: PartnerModelType;
  rebateRatePerLot: number;
  xauusdRatePerLot: number;
  cpaQualificationLots: number;
  cpaTier1Deposit: number;
  cpaTier1Payout: number;
  cpaTier2Deposit: number;
  cpaTier2Payout: number;
  cpaTier3Deposit: number;
  cpaTier3Payout: number;
  currency: string;
  isActive: boolean;
  updatedAt: string;
}

export interface PartnerTradeRebateLogDto {
  id: string;
  traderId: string | null;
  traderName: string | null;
  tradeId: string | null;
  externalTradeId: string | null;
  symbol: string | null;
  lots: number;
  brokerName: string | null;
  modelType: PartnerModelType | null;
  calculationType: "IB_VOLUME" | "CPA_TIER" | "ADMIN_ADJUSTMENT" | null;
  rebateAmount: number;
  ratePerLot: number | null;
  currency: string;
  status: string;
  createdAt: string;
}

export interface PartnerRebateTotalsDto extends RebateTotals {
  currency: string;
}

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

interface ConfigRow {
  id: string;
  partner_id: string;
  broker_provider_id: string | null;
  model_type: PartnerModelType;
  rebate_rate_per_lot: number | string;
  xauusd_rate_per_lot?: number | string | null;
  cpa_qualification_lots: number | string;
  cpa_tier_1_deposit: number | string;
  cpa_tier_1_payout: number | string;
  cpa_tier_2_deposit: number | string;
  cpa_tier_2_payout: number | string;
  cpa_tier_3_deposit: number | string;
  cpa_tier_3_payout: number | string;
  currency: string;
  is_active: boolean;
  updated_at: string;
  broker_providers?: { display_name?: string | null; name?: string | null } | null;
}

type Agreement = ConfigRow & BrokerConfigCandidate;

interface TradeRebateLogRow {
  id: string;
  trader_id: string | null;
  trade_id: string | null;
  source_type: string;
  amount: number | string;
  currency: string;
  status: string;
  created_at: string;
  model_type: PartnerModelType | null;
  calculation_type: "IB_VOLUME" | "CPA_TIER" | "ADMIN_ADJUSTMENT" | null;
  volume_lots: number | string | null;
  rate_per_lot: number | string | null;
  trades?: { external_trade_id?: string | null; symbol?: string | null } | null;
  profiles?: { full_name?: string | null } | null;
  broker_providers?: { display_name?: string | null; name?: string | null } | null;
}

interface AccountScanRow {
  id: string;
  user_id: string | null;
  broker_provider_id: string | null;
  broker_name: string | null;
  initial_balance: number | string | null;
  status: string | null;
  account_usage: string | null;
}

interface AttributionRow {
  user_id: string;
  partner_id: string;
  partner_assigned_at: string | null;
}

interface ClosedTradeRow {
  id: string;
  trading_account_id: string;
  symbol: string | null;
  volume: number | string | null;
  currency: string | null;
  closed_at: string | null;
}

/** An account that earns for a partner, with the agreement that applies to it. */
interface Target {
  account: AccountScanRow;
  partnerId: string;
  assignedAt: string | null;
  agreement: Agreement;
}

const ACCOUNT_COLUMNS =
  "id, user_id, broker_provider_id, broker_name, initial_balance, status, account_usage";

/** Closed trades read per page when scanning for missing rebate rows. */
const TRADE_PAGE = 1000;
/** Upper bound of closed trades inspected per call (per chunk of accounts), newest first. */
const MAX_SCANNED_TRADES = 20_000;
/** Rows per bulk insert. */
const INSERT_BATCH = 50;

function mapConfig(row: ConfigRow): PartnerBrokerConfigurationDto {
  return {
    id: row.id,
    partnerId: row.partner_id,
    brokerProviderId: row.broker_provider_id,
    brokerName: row.broker_providers?.display_name ?? row.broker_providers?.name ?? "All brokers",
    modelType: row.model_type,
    rebateRatePerLot: Number(row.rebate_rate_per_lot),
    xauusdRatePerLot: Number(row.xauusd_rate_per_lot ?? row.rebate_rate_per_lot),
    cpaQualificationLots: Number(row.cpa_qualification_lots),
    cpaTier1Deposit: Number(row.cpa_tier_1_deposit),
    cpaTier1Payout: Number(row.cpa_tier_1_payout),
    cpaTier2Deposit: Number(row.cpa_tier_2_deposit),
    cpaTier2Payout: Number(row.cpa_tier_2_payout),
    cpaTier3Deposit: Number(row.cpa_tier_3_deposit),
    cpaTier3Payout: Number(row.cpa_tier_3_payout),
    currency: row.currency,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}

function toAgreement(row: ConfigRow): Agreement {
  return {
    ...row,
    brokerProviderId: row.broker_provider_id,
    brokerNames: [row.broker_providers?.display_name, row.broker_providers?.name],
  };
}

export async function listPartnerBrokerConfigurations(
  partnerId: string,
): Promise<PartnerBrokerConfigurationDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("partner_broker_configurations")
    .select(
      "id, partner_id, broker_provider_id, model_type, rebate_rate_per_lot, xauusd_rate_per_lot, cpa_qualification_lots, cpa_tier_1_deposit, cpa_tier_1_payout, cpa_tier_2_deposit, cpa_tier_2_payout, cpa_tier_3_deposit, cpa_tier_3_payout, currency, is_active, updated_at, broker_providers(display_name, name)",
    )
    .eq("partner_id", partnerId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Failed to load partner broker configurations: ${error.message}`);
  return ((data ?? []) as unknown as ConfigRow[]).map(mapConfig);
}

export async function upsertPartnerBrokerConfiguration(params: {
  actorUserId: string;
  partnerId: string;
  brokerProviderId: string | null;
  modelType: PartnerModelType;
  rebateRatePerLot: number;
  xauusdRatePerLot: number;
  cpaQualificationLots: number;
  cpaTier1Deposit: number;
  cpaTier1Payout: number;
  cpaTier2Deposit: number;
  cpaTier2Payout: number;
  cpaTier3Deposit: number;
  cpaTier3Payout: number;
  currency: string;
  isActive: boolean;
}): Promise<PartnerBrokerConfigurationDto> {
  const supabase = createAdminClient();
  const row = {
    partner_id: params.partnerId,
    broker_provider_id: params.brokerProviderId,
    model_type: params.modelType,
    rebate_rate_per_lot: params.rebateRatePerLot,
    xauusd_rate_per_lot: params.xauusdRatePerLot,
    cpa_qualification_lots: params.cpaQualificationLots,
    cpa_tier_1_deposit: params.cpaTier1Deposit,
    cpa_tier_1_payout: params.cpaTier1Payout,
    cpa_tier_2_deposit: params.cpaTier2Deposit,
    cpa_tier_2_payout: params.cpaTier2Payout,
    cpa_tier_3_deposit: params.cpaTier3Deposit,
    cpa_tier_3_payout: params.cpaTier3Payout,
    currency: params.currency.toUpperCase(),
    is_active: params.isActive,
    updated_by: params.actorUserId,
  };

  const selectColumns =
    "id, partner_id, broker_provider_id, model_type, rebate_rate_per_lot, xauusd_rate_per_lot, cpa_qualification_lots, cpa_tier_1_deposit, cpa_tier_1_payout, cpa_tier_2_deposit, cpa_tier_2_payout, cpa_tier_3_deposit, cpa_tier_3_payout, currency, is_active, updated_at, broker_providers(display_name, name)";
  const existingQuery = supabase
    .from("partner_broker_configurations")
    .select("id")
    .eq("partner_id", params.partnerId);
  const existing = params.brokerProviderId
    ? await existingQuery.eq("broker_provider_id", params.brokerProviderId).maybeSingle()
    : await existingQuery.is("broker_provider_id", null).maybeSingle();

  let data: unknown;
  let error: { message: string } | null = null;
  if (existing.data?.id) {
    // `created_by` stays with whoever created the agreement.
    const response = await supabase
      .from("partner_broker_configurations")
      .update(row)
      .eq("id", existing.data.id)
      .select(selectColumns)
      .single();
    data = response.data;
    error = response.error;
  } else {
    const response = await supabase
      .from("partner_broker_configurations")
      .insert({ ...row, created_by: params.actorUserId })
      .select(selectColumns)
      .single();
    data = response.data;
    error = response.error;
  }
  if (error || !data) throw new Error(`Failed to save partner broker configuration: ${error?.message}`);

  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "PARTNER_REBATE_STATUS_CHANGED",
    entityType: "partner_broker_configuration",
    entityId: (data as ConfigRow).id,
    metadata: { partnerId: params.partnerId, brokerProviderId: params.brokerProviderId, modelType: params.modelType },
  });

  return mapConfig(data as ConfigRow);
}

/** Newest trade-linked rebate rows (the table on the partner pages). Totals come from `getPartnerRebateTotals`. */
export async function listPartnerTradeRebateLogs(
  partnerId: string,
  limit = 500,
  view: RebateView = "ALL",
): Promise<PartnerTradeRebateLogDto[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("partner_rebates")
    .select(
      "id, trader_id, trade_id, source_type, amount, currency, status, created_at, model_type, calculation_type, volume_lots, rate_per_lot, trades(external_trade_id, symbol), profiles!trader_id(full_name), broker_providers(display_name, name)",
    )
    .eq("partner_id", partnerId);
  if (view === "REBATE") query = query.eq("source_type", "TRADE_VOLUME");
  else if (view === "CPA") query = query.eq("source_type", "CPA_TIER");
  else if (view === "HYBRID") query = query.eq("model_type", "HYBRID").in("source_type", ["TRADE_VOLUME", "CPA_TIER"]);
  else query = query.in("source_type", ["TRADE_VOLUME", "CPA_TIER"]);

  // PostgREST never returns more than 1000 rows per request.
  const { data, error } = await query.order("created_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 1000));
  if (error) throw new Error(`Failed to load partner trade rebates: ${error.message}`);
  return ((data ?? []) as unknown as TradeRebateLogRow[]).map((row) => ({
    id: row.id,
    traderId: row.trader_id,
    traderName: row.profiles?.full_name ?? null,
    tradeId: row.trade_id,
    externalTradeId: row.trades?.external_trade_id ?? null,
    symbol: row.trades?.symbol ?? null,
    lots: Number(row.volume_lots ?? 0),
    brokerName: row.broker_providers?.display_name ?? row.broker_providers?.name ?? null,
    modelType: row.model_type ?? null,
    calculationType: row.calculation_type ?? null,
    rebateAmount: Number(row.amount),
    ratePerLot: row.rate_per_lot == null ? null : Number(row.rate_per_lot),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/**
 * Totals over EVERY rebate row of a partner (not just the newest 1000): earned
 * (APPROVED + PAID), pending, IB / CPA split, lots, distinct clients and brokers.
 * Rows in a second currency are left out so amounts are never added across currencies.
 */
export async function getPartnerRebateTotals(
  partnerId: string,
  view: RebateView = "ALL",
): Promise<PartnerRebateTotalsDto> {
  const supabase = createAdminClient();
  const rows = await selectAllPages<RebateRowLike & { currency?: string | null }>(
    "Failed to load partner rebate totals",
    (from, to) =>
      supabase
        .from("partner_rebates")
        .select("amount, currency, status, calculation_type, source_type, model_type, volume_lots, trader_id, broker_provider_id")
        .eq("partner_id", partnerId)
        .order("id")
        .range(from, to),
  );
  const currency = dominantCurrency(rows);
  const scoped = currency ? rows.filter((row) => (row.currency ?? "").toUpperCase() === currency) : rows;
  return { ...summarizeRebates(scoped, view), currency: currency ?? "USD" };
}

/** Calculates any missing rebate rows for every live account of the partner's traders. */
export async function ensurePartnerRebateLedgerCurrent(
  partnerId: string,
): Promise<{ created: number; scannedTrades: number; accounts: number }> {
  const supabase = createAdminClient();
  const profiles = await selectAllPages<{ user_id: string }>(
    "Failed to load assigned traders for rebate refresh",
    (from, to) =>
      supabase
        .from("trader_profiles")
        .select("user_id")
        .eq("partner_id", partnerId)
        .order("user_id")
        .range(from, to),
  );
  const traderIds = [...new Set(profiles.map((profile) => profile.user_id).filter(Boolean))];
  if (traderIds.length === 0) return { created: 0, scannedTrades: 0, accounts: 0 };

  const accounts = await selectAllPagesForIds<{ id: string }>(
    "Failed to load live accounts for rebate refresh",
    traderIds,
    (ids, from, to) =>
      supabase
        .from("trading_accounts")
        .select("id")
        .in("user_id", ids)
        .eq("status", "CONNECTED")
        .in("account_usage", ["TRADER", "COPY_MASTER"])
        .order("id")
        .range(from, to),
  );
  const accountIds = [...new Set(accounts.map((account) => account.id).filter(Boolean))];
  if (accountIds.length === 0) return { created: 0, scannedTrades: 0, accounts: 0 };
  const result = await calculatePartnerRebatesForTradingAccounts(accountIds);
  return { ...result, accounts: accountIds.length };
}

/** The broker sync creates missing rows too; the page-side refresh is only a safety net. */
const REFRESH_INTERVAL_MS = 60_000;
const lastRefreshAt = new Map<string, number>();

/**
 * Safety-net refresh used by the partner pages: creates missing rebate rows at
 * most once a minute per partner (per server instance) and never fails the page
 * — the rows already stored are still correct when the refresh cannot run.
 */
export async function refreshPartnerRebatesIfStale(partnerId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastRefreshAt.get(partnerId) ?? 0) < REFRESH_INTERVAL_MS) return;
  lastRefreshAt.set(partnerId, now);
  try {
    await ensurePartnerRebateLedgerCurrent(partnerId);
  } catch (error) {
    console.error(
      "[partner rebates] refresh failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function rebateRateForSymbol(config: ConfigRow, symbol: string | null | undefined): number {
  if (symbolClass(symbol) === "XAUUSD") {
    return Number(config.xauusd_rate_per_lot ?? config.rebate_rate_per_lot);
  }
  return Number(config.rebate_rate_per_lot);
}

function cpaTiersOf(config: ConfigRow) {
  return [
    { deposit: Number(config.cpa_tier_1_deposit), payout: Number(config.cpa_tier_1_payout) },
    { deposit: Number(config.cpa_tier_2_deposit), payout: Number(config.cpa_tier_2_payout) },
    { deposit: Number(config.cpa_tier_3_deposit), payout: Number(config.cpa_tier_3_payout) },
  ];
}

/**
 * Inserts rebate rows in batches. A unique violation (23505) means a parallel
 * run already created some of them: the batch is then retried row by row so
 * every missing row still lands and duplicates are skipped silently.
 */
async function insertRebateRows(
  supabase: SupabaseAdmin,
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  let created = 0;
  for (const batch of chunkArray(rows, INSERT_BATCH)) {
    const { error } = await supabase.from("partner_rebates").insert(batch);
    if (!error) {
      created += batch.length;
      continue;
    }
    if (error.code !== "23505") throw new Error(`Failed to create partner rebates: ${error.message}`);
    for (const row of batch) {
      const single = await supabase.from("partner_rebates").insert(row);
      if (!single.error) created += 1;
      else if (single.error.code !== "23505") {
        throw new Error(`Failed to create partner rebate: ${single.error.message}`);
      }
    }
  }
  return created;
}

/**
 * Creates the missing IB / CPA rows for the closed trades of the given trading
 * accounts. Safe to call as often as you like (every sync): nothing is created
 * twice, and accounts of traders without a partner or without an agreement cost
 * only a handful of small queries.
 */
export async function calculatePartnerRebatesForTradingAccounts(
  tradingAccountIds: string[],
): Promise<{ created: number; scannedTrades: number }> {
  const accountIds = [...new Set(tradingAccountIds.filter(Boolean))];
  if (accountIds.length === 0) return { created: 0, scannedTrades: 0 };

  const supabase = createAdminClient();
  let created = 0;
  let scannedTrades = 0;
  for (const idChunk of chunkArray(accountIds, 100)) {
    const result = await calculateForAccountChunk(supabase, idChunk);
    created += result.created;
    scannedTrades += result.scannedTrades;
  }
  return { created, scannedTrades };
}

async function calculateForAccountChunk(
  supabase: SupabaseAdmin,
  accountIds: string[],
): Promise<{ created: number; scannedTrades: number }> {
  const nothing = { created: 0, scannedTrades: 0 };

  // 1. Live accounts only (connected, TRADER / COPY_MASTER).
  const accounts = await selectAllPagesForIds<AccountScanRow>(
    "Failed to load accounts for partner rebates",
    accountIds,
    (ids, from, to) =>
      supabase.from("trading_accounts").select(ACCOUNT_COLUMNS).in("id", ids).order("id").range(from, to),
  );
  const liveAccounts = accounts.filter((account) => Boolean(account.user_id) && isEligibleLiveAccount(account));
  if (liveAccounts.length === 0) return nothing;

  // 2. Which of those traders belong to a partner (and since when).
  const traderIds = [...new Set(liveAccounts.map((account) => account.user_id as string))];
  const attributions = await selectAllPagesForIds<AttributionRow>(
    "Failed to load trader attribution for partner rebates",
    traderIds,
    (ids, from, to) =>
      supabase
        .from("trader_profiles")
        .select("user_id, partner_id, partner_assigned_at")
        .in("user_id", ids)
        .not("partner_id", "is", null)
        .order("user_id")
        .range(from, to),
  );
  if (attributions.length === 0) return nothing;
  const attributionByTrader = new Map(attributions.map((row) => [row.user_id, row]));

  // 3. The partners' active agreements.
  const partnerIds = [...new Set(attributions.map((row) => row.partner_id))];
  const configRows = await selectAllPagesForIds<ConfigRow>(
    "Failed to load partner agreements",
    partnerIds,
    (ids, from, to) =>
      supabase
        .from("partner_broker_configurations")
        .select("*, broker_providers(display_name, name)")
        .in("partner_id", ids)
        .eq("is_active", true)
        .order("id")
        .range(from, to),
  );
  if (configRows.length === 0) return nothing;
  const agreementsByPartner = new Map<string, Agreement[]>();
  for (const row of configRows) {
    const list = agreementsByPartner.get(row.partner_id) ?? [];
    list.push(toAgreement(row));
    agreementsByPartner.set(row.partner_id, list);
  }

  // 4. Account → partner agreement that applies to it.
  const targets = new Map<string, Target>();
  for (const account of liveAccounts) {
    const attribution = attributionByTrader.get(account.user_id as string);
    if (!attribution) continue;
    const agreement = pickBrokerConfiguration(
      agreementsByPartner.get(attribution.partner_id) ?? [],
      account.broker_provider_id,
      account.broker_name,
    );
    if (!agreement) continue;
    targets.set(account.id, {
      account,
      partnerId: attribution.partner_id,
      assignedAt: attribution.partner_assigned_at,
      agreement,
    });
  }
  if (targets.size === 0) return nothing;

  // 5. Closed trades since the earliest attribution, newest first, one page at
  //    a time. Rows are created newest first, so a page that needs nothing means
  //    everything older is up to date as well: a normal sync reads one or two
  //    pages, while a backlog (agreement added later, workers were off) is worked
  //    off page by page, up to MAX_SCANNED_TRADES per call.
  const assignedDates = [...targets.values()].map((target) => target.assignedAt);
  const earliestAssigned = assignedDates.every(Boolean)
    ? new Date(Math.min(...assignedDates.map((value) => Date.parse(value as string)))).toISOString()
    : null;
  const now = new Date().toISOString();
  let created = 0;
  let scannedTrades = 0;
  for (const idChunk of chunkArray([...targets.keys()])) {
    for (let from = 0; from < MAX_SCANNED_TRADES; from += TRADE_PAGE) {
      let query = supabase
        .from("trades")
        .select("id, trading_account_id, symbol, volume, currency, closed_at")
        .in("trading_account_id", idChunk)
        .eq("status", "CLOSED")
        .not("closed_at", "is", null);
      if (earliestAssigned) query = query.gte("closed_at", earliestAssigned);
      const { data, error } = await query
        .order("closed_at", { ascending: false })
        .order("id")
        .range(from, from + TRADE_PAGE - 1);
      if (error) throw new Error(`Failed to scan partner rebate trades: ${error.message}`);
      const page = (data ?? []) as unknown as ClosedTradeRow[];
      scannedTrades += page.length;

      // Balance / deposit rows (volume 0) and trades from before the client joined earn nothing.
      const trades = page.filter((trade) => {
        const target = targets.get(trade.trading_account_id);
        return (
          Boolean(target)
          && Math.abs(Number(trade.volume ?? 0)) > 0
          && closedAfterAttribution(trade.closed_at, target?.assignedAt)
        );
      });
      let pageCreated = 0;
      if (trades.length > 0) {
        pageCreated += await createIbRebates(supabase, targets, trades, now);
        // CPA is once per client: look at it on the newest page, and on older pages only while a backlog is being worked off.
        if (from === 0 || pageCreated > 0) pageCreated += await createCpaPayouts(supabase, targets, trades, now);
      }
      created += pageCreated;
      if (page.length < TRADE_PAGE || pageCreated === 0) break;
    }
  }
  return { created, scannedTrades };
}

async function createIbRebates(
  supabase: SupabaseAdmin,
  targets: Map<string, Target>,
  trades: ClosedTradeRow[],
  now: string,
): Promise<number> {
  const candidates = trades.filter((trade) => {
    const model = targets.get(trade.trading_account_id)?.agreement.model_type;
    return model === "IB" || model === "HYBRID";
  });
  if (candidates.length === 0) return 0;

  // Trades that already earned are skipped here, so a sync costs one small query per 100 trades.
  const done = await selectAllPagesForIds<{ trade_id: string }>(
    "Failed to check existing partner rebates",
    candidates.map((trade) => trade.id),
    (ids, from, to) =>
      supabase
        .from("partner_rebates")
        .select("trade_id")
        .in("trade_id", ids)
        .eq("calculation_type", "IB_VOLUME")
        .order("trade_id")
        .range(from, to),
  );
  const alreadyRebated = new Set(done.map((row) => row.trade_id));

  const rows: Array<Record<string, unknown>> = [];
  for (const trade of candidates) {
    if (alreadyRebated.has(trade.id)) continue;
    const target = targets.get(trade.trading_account_id);
    if (!target) continue;
    const lots = Math.abs(Number(trade.volume ?? 0));
    const ratePerLot = rebateRateForSymbol(target.agreement, trade.symbol);
    const amount = ibRebateAmount(lots, ratePerLot);
    if (amount <= 0) continue;
    const resolvedClass = symbolClass(trade.symbol);
    const brokerProviderId = target.account.broker_provider_id ?? null;
    rows.push({
      partner_id: target.partnerId,
      trader_id: target.account.user_id,
      trade_id: trade.id,
      broker_provider_id: brokerProviderId,
      configuration_id: target.agreement.id,
      model_type: target.agreement.model_type,
      calculation_type: "IB_VOLUME",
      source_type: "TRADE_VOLUME",
      amount,
      currency: (target.agreement.currency || trade.currency || "USD").toUpperCase(),
      status: "APPROVED",
      approved_at: now,
      volume_lots: lots,
      rate_per_lot: ratePerLot,
      description: `${resolvedClass} ${lots} lot(s) × ${ratePerLot.toFixed(2)} per lot`,
      metadata: { tradeId: trade.id, symbol: trade.symbol, symbolClass: resolvedClass, brokerProviderId },
    });
  }
  return insertRebateRows(supabase, rows);
}

/**
 * One CPA payout per partner / client / broker, ever. The database index on
 * (partner, trader, broker, CPA) cannot stop a second payout when the account
 * has no broker provider (NULLs are distinct in a unique index), so existence
 * is checked here — cancelled rows count too, so an admin's cancellation sticks.
 */
async function createCpaPayouts(
  supabase: SupabaseAdmin,
  targets: Map<string, Target>,
  trades: ClosedTradeRow[],
  now: string,
): Promise<number> {
  interface Candidate {
    target: Target;
    traderId: string;
    groupKey: string;
    qualifyingTradeId: string;
  }
  const candidates = new Map<string, Candidate>();
  for (const trade of trades) {
    const target = targets.get(trade.trading_account_id);
    if (!target || target.agreement.model_type === "IB") continue;
    const traderId = target.account.user_id as string;
    const groupKey = brokerGroupKey(target.account);
    const key = `${target.partnerId}|${traderId}|${groupKey}`;
    // `trades` is newest first: the first one seen is the newest qualifying trade.
    if (!candidates.has(key)) candidates.set(key, { target, traderId, groupKey, qualifyingTradeId: trade.id });
  }
  if (candidates.size === 0) return 0;

  const cpaKey = (partnerId: string, traderId: string, providerId: string | null) =>
    `${partnerId}|${traderId}|${providerId ?? "none"}`;
  const existing = await selectAllPagesForIds<{
    partner_id: string;
    trader_id: string;
    broker_provider_id: string | null;
  }>(
    "Failed to check existing CPA payouts",
    [...new Set([...candidates.values()].map((candidate) => candidate.traderId))],
    (ids, from, to) =>
      supabase
        .from("partner_rebates")
        .select("partner_id, trader_id, broker_provider_id")
        .eq("calculation_type", "CPA_TIER")
        .in("trader_id", ids)
        .order("id")
        .range(from, to),
  );
  const paidOnce = new Set(existing.map((row) => cpaKey(row.partner_id, row.trader_id, row.broker_provider_id)));

  const open = [...candidates.values()].filter(
    (candidate) =>
      !paidOnce.has(cpaKey(candidate.target.partnerId, candidate.traderId, candidate.target.account.broker_provider_id)),
  );
  if (open.length === 0) return 0;

  // The deposit tier comes from the client's accounts at that broker; load them once per client.
  const traderAccounts = await selectAllPagesForIds<AccountScanRow>(
    "Failed to load client accounts for CPA",
    [...new Set(open.map((candidate) => candidate.traderId))],
    (ids, from, to) =>
      supabase
        .from("trading_accounts")
        .select(ACCOUNT_COLUMNS)
        .in("user_id", ids)
        .eq("status", "CONNECTED")
        .in("account_usage", ["TRADER", "COPY_MASTER"])
        .order("id")
        .range(from, to),
  );
  const accountsByTrader = new Map<string, AccountScanRow[]>();
  for (const account of traderAccounts) {
    if (!account.user_id) continue;
    const list = accountsByTrader.get(account.user_id) ?? [];
    list.push(account);
    accountsByTrader.set(account.user_id, list);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const candidate of open) {
    const { target, traderId } = candidate;
    const providerId = target.account.broker_provider_id ?? null;
    const key = cpaKey(target.partnerId, traderId, providerId);
    if (paidOnce.has(key)) continue; // another account of the same client was just handled

    const brokerAccounts = (accountsByTrader.get(traderId) ?? []).filter(
      (account) => brokerGroupKey(account) === candidate.groupKey,
    );
    const deposit = brokerAccounts.reduce(
      (max, account) => Math.max(max, Number(account.initial_balance ?? 0)),
      0,
    );
    const payout = cpaPayoutForDeposit(cpaTiersOf(target.agreement), deposit);
    if (payout <= 0) continue; // deposit below tier 1: no need to count lots

    const closed = await selectAllPagesForIds<{ volume: number | string | null; closed_at: string | null }>(
      "Failed to total client lots for CPA",
      brokerAccounts.map((account) => account.id),
      (ids, from, to) =>
        supabase
          .from("trades")
          .select("volume, closed_at")
          .in("trading_account_id", ids)
          .eq("status", "CLOSED")
          .not("closed_at", "is", null)
          .order("id")
          .range(from, to),
    );
    const totalLots = closed
      .filter((trade) => closedAfterAttribution(trade.closed_at, target.assignedAt))
      .reduce((sum, trade) => sum + Math.abs(Number(trade.volume ?? 0)), 0);
    const qualificationLots = Number(target.agreement.cpa_qualification_lots);
    if (totalLots <= 0 || totalLots < qualificationLots) continue;

    paidOnce.add(key);
    rows.push({
      partner_id: target.partnerId,
      trader_id: traderId,
      trade_id: candidate.qualifyingTradeId,
      broker_provider_id: providerId,
      configuration_id: target.agreement.id,
      model_type: target.agreement.model_type,
      calculation_type: "CPA_TIER",
      source_type: "CPA_TIER",
      amount: payout,
      currency: target.agreement.currency.toUpperCase(),
      status: "APPROVED",
      approved_at: now,
      volume_lots: Number(totalLots.toFixed(4)),
      qualification_lots: qualificationLots,
      description: `CPA qualified at ${Number(totalLots.toFixed(2))} lot(s) and ${deposit.toFixed(2)} deposit tier`,
      metadata: { qualifyingTradeId: candidate.qualifyingTradeId, totalLots, deposit, brokerProviderId: providerId },
    });
  }
  return insertRebateRows(supabase, rows);
}
