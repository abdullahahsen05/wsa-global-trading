import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";

export type PartnerModelType = "IB" | "CPA" | "HYBRID";

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

interface ClosedTradeScanRow {
  id: string;
  trading_account_id: string;
  symbol: string | null;
  status: string;
  volume: number | string | null;
  profit: number | string | null;
  currency: string | null;
  closed_at: string | null;
  trading_accounts?: {
    user_id?: string | null;
    broker_provider_id?: string | null;
    broker_name?: string | null;
    initial_balance?: number | string | null;
    status?: string | null;
    account_usage?: string | null;
  } | null;
}

interface TraderVolumeRow {
  volume: number | string | null;
  trading_accounts?: {
    account_usage?: string | null;
    status?: string | null;
  } | null;
}

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

function normalizeBrokerName(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    .order("updated_at", { ascending: false });
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
    created_by: params.actorUserId,
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
      .insert(row)
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

export async function listPartnerTradeRebateLogs(
  partnerId: string,
  limit = 500,
): Promise<PartnerTradeRebateLogDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("partner_rebates")
    .select(
      "id, trader_id, trade_id, source_type, amount, currency, status, created_at, model_type, calculation_type, volume_lots, rate_per_lot, trades(external_trade_id, symbol), profiles!trader_id(full_name), broker_providers(display_name, name)",
    )
    .eq("partner_id", partnerId)
    .in("source_type", ["TRADE_VOLUME", "CPA_TIER"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load partner trade rebates: ${error.message}`);
  return ((data ?? []) as TradeRebateLogRow[]).map((row) => ({
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

export async function ensurePartnerRebateLedgerCurrent(
  partnerId: string,
): Promise<{ created: number; scannedTrades: number; accounts: number }> {
  const supabase = createAdminClient();
  const { data: profiles, error: profileError } = await supabase
    .from("trader_profiles")
    .select("user_id")
    .eq("partner_id", partnerId)
    .limit(1000);
  if (profileError) throw new Error(`Failed to load assigned traders for rebate refresh: ${profileError.message}`);

  const traderIds = [...new Set((profiles ?? []).map((profile) => profile.user_id as string).filter(Boolean))];
  if (traderIds.length === 0) return { created: 0, scannedTrades: 0, accounts: 0 };

  const { data: accounts, error: accountError } = await supabase
    .from("trading_accounts")
    .select("id")
    .in("user_id", traderIds)
    .eq("status", "CONNECTED")
    .in("account_usage", ["TRADER", "COPY_MASTER"])
    .limit(2000);
  if (accountError) throw new Error(`Failed to load live accounts for rebate refresh: ${accountError.message}`);

  const accountIds = [...new Set((accounts ?? []).map((account) => account.id as string).filter(Boolean))];
  if (accountIds.length === 0) return { created: 0, scannedTrades: 0, accounts: 0 };
  const result = await calculatePartnerRebatesForTradingAccounts(accountIds);
  return { ...result, accounts: accountIds.length };
}

function cpaPayout(config: ConfigRow, deposit: number): number {
  if (deposit >= Number(config.cpa_tier_3_deposit)) return Number(config.cpa_tier_3_payout);
  if (deposit >= Number(config.cpa_tier_2_deposit)) return Number(config.cpa_tier_2_payout);
  if (deposit >= Number(config.cpa_tier_1_deposit)) return Number(config.cpa_tier_1_payout);
  return 0;
}

function isEligibleLiveCommissionAccount(
  account: ClosedTradeScanRow["trading_accounts"] | TraderVolumeRow["trading_accounts"],
): boolean {
  if (!account) return false;
  if ((account.status ?? "").toUpperCase() !== "CONNECTED") return false;
  const usage = (account.account_usage ?? "TRADER").toUpperCase();
  return usage === "TRADER" || usage === "COPY_MASTER";
}

function symbolClass(symbol: string | null | undefined): "XAUUSD" | "FOREX" {
  const normalized = (symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return normalized.includes("XAUUSD") ? "XAUUSD" : "FOREX";
}

function rebateRateForSymbol(config: ConfigRow, symbol: string | null | undefined): number {
  if (symbolClass(symbol) === "XAUUSD") {
    return Number(config.xauusd_rate_per_lot ?? config.rebate_rate_per_lot);
  }
  return Number(config.rebate_rate_per_lot);
}

async function findConfig(
  supabase: SupabaseAdmin,
  partnerId: string,
  brokerProviderId: string | null,
  brokerName?: string | null,
): Promise<ConfigRow | null> {
  if (brokerProviderId) {
    const { data } = await supabase
      .from("partner_broker_configurations")
      .select("*, broker_providers(display_name, name)")
      .eq("partner_id", partnerId)
      .eq("broker_provider_id", brokerProviderId)
      .eq("is_active", true)
      .maybeSingle();
    if (data) return data as ConfigRow;
  }

  const normalizedBrokerName = normalizeBrokerName(brokerName);
  if (normalizedBrokerName) {
    const { data } = await supabase
      .from("partner_broker_configurations")
      .select("*, broker_providers(display_name, name)")
      .eq("partner_id", partnerId)
      .eq("is_active", true)
      .not("broker_provider_id", "is", null);
    const matched = ((data ?? []) as unknown as ConfigRow[]).find((config) => {
      const displayName = normalizeBrokerName(config.broker_providers?.display_name);
      const name = normalizeBrokerName(config.broker_providers?.name);
      return displayName === normalizedBrokerName || name === normalizedBrokerName;
    });
    if (matched) return matched;
  }

  const { data } = await supabase
    .from("partner_broker_configurations")
    .select("*")
    .eq("partner_id", partnerId)
    .is("broker_provider_id", null)
    .eq("is_active", true)
    .maybeSingle();
  return (data as ConfigRow | null) ?? null;
}

export async function calculatePartnerRebatesForTradingAccounts(
  tradingAccountIds: string[],
): Promise<{ created: number; scannedTrades: number }> {
  const accountIds = [...new Set(tradingAccountIds.filter(Boolean))];
  if (accountIds.length === 0) return { created: 0, scannedTrades: 0 };

  const supabase = createAdminClient();
  const { data: trades, error } = await supabase
    .from("trades")
    .select("id, trading_account_id, symbol, status, volume, profit, currency, closed_at, trading_accounts(user_id, broker_provider_id, broker_name, initial_balance, status, account_usage)")
    .in("trading_account_id", accountIds)
    .eq("status", "CLOSED")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Failed to scan partner rebate trades: ${error.message}`);

  let created = 0;
  const now = new Date().toISOString();

  for (const trade of (trades ?? []) as ClosedTradeScanRow[]) {
    const account = trade.trading_accounts;
    if (!account) continue;
    if (!isEligibleLiveCommissionAccount(account)) continue;
    const traderId = account.user_id as string | undefined;
    if (!traderId) continue;

    const { data: traderProfile } = await supabase
      .from("trader_profiles")
      .select("partner_id")
      .eq("user_id", traderId)
      .maybeSingle();
    const partnerId = traderProfile?.partner_id as string | null | undefined;
    if (!partnerId) continue;

    const brokerProviderId = (account?.broker_provider_id as string | null) ?? null;
    const config = await findConfig(supabase, partnerId, brokerProviderId, account.broker_name);
    if (!config) continue;

    const volumeLots = Math.abs(Number(trade.volume ?? 0));
    if (volumeLots <= 0) continue;

    if (config.model_type === "IB" || config.model_type === "HYBRID") {
      const ratePerLot = rebateRateForSymbol(config, trade.symbol);
      const resolvedSymbolClass = symbolClass(trade.symbol);
      const amount = Number((volumeLots * ratePerLot).toFixed(2));
      if (amount > 0) {
        const { error: insertError } = await supabase.from("partner_rebates").insert({
          partner_id: partnerId,
          trader_id: traderId,
          trade_id: trade.id,
          broker_provider_id: brokerProviderId,
          configuration_id: config.id,
          model_type: config.model_type,
          calculation_type: "IB_VOLUME",
          source_type: "TRADE_VOLUME",
          amount,
          currency: (config.currency || trade.currency || "USD").toUpperCase(),
          status: "APPROVED",
          approved_at: now,
          volume_lots: volumeLots,
          rate_per_lot: ratePerLot,
          description: `${resolvedSymbolClass} ${volumeLots} lot(s) × ${ratePerLot.toFixed(2)} per lot`,
          metadata: { tradeId: trade.id, symbol: trade.symbol, symbolClass: resolvedSymbolClass, brokerProviderId },
        });
        if (!insertError) created++;
        else if ((insertError as { code?: string }).code !== "23505") {
          throw new Error(`Failed to create IB rebate: ${insertError.message}`);
        }
      }
    }

    if (config.model_type === "CPA" || config.model_type === "HYBRID") {
      let traderTradesQuery = supabase
        .from("trades")
        .select("volume, trading_accounts!inner(user_id, broker_provider_id, broker_name, status, account_usage)")
        .eq("status", "CLOSED")
        .eq("trading_accounts.user_id", traderId);
      traderTradesQuery = brokerProviderId
        ? traderTradesQuery.eq("trading_accounts.broker_provider_id", brokerProviderId)
        : account.broker_name
          ? traderTradesQuery.ilike("trading_accounts.broker_name", account.broker_name)
          : traderTradesQuery.is("trading_accounts.broker_provider_id", null);
      const { data: traderTrades } = await traderTradesQuery;
      const totalLots = ((traderTrades ?? []) as TraderVolumeRow[])
        .filter((row) => isEligibleLiveCommissionAccount(row.trading_accounts))
        .reduce(
        (sum, row) => sum + Math.abs(Number(row.volume ?? 0)),
        0,
      );
      if (totalLots < Number(config.cpa_qualification_lots)) continue;
      const deposit = Number(account.initial_balance ?? 0);
      const amount = cpaPayout(config, deposit);
      if (amount <= 0) continue;
      const { error: insertError } = await supabase.from("partner_rebates").insert({
        partner_id: partnerId,
        trader_id: traderId,
        trade_id: trade.id,
        broker_provider_id: brokerProviderId,
        configuration_id: config.id,
        model_type: config.model_type,
        calculation_type: "CPA_TIER",
        source_type: "CPA_TIER",
        amount,
        currency: config.currency.toUpperCase(),
        status: "APPROVED",
        approved_at: now,
        volume_lots: totalLots,
        qualification_lots: Number(config.cpa_qualification_lots),
        description: `CPA qualified at ${Number(totalLots.toFixed(2))} lot(s) and ${deposit.toFixed(2)} deposit tier`,
        metadata: { qualifyingTradeId: trade.id, totalLots, deposit, brokerProviderId },
      });
      if (!insertError) created++;
      else if ((insertError as { code?: string }).code !== "23505") {
        throw new Error(`Failed to create CPA rebate: ${insertError.message}`);
      }
    }
  }

  return { created, scannedTrades: trades?.length ?? 0 };
}
