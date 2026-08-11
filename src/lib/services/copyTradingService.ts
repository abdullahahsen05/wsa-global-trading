import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";
import { calculateFollowerLot } from "@/lib/copy/lotScaling";
import { evaluateFollowerEligibility } from "@/lib/copy/eligibility";
import { BrokerExecutionError, type BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import { createBrokerAdapter, getBrokerProviderId } from "@/lib/broker/provider";
import { logBrokerOperation } from "@/lib/services/brokerOperationLog";
import { getRiskEnforcementState } from "@/lib/services/riskService";
import {
  copyModeToScalingMode,
  mapFollowerSymbol,
  reverseFollowerSide,
  scalingModeToCopyMode,
} from "@/lib/copy/settings";
import {
  COPY_ERROR,
  CopyError,
  type CopyFollowerDto,
  type CopyGlobalSettingsDto,
  type CopyAccountRuleDto,
  type CopyRuleEventDto,
  type CopyLogDto,
  type CopyStrategyDto,
  type MasterEventDto,
  type ScalingMode,
} from "@/lib/copy/types";
import { markExecutionPriority } from "@/lib/copy/executionPriority";

function copyTimingEnabled(): boolean {
  return process.env.WSA_COPY_TIMING_LOGS !== "false";
}

function timingLabel(eventId: string): string {
  return eventId.slice(0, 8);
}

function logCopyTiming(eventId: string, stage: string, startedAt: number, extra?: unknown) {
  if (!copyTimingEnabled()) return;
  const elapsedMs = Date.now() - startedAt;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[copy-timing:${timingLabel(eventId)}] ${stage} +${elapsedMs}ms${suffix}`);
}

type RuntimeCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

function copyRuntimeCacheMs(): number {
  const parsed = Number.parseInt(process.env.WSA_COPY_RUNTIME_CACHE_MS ?? "300000", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 300_000;
  return Math.min(parsed, 600_000);
}

async function getRuntimeCached<T>(
  cache: Map<string, RuntimeCacheEntry<T>>,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const ttl = copyRuntimeCacheMs();
  if (ttl > 0) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const value = await loader();
  if (ttl > 0) {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
  }
  return value;
}

const settingsRuntimeCache = new Map<string, RuntimeCacheEntry<CopyGlobalSettingsDto>>();
const strategyRuntimeCache = new Map<string, RuntimeCacheEntry<StrategyRow>>();
const followersRuntimeCache = new Map<string, RuntimeCacheEntry<FollowerRow[]>>();
type StrategyHotRuntime = {
  strategy: StrategyRow;
  settings: CopyGlobalSettingsDto;
  followers: FollowerRow[];
  masterSnap: SnapshotLite | null;
  accountRules: Map<string, AccountRuleRuntime>;
  statusByAccount: Map<string, string>;
  followerRuntimeByAccount: Map<string, {
    snapshot: SnapshotLite | null;
    generalRiskState: Awaited<ReturnType<typeof getRiskEnforcementState>>;
    risk: AccountRiskRuntime;
  }>;
};
const strategyHotRuntimeCache = new Map<string, RuntimeCacheEntry<StrategyHotRuntime>>();
const snapshotRuntimeCache = new Map<string, RuntimeCacheEntry<SnapshotLite | null>>();
const accountRulesRuntimeCache = new Map<string, RuntimeCacheEntry<Map<string, AccountRuleRuntime>>>();
const accountStatusRuntimeCache = new Map<string, RuntimeCacheEntry<Map<string, string>>>();
const accountRiskRuntimeCache = new Map<string, RuntimeCacheEntry<AccountRiskRuntime>>();
const generalRiskRuntimeCache = new Map<string, RuntimeCacheEntry<Awaited<ReturnType<typeof getRiskEnforcementState>>>>();
const inFlightUltraCopyKeys = new Set<string>();

function ultraPremiumCopyEnabled(): boolean {
  return getBrokerProviderId() === "api2trade" && process.env.WSA_COPY_PREMIUM_ULTRA_FAST !== "false";
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy Trading Service (server-only). All access is via the service-role admin
// client; routes gate with requireAdmin()/requireTrader() and trader functions
// filter by the authenticated trader_id. Simulation-first; live execution is
// guarded and currently unconfigured (see executeCopyForEvent).
// ─────────────────────────────────────────────────────────────────────────────

// ── Global settings ──────────────────────────────────────────────────────────

export async function getCopyGlobalSettings(): Promise<CopyGlobalSettingsDto> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("copy_global_settings")
    .select("copy_enabled, live_copy_enabled, emergency_stop_enabled, max_daily_loss_percent, max_drawdown_percent, max_copied_open_positions, max_lot_size, max_slippage_points, pause_on_disconnect, updated_at")
    .eq("id", true)
    .maybeSingle();
  return {
    copyEnabled: data?.copy_enabled ?? true,
    liveCopyEnabled: data?.live_copy_enabled ?? false,
    emergencyStopEnabled: data?.emergency_stop_enabled ?? false,
    maxDailyLossPercent: data?.max_daily_loss_percent == null ? null : Number(data.max_daily_loss_percent),
    maxDrawdownPercent: data?.max_drawdown_percent == null ? null : Number(data.max_drawdown_percent),
    maxCopiedOpenPositions: data?.max_copied_open_positions ?? null,
    maxLotSize: data?.max_lot_size == null ? null : Number(data.max_lot_size),
    maxSlippagePoints: data?.max_slippage_points == null ? null : Number(data.max_slippage_points),
    pauseOnDisconnect: data?.pause_on_disconnect ?? true,
    updatedAt: data?.updated_at ?? new Date(0).toISOString(),
  };
}

async function getCopyGlobalSettingsCached(): Promise<CopyGlobalSettingsDto> {
  return getRuntimeCached(settingsRuntimeCache, "global", getCopyGlobalSettings);
}

export async function updateCopyGlobalSettings(
  patch: Partial<Omit<CopyGlobalSettingsDto, "updatedAt">>,
  actorUserId: string,
): Promise<CopyGlobalSettingsDto> {
  const supabase = createAdminClient();
  const row: Record<string, unknown> = { id: true, updated_by: actorUserId };
  if (patch.liveCopyEnabled !== undefined) row.live_copy_enabled = patch.liveCopyEnabled;
  if (patch.emergencyStopEnabled !== undefined) row.emergency_stop_enabled = patch.emergencyStopEnabled;
  if (patch.copyEnabled !== undefined) row.copy_enabled = patch.copyEnabled;
  if (patch.maxDailyLossPercent !== undefined) row.max_daily_loss_percent = patch.maxDailyLossPercent;
  if (patch.maxDrawdownPercent !== undefined) row.max_drawdown_percent = patch.maxDrawdownPercent;
  if (patch.maxCopiedOpenPositions !== undefined) row.max_copied_open_positions = patch.maxCopiedOpenPositions;
  if (patch.maxLotSize !== undefined) row.max_lot_size = patch.maxLotSize;
  if (patch.maxSlippagePoints !== undefined) row.max_slippage_points = patch.maxSlippagePoints;
  if (patch.pauseOnDisconnect !== undefined) row.pause_on_disconnect = patch.pauseOnDisconnect;

  const { error } = await supabase.from("copy_global_settings").upsert(row, { onConflict: "id" });
  if (error) throw new Error(`Failed to update copy settings: ${error.message}`);

  await writeAuditLog({
    actorUserId,
    action: "COPY_SETTINGS_CHANGED",
    entityType: "copy_global_settings",
    entityId: null,
    metadata: { ...patch },
  });
  return getCopyGlobalSettings();
}

function mapAccountRule(row: {
  trading_account_id: string;
  copy_enabled: boolean;
  max_daily_loss_percent: number | string | null;
  max_drawdown_percent: number | string | null;
  max_copied_lots: number | string | null;
  max_open_copied_positions: number | null;
  stop_after_losses: number | null;
  symbol_allowlist: string[] | null;
  symbol_blocklist: string[] | null;
  paused_at: string | null;
  updated_at: string;
  trading_accounts?: { account_name?: string } | null;
}): CopyAccountRuleDto {
  return {
    tradingAccountId: row.trading_account_id,
    accountName: row.trading_accounts?.account_name ?? null,
    copyEnabled: row.copy_enabled,
    maxDailyLossPercent: row.max_daily_loss_percent == null ? null : Number(row.max_daily_loss_percent),
    maxDrawdownPercent: row.max_drawdown_percent == null ? null : Number(row.max_drawdown_percent),
    maxCopiedLots: row.max_copied_lots == null ? null : Number(row.max_copied_lots),
    maxOpenCopiedPositions: row.max_open_copied_positions,
    stopAfterLosses: row.stop_after_losses,
    symbolAllowlist: row.symbol_allowlist,
    symbolBlocklist: row.symbol_blocklist,
    pausedAt: row.paused_at,
    updatedAt: row.updated_at,
  };
}

export async function getCopyAccountRule(accountId: string): Promise<CopyAccountRuleDto> {
  const supabase = createAdminClient();
  const [{ data: rule }, { data: account }] = await Promise.all([
    supabase
      .from("copy_account_rules")
      .select("trading_account_id, copy_enabled, max_daily_loss_percent, max_drawdown_percent, max_copied_lots, max_open_copied_positions, stop_after_losses, symbol_allowlist, symbol_blocklist, paused_at, updated_at, trading_accounts(account_name)")
      .eq("trading_account_id", accountId)
      .maybeSingle(),
    supabase.from("trading_accounts").select("id, account_name").eq("id", accountId).maybeSingle(),
  ]);
  if (!account) throw new CopyError(COPY_ERROR.FOLLOWER_NOT_FOUND, "Trading account not found", 404);
  if (rule) return mapAccountRule(rule as Parameters<typeof mapAccountRule>[0]);
  return {
    tradingAccountId: accountId,
    accountName: account.account_name,
    copyEnabled: true,
    maxDailyLossPercent: null,
    maxDrawdownPercent: null,
    maxCopiedLots: null,
    maxOpenCopiedPositions: null,
    stopAfterLosses: null,
    symbolAllowlist: null,
    symbolBlocklist: null,
    pausedAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function upsertCopyAccountRule(
  accountId: string,
  input: Omit<CopyAccountRuleDto, "tradingAccountId" | "accountName" | "pausedAt" | "updatedAt">,
  actorUserId: string,
): Promise<CopyAccountRuleDto> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("copy_account_rules").upsert(
    {
      trading_account_id: accountId,
      copy_enabled: input.copyEnabled,
      max_daily_loss_percent: input.maxDailyLossPercent,
      max_drawdown_percent: input.maxDrawdownPercent,
      max_copied_lots: input.maxCopiedLots,
      max_open_copied_positions: input.maxOpenCopiedPositions,
      stop_after_losses: input.stopAfterLosses,
      symbol_allowlist: input.symbolAllowlist,
      symbol_blocklist: input.symbolBlocklist,
      paused_at: input.copyEnabled ? null : new Date().toISOString(),
      updated_by: actorUserId,
    },
    { onConflict: "trading_account_id" },
  );
  if (error) throw new Error(`Failed to save copy account rules: ${error.message}`);
  await writeAuditLog({
    actorUserId,
    action: "COPY_ACCOUNT_RULES_CHANGED",
    entityType: "trading_account",
    entityId: accountId,
    metadata: { ...input },
  });
  return getCopyAccountRule(accountId);
}

export async function listCopyRuleEvents(limit = 50): Promise<CopyRuleEventDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("copy_rule_events")
    .select("id, scope, rule_code, reason, trading_account_id, strategy_id, master_event_id, mode, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw new Error(`Failed to load copy rule events: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    scope: row.scope as "GLOBAL" | "ACCOUNT",
    ruleCode: row.rule_code,
    reason: row.reason,
    tradingAccountId: row.trading_account_id,
    strategyId: row.strategy_id,
    masterEventId: row.master_event_id,
    mode: row.mode as "SIMULATION" | "LIVE",
    createdAt: row.created_at,
  }));
}

// ── Strategies ───────────────────────────────────────────────────────────────

interface StrategyRow {
  id: string;
  name: string;
  description: string | null;
  master_account_id: string;
  status: CopyStrategyDto["status"];
  mode: CopyStrategyDto["mode"];
  live_enabled: boolean;
  risk_multiplier: number | string;
  default_scaling_mode: ScalingMode;
  max_follower_lot: number | string | null;
  max_open_copied_trades: number | null;
  symbol_allowlist: string[] | null;
  symbol_blocklist: string[] | null;
  engine_status: CopyStrategyDto["engineStatus"];
  engine_error: string | null;
  engine_heartbeat_at: string | null;
  monthly_price: number | string;
  standard_monthly_price: number | string;
  premium_monthly_price: number | string;
  standard_billing_product_id: string | null;
  premium_billing_product_id: string | null;
  standard_delay_ms: number;
  premium_delay_ms: number;
  currency: string;
  billing_product_id: string | null;
  published_at: string | null;
  created_at: string;
}

function mapStrategy(
  row: StrategyRow,
  masterName: string | null,
  followerCount: number,
): CopyStrategyDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    masterAccountId: row.master_account_id,
    masterAccountName: masterName,
    status: row.status,
    mode: row.mode,
    liveEnabled: row.live_enabled,
    riskMultiplier: Number(row.risk_multiplier),
    defaultScalingMode: row.default_scaling_mode,
    maxFollowerLot: row.max_follower_lot === null ? null : Number(row.max_follower_lot),
    maxOpenCopiedTrades: row.max_open_copied_trades,
    symbolAllowlist: row.symbol_allowlist,
    symbolBlocklist: row.symbol_blocklist,
    followerCount,
    engineStatus: row.engine_status,
    engineError: row.engine_error,
    engineHeartbeatAt: row.engine_heartbeat_at,
    monthlyPrice: Number(row.monthly_price),
    standardMonthlyPrice: Number(row.standard_monthly_price),
    premiumMonthlyPrice: Number(row.premium_monthly_price),
    standardBillingProductCode: row.standard_billing_product_id
      ? `COPY_STRATEGY_${row.id.replaceAll("-", "").toUpperCase()}_STANDARD`
      : null,
    premiumBillingProductCode: row.premium_billing_product_id
      ? `COPY_STRATEGY_${row.id.replaceAll("-", "").toUpperCase()}_PREMIUM`
      : null,
    standardDelayMs: row.standard_delay_ms,
    premiumDelayMs: row.premium_delay_ms,
    currency: row.currency,
    billingProductCode: row.billing_product_id
      ? `COPY_STRATEGY_${row.id.replaceAll("-", "").toUpperCase()}`
      : null,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

const STRATEGY_COLS =
  "id, name, description, master_account_id, status, mode, live_enabled, risk_multiplier, default_scaling_mode, max_follower_lot, max_open_copied_trades, symbol_allowlist, symbol_blocklist, engine_status, engine_error, engine_heartbeat_at, monthly_price, standard_monthly_price, premium_monthly_price, standard_billing_product_id, premium_billing_product_id, standard_delay_ms, premium_delay_ms, currency, billing_product_id, published_at, created_at";

export async function listCopyStrategies(): Promise<CopyStrategyDto[]> {
  const supabase = createAdminClient();
  const { data: rows, error } = await supabase
    .from("copy_strategies")
    .select(STRATEGY_COLS)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Failed to fetch strategies: ${error.message}`);

  const strategies = (rows ?? []) as StrategyRow[];
  if (strategies.length === 0) return [];

  const masterIds = [...new Set(strategies.map((s) => s.master_account_id))];
  const strategyIds = strategies.map((s) => s.id);

  const [{ data: accounts }, { data: followers }] = await Promise.all([
    supabase.from("trading_accounts").select("id, account_name").in("id", masterIds),
    supabase.from("copy_strategy_followers").select("strategy_id").in("strategy_id", strategyIds),
  ]);

  const nameByAccount = new Map((accounts ?? []).map((a) => [a.id, a.account_name as string]));
  const followerCount = new Map<string, number>();
  for (const f of followers ?? []) {
    followerCount.set(f.strategy_id, (followerCount.get(f.strategy_id) ?? 0) + 1);
  }

  return strategies.map((s) =>
    mapStrategy(s, nameByAccount.get(s.master_account_id) ?? null, followerCount.get(s.id) ?? 0),
  );
}

async function getStrategyRow(strategyId: string): Promise<StrategyRow> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("copy_strategies").select(STRATEGY_COLS).eq("id", strategyId).maybeSingle();
  if (!data) throw new CopyError(COPY_ERROR.COPY_STRATEGY_NOT_FOUND, "Strategy not found", 404);
  return data as StrategyRow;
}

async function getStrategyRowCached(strategyId: string): Promise<StrategyRow> {
  return getRuntimeCached(strategyRuntimeCache, strategyId, () => getStrategyRow(strategyId));
}

export async function createCopyStrategy(
  input: {
    name: string;
    description?: string | null;
    masterAccountId: string;
    riskMultiplier: number;
    defaultScalingMode: ScalingMode;
    maxFollowerLot?: number | null;
    maxOpenCopiedTrades?: number | null;
    symbolAllowlist?: string[] | null;
    symbolBlocklist?: string[] | null;
    standardMonthlyPrice: number;
    premiumMonthlyPrice: number;
    currency: string;
  },
  actorUserId: string,
): Promise<CopyStrategyDto> {
  const supabase = createAdminClient();

  const { data: master } = await supabase
    .from("trading_accounts")
    .select("id, account_name, user_id, account_usage")
    .eq("id", input.masterAccountId)
    .eq("user_id", actorUserId)
    .eq("account_usage", "COPY_MASTER")
    .maybeSingle();
  if (!master) throw new CopyError(COPY_ERROR.MASTER_ACCOUNT_NOT_FOUND, "Select a copy-master account connected by this admin.", 404);

  const { data, error } = await supabase
    .from("copy_strategies")
    .insert({
      name: input.name,
      description: input.description ?? null,
      master_account_id: input.masterAccountId,
      risk_multiplier: input.riskMultiplier,
      default_scaling_mode: input.defaultScalingMode,
      max_follower_lot: input.maxFollowerLot ?? null,
      max_open_copied_trades: input.maxOpenCopiedTrades ?? null,
      symbol_allowlist: input.symbolAllowlist ?? null,
      symbol_blocklist: input.symbolBlocklist ?? null,
      monthly_price: input.standardMonthlyPrice,
      standard_monthly_price: input.standardMonthlyPrice,
      premium_monthly_price: input.premiumMonthlyPrice,
      currency: input.currency,
      mode: "LIVE",
      live_enabled: false,
      created_by: actorUserId,
    })
    .select(STRATEGY_COLS)
    .single();
  if (error || !data) throw new Error(`Failed to create strategy: ${error?.message}`);

  await writeAuditLog({
    actorUserId,
    action: "COPY_STRATEGY_CREATED",
    entityType: "copy_strategy",
    entityId: data.id,
    metadata: { name: input.name, masterAccountId: input.masterAccountId },
  });
  return mapStrategy(data as StrategyRow, (master.account_name as string) ?? null, 0);
}

export async function updateCopyStrategy(
  strategyId: string,
  patch: Record<string, unknown>,
  actorUserId: string,
): Promise<CopyStrategyDto> {
  const supabase = createAdminClient();

  // Map camelCase patch → snake_case columns (whitelist).
  const row: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: "name",
    description: "description",
    status: "status",
    mode: "mode",
    liveEnabled: "live_enabled",
    riskMultiplier: "risk_multiplier",
    defaultScalingMode: "default_scaling_mode",
    maxFollowerLot: "max_follower_lot",
    maxOpenCopiedTrades: "max_open_copied_trades",
    symbolAllowlist: "symbol_allowlist",
    symbolBlocklist: "symbol_blocklist",
    standardMonthlyPrice: "standard_monthly_price",
    premiumMonthlyPrice: "premium_monthly_price",
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) row[col] = patch[k];
  }
  if (patch.standardMonthlyPrice !== undefined) {
    row.monthly_price = patch.standardMonthlyPrice;
  }

  const { data, error } = await supabase
    .from("copy_strategies")
    .update(row)
    .eq("id", strategyId)
    .select(STRATEGY_COLS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update strategy: ${error.message}`);
  if (!data) throw new CopyError(COPY_ERROR.COPY_STRATEGY_NOT_FOUND, "Strategy not found", 404);
  const updatedStrategy = data as StrategyRow;

  const billingProductUpdates: PromiseLike<{ error: { message: string } | null }>[] = [];
  if (updatedStrategy.standard_billing_product_id) {
    billingProductUpdates.push(
      supabase
        .from("billing_products")
        .update({
          name: `${updatedStrategy.name} Standard Copy Strategy`,
          amount: Number(updatedStrategy.standard_monthly_price),
        })
        .eq("id", updatedStrategy.standard_billing_product_id),
    );
  }
  if (updatedStrategy.premium_billing_product_id) {
    billingProductUpdates.push(
      supabase
        .from("billing_products")
        .update({
          name: `${updatedStrategy.name} Premium Fast Copy Strategy`,
          amount: Number(updatedStrategy.premium_monthly_price),
        })
        .eq("id", updatedStrategy.premium_billing_product_id),
    );
  }
  if (billingProductUpdates.length > 0) {
    const results = await Promise.all(billingProductUpdates);
    const billingError = results.find((result) => result.error)?.error;
    if (billingError) {
      throw new Error(`Strategy pricing changed, but billing products could not be updated: ${billingError.message}`);
    }
  }

  await writeAuditLog({
    actorUserId,
    action: "COPY_STRATEGY_UPDATED",
    entityType: "copy_strategy",
    entityId: strategyId,
    metadata: { fields: Object.keys(row), liveEnabled: patch.liveEnabled, mode: patch.mode },
  });

  const { data: master } = await supabase
    .from("trading_accounts")
    .select("account_name")
    .eq("id", updatedStrategy.master_account_id)
    .maybeSingle();
  return mapStrategy(updatedStrategy, (master?.account_name as string) ?? null, 0);
}

export async function deleteCopyStrategy(
  strategyId: string,
  actorUserId: string,
): Promise<{ deleted: true }> {
  const supabase = createAdminClient();
  const strategy = await getStrategyRow(strategyId);
  if (strategy.status !== "DRAFT" && strategy.status !== "ARCHIVED") {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "Only draft or archived strategies can be deleted.",
      409,
    );
  }

  const [
    { count: followerCount, error: followerError },
    { count: orderCount, error: orderError },
  ] = await Promise.all([
    supabase
      .from("copy_strategy_followers")
      .select("id", { count: "exact", head: true })
      .eq("strategy_id", strategyId),
    supabase
      .from("payment_orders")
      .select("id", { count: "exact", head: true })
      .eq("copy_strategy_id", strategyId),
  ]);
  if (followerError) throw new Error(`Failed to inspect strategy followers: ${followerError.message}`);
  if (orderError) throw new Error(`Failed to inspect strategy orders: ${orderError.message}`);
  if ((followerCount ?? 0) > 0 || (orderCount ?? 0) > 0) {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "This strategy has follower or payment history and must remain archived.",
      409,
    );
  }

  const { error } = await supabase.from("copy_strategies").delete().eq("id", strategyId);
  if (error) throw new Error(`Failed to delete strategy: ${error.message}`);

  await writeAuditLog({
    actorUserId,
    action: "COPY_STRATEGY_DELETED",
    entityType: "copy_strategy",
    entityId: strategyId,
    metadata: { name: strategy.name, status: strategy.status },
  });
  return { deleted: true };
}

// ── Master monitoring ──────────────────────────────────────────────────────

function mapEvent(row: {
  id: string;
  strategy_id: string;
  event_type: MasterEventDto["eventType"];
  master_trade_id: string;
  symbol: string;
  side: string | null;
  volume: number | string | null;
  open_price: number | string | null;
  close_price: number | string | null;
  event_time: string;
  created_at: string;
}): MasterEventDto {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    eventType: row.event_type,
    masterTradeId: row.master_trade_id,
    symbol: row.symbol,
    side: row.side,
    volume: row.volume === null ? null : Number(row.volume),
    openPrice: row.open_price === null ? null : Number(row.open_price),
    closePrice: row.close_price === null ? null : Number(row.close_price),
    eventTime: row.event_time,
    createdAt: row.created_at,
  };
}

const EVENT_COLS =
  "id, strategy_id, event_type, master_trade_id, symbol, side, volume, open_price, close_price, event_time, created_at";

/**
 * Detect new OPEN/CLOSE events on the master account by diffing its `trades`
 * rows against previously recorded master events. (MODIFY detection requires
 * broker SL/TP which the trades table does not store — documented in the design.)
 * Records new events only; never copies.
 */
export async function monitorMasterAccount(
  strategyId: string,
  actorUserId: string | null,
): Promise<{ detected: number }> {
  const strategy = await getStrategyRow(strategyId);
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("copy_master_events")
    .select("dedupe_key")
    .eq("strategy_id", strategyId)
    .limit(10000);
  const seen = new Set((existing ?? []).map((e) => e.dedupe_key as string));

  const { data: masterTrades } = await supabase
    .from("trades")
    .select("id, symbol, side, status, volume, open_price, close_price, opened_at, closed_at")
    .eq("trading_account_id", strategy.master_account_id)
    .order("opened_at", { ascending: false })
    .limit(200);

  const newEvents: Record<string, unknown>[] = [];
  for (const t of masterTrades ?? []) {
    const openKey = `${strategyId}:${t.id}:OPEN`;
    if (!seen.has(openKey)) {
      newEvents.push({
        strategy_id: strategyId,
        master_account_id: strategy.master_account_id,
        event_type: "OPEN",
        master_trade_id: t.id,
        symbol: t.symbol,
        side: t.side,
        volume: t.volume,
        open_price: t.open_price,
        event_time: t.opened_at,
        dedupe_key: openKey,
        raw_payload: { source: "trades", trade: t },
      });
    }
    if (t.status === "CLOSED") {
      const closeKey = `${strategyId}:${t.id}:CLOSE`;
      if (!seen.has(closeKey)) {
        newEvents.push({
          strategy_id: strategyId,
          master_account_id: strategy.master_account_id,
          event_type: "CLOSE",
          master_trade_id: t.id,
          symbol: t.symbol,
          side: t.side,
          volume: t.volume,
          open_price: t.open_price,
          close_price: t.close_price,
          event_time: t.closed_at ?? t.opened_at,
          dedupe_key: closeKey,
          raw_payload: { source: "trades", trade: t },
        });
      }
    }
  }

  if (newEvents.length > 0) {
    // ignoreDuplicates guards against a concurrent monitor run.
    const { error } = await supabase
      .from("copy_master_events")
      .upsert(newEvents, { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (error) throw new Error(`Failed to record master events: ${error.message}`);
  }

  await writeAuditLog({
    actorUserId,
    action: "COPY_MASTER_MONITORED",
    entityType: "copy_strategy",
    entityId: strategyId,
    metadata: { detected: newEvents.length },
  });
  return { detected: newEvents.length };
}

export async function listMasterEvents(strategyId: string): Promise<MasterEventDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("copy_master_events")
    .select(EVENT_COLS)
    .eq("strategy_id", strategyId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Failed to fetch master events: ${error.message}`);
  return (data ?? []).map(mapEvent);
}

// ── Simulation ─────────────────────────────────────────────────────────────

interface SnapshotLite {
  equity: number;
  balance: number;
  drawdownPercent: number;
}

async function getSnapshot(accountId: string): Promise<SnapshotLite | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("latest_account_snapshots")
    .select("equity, balance, drawdown_percent")
    .eq("trading_account_id", accountId)
    .maybeSingle();
  if (!data) return null;
  return {
    equity: Number(data.equity),
    balance: Number(data.balance),
    drawdownPercent: Number(data.drawdown_percent ?? 0),
  };
}

async function getSnapshotCached(accountId: string): Promise<SnapshotLite | null> {
  return getRuntimeCached(snapshotRuntimeCache, accountId, () => getSnapshot(accountId));
}

interface FollowerRow {
  id: string;
  follower_account_id: string;
  trader_id: string;
  status: CopyFollowerDto["status"];
  tier: "NORMAL" | "PREMIUM";
  scaling_mode: ScalingMode | null;
  risk_multiplier: number | string | null;
  fixed_lot: number | string | null;
  max_lot: number | string | null;
  min_lot: number | string | null;
  copy_enabled: boolean;
  copy_mode: CopyFollowerDto["copyMode"] | null;
  lot_multiplier: number | string | null;
  max_open_trades: number | null;
  max_daily_loss_percent: number | string | null;
  max_drawdown_percent: number | string | null;
  symbol_allowlist: string[] | null;
  symbol_blocklist: string[] | null;
  symbol_mapping: Record<string, string> | null;
  copy_new_trades_only: boolean;
  reverse_copy: boolean;
  pause_on_disconnect: boolean;
  emergency_stop: boolean;
  consent_accepted_at: string | null;
  created_at: string;
}

async function loadActiveFollowers(strategyId: string): Promise<FollowerRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("copy_strategy_followers")
    .select(
      "id, follower_account_id, trader_id, status, tier, scaling_mode, risk_multiplier, fixed_lot, max_lot, min_lot, copy_enabled, copy_mode, lot_multiplier, max_open_trades, max_daily_loss_percent, max_drawdown_percent, symbol_allowlist, symbol_blocklist, symbol_mapping, copy_new_trades_only, reverse_copy, pause_on_disconnect, emergency_stop, consent_accepted_at, created_at",
    )
    .eq("strategy_id", strategyId)
    .eq("status", "ACTIVE")
    .limit(2000);
  // PREMIUM followers are processed before NORMAL — ordering guarantee, not broker latency.
  const rows = (data ?? []) as FollowerRow[];
  return rows.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "PREMIUM" ? -1 : 1));
}

function getStrategyHotRuntime(strategyId: string): StrategyHotRuntime | null {
  const cached = strategyHotRuntimeCache.get(strategyId);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.value;
}

async function loadActiveFollowersCached(strategyId: string): Promise<FollowerRow[]> {
  return getRuntimeCached(followersRuntimeCache, strategyId, () => loadActiveFollowers(strategyId));
}

export async function warmCopyStrategyAccounts(
  strategyId: string,
  masterAccountId: string,
  adapter = createBrokerAdapter(),
): Promise<{ warmed: number; followers: number }> {
  if (!adapter.warmAccounts) return { warmed: 0, followers: 0 };
  const [followers, strategy, settings, masterSnap] = await Promise.all([
    loadActiveFollowersCached(strategyId),
    getStrategyRowCached(strategyId),
    getCopyGlobalSettingsCached(),
    getSnapshotCached(masterAccountId).catch(() => null),
  ]);
  const accountIds = [masterAccountId, ...followers.map((follower) => follower.follower_account_id)];
  const followerRuntimeEntries = await Promise.all(
    followers.slice(0, 250).map(async (follower) => {
      const accountId = follower.follower_account_id;
      const [snapshot, generalRiskState, risk] = await Promise.all([
        getSnapshotCached(accountId).catch(() => null),
        getRiskEnforcementStateCached(accountId).catch(() => null),
        loadAccountRiskRuntimeCached(accountId, "LIVE").catch(() => null),
      ]);
      return [
        accountId,
        {
          snapshot,
          generalRiskState: generalRiskState ?? null,
          risk: risk ?? {
            currentDailyLossPercent: 0,
            currentDrawdownPercent: 0,
            openCopiedTrades: 0,
            consecutiveLosses: 0,
          },
        },
      ] as const;
    }),
  );
  const [, accountRules, statusByAccount] = await Promise.all([
    adapter.warmAccounts(accountIds),
    loadAccountRuleMapCached(accountIds).catch(() => null),
    loadAccountStatusMapCached(accountIds).catch(() => null),
  ]);
  strategyHotRuntimeCache.set(strategyId, {
    value: {
      strategy,
      settings,
      followers,
      masterSnap,
      accountRules: accountRules ?? new Map<string, AccountRuleRuntime>(),
      statusByAccount: statusByAccount ?? new Map<string, string>(),
      followerRuntimeByAccount: new Map(followerRuntimeEntries),
    },
    expiresAt: Date.now() + Math.max(copyRuntimeCacheMs(), 15_000),
  });
  return { warmed: accountIds.length, followers: followers.length };
}

type AccountRuleRuntime = Awaited<ReturnType<typeof getCopyAccountRule>>;

async function loadAccountRuleMap(accountIds: string[]): Promise<Map<string, AccountRuleRuntime>> {
  if (accountIds.length === 0) return new Map();
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("copy_account_rules")
    .select("trading_account_id, copy_enabled, max_daily_loss_percent, max_drawdown_percent, max_copied_lots, max_open_copied_positions, stop_after_losses, symbol_allowlist, symbol_blocklist, paused_at, updated_at")
    .in("trading_account_id", accountIds);
  return new Map(
    (data ?? []).map((row) => [
      row.trading_account_id as string,
      mapAccountRule(row as Parameters<typeof mapAccountRule>[0]),
    ]),
  );
}

async function loadAccountRuleMapCached(accountIds: string[]): Promise<Map<string, AccountRuleRuntime>> {
  const key = [...new Set(accountIds)].sort().join(",");
  return getRuntimeCached(accountRulesRuntimeCache, key, () => loadAccountRuleMap(accountIds));
}

async function loadAccountStatusMap(accountIds: string[]): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("trading_accounts")
    .select("id, status")
    .in("id", accountIds);
  return new Map((data ?? []).map((account) => [account.id as string, account.status as string]));
}

async function loadAccountStatusMapCached(accountIds: string[]): Promise<Map<string, string>> {
  const key = [...new Set(accountIds)].sort().join(",");
  return getRuntimeCached(accountStatusRuntimeCache, key, () => loadAccountStatusMap(accountIds));
}

interface AccountRiskRuntime {
  currentDailyLossPercent: number;
  currentDrawdownPercent: number;
  openCopiedTrades: number;
  consecutiveLosses: number;
}

async function loadAccountRiskRuntime(accountId: string, mode: "SIMULATION" | "LIVE"): Promise<AccountRiskRuntime> {
  const supabase = createAdminClient();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const [snapshot, tradesResult, logsResult] = await Promise.all([
    getSnapshot(accountId),
    supabase
      .from("trades")
      .select("profit, closed_at")
      .eq("trading_account_id", accountId)
      .eq("status", "CLOSED")
      .order("closed_at", { ascending: false })
      .limit(1000),
    supabase
      .from("copy_execution_logs")
      .select("action")
      .eq("follower_account_id", accountId)
      .eq("mode", mode)
      .eq("status", "SUCCESS")
      .in("action", ["OPEN", "CLOSE"])
      .limit(10_000),
  ]);
  const trades = tradesResult.data ?? [];
  const dailyLoss = Math.abs(
    trades
      .filter((trade) => trade.closed_at && trade.closed_at >= today.toISOString())
      .reduce((sum, trade) => sum + Math.min(0, Number(trade.profit)), 0),
  );
  let consecutiveLosses = 0;
  for (const trade of trades) {
    if (Number(trade.profit) >= 0) break;
    consecutiveLosses++;
  }
  const opens = (logsResult.data ?? []).filter((log) => log.action === "OPEN").length;
  const closes = (logsResult.data ?? []).filter((log) => log.action === "CLOSE").length;
  return {
    currentDailyLossPercent:
      snapshot && snapshot.balance > 0 ? (dailyLoss / snapshot.balance) * 100 : 0,
    currentDrawdownPercent: snapshot?.drawdownPercent ?? 0,
    openCopiedTrades: Math.max(0, opens - closes),
    consecutiveLosses,
  };
}

async function loadAccountRiskRuntimeCached(accountId: string, mode: "SIMULATION" | "LIVE"): Promise<AccountRiskRuntime> {
  return getRuntimeCached(accountRiskRuntimeCache, `${mode}:${accountId}`, () => loadAccountRiskRuntime(accountId, mode));
}

async function getRiskEnforcementStateCached(accountId: string): Promise<Awaited<ReturnType<typeof getRiskEnforcementState>>> {
  return getRuntimeCached(generalRiskRuntimeCache, accountId, () => getRiskEnforcementState(accountId));
}

function lowestRuntimeLimit(...values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length > 0 ? Math.min(...numbers) : null;
}

function buildRuleEvent(params: {
  eligibility: ReturnType<typeof evaluateFollowerEligibility>;
  accountId: string;
  strategyId: string;
  masterEventId: string;
  followerId: string;
  mode: "SIMULATION" | "LIVE";
}): Record<string, unknown> | null {
  if (params.eligibility.eligible || !params.eligibility.ruleCode || !params.eligibility.reason) return null;
  return {
    scope: params.eligibility.scope ?? "ACCOUNT",
    rule_code: params.eligibility.ruleCode,
    reason: params.eligibility.reason,
    trading_account_id: params.accountId,
    strategy_id: params.strategyId,
    master_event_id: params.masterEventId,
    follower_id: params.followerId,
    mode: params.mode,
    details: { source: "copy_preflight" },
  };
}

async function writeGlobalRuleEvent(params: {
  ruleCode: string;
  reason: string;
  strategyId: string;
  masterEventId: string;
  mode: "SIMULATION" | "LIVE";
}): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("copy_rule_events").insert({
    scope: "GLOBAL",
    rule_code: params.ruleCode,
    reason: params.reason,
    strategy_id: params.strategyId,
    master_event_id: params.masterEventId,
    mode: params.mode,
    details: { source: "copy_preflight" },
  });
}

interface SimResult {
  simulated: number;
  success: number;
  skipped: number;
  failed: number;
}

async function simulateOneEvent(eventRow: {
  id: string;
  strategy_id: string;
  event_type: "OPEN" | "CLOSE" | "MODIFY";
  symbol: string;
  side: string | null;
  volume: number | string | null;
  event_time: string;
}, strategy: StrategyRow, settings: CopyGlobalSettingsDto): Promise<SimResult> {
  const supabase = createAdminClient();
  const followers = await loadActiveFollowers(strategy.id);
  const result: SimResult = { simulated: 0, success: 0, skipped: 0, failed: 0 };
  if (followers.length === 0) return result;

  const masterSnap = await getSnapshot(strategy.master_account_id);
  const masterLot = eventRow.volume === null ? 0 : Number(eventRow.volume);

  // Follower account statuses + snapshots.
  const accountIds = followers.map((f) => f.follower_account_id);
  const accountRules = await loadAccountRuleMap(accountIds);
  const { data: accountRows } = await supabase
    .from("trading_accounts")
    .select("id, status")
    .in("id", accountIds);
  const statusByAccount = new Map((accountRows ?? []).map((a) => [a.id, a.status as string]));

  const logs: Record<string, unknown>[] = [];
  const ruleEvents: Record<string, unknown>[] = [];

  for (const f of followers) {
    const followerSymbol = mapFollowerSymbol(eventRow.symbol, f.symbol_mapping);
    const followerSide = reverseFollowerSide(eventRow.side, f.reverse_copy);
    const accountStatus = statusByAccount.get(f.follower_account_id) ?? "DISCONNECTED";
    const followerSnap = await getSnapshot(f.follower_account_id);
    const accountRule = accountRules.get(f.follower_account_id);
    const risk = await loadAccountRiskRuntime(f.follower_account_id, "SIMULATION");

    const elig = evaluateFollowerEligibility({
      globalEmergencyStop: settings.emergencyStopEnabled || f.emergency_stop,
      globalCopyEnabled: settings.copyEnabled,
      accountCopyEnabled: f.copy_enabled && (accountRule?.copyEnabled ?? true),
      pauseOnDisconnect: settings.pauseOnDisconnect || f.pause_on_disconnect,
      followerStatus: f.status,
      consentAccepted: Boolean(f.consent_accepted_at),
      accountStatus,
      symbol: followerSymbol,
      symbolAllowlist: accountRule?.symbolAllowlist ?? f.symbol_allowlist ?? strategy.symbol_allowlist,
      symbolBlocklist: accountRule?.symbolBlocklist ?? f.symbol_blocklist ?? strategy.symbol_blocklist,
      openCopiedTrades: risk.openCopiedTrades,
      maxOpenTrades: lowestRuntimeLimit(f.max_open_trades, accountRule?.maxOpenCopiedPositions),
      globalMaxOpenTrades: settings.maxCopiedOpenPositions,
      currentDailyLossPercent: risk.currentDailyLossPercent,
      maxDailyLossPercent: lowestRuntimeLimit(
        f.max_daily_loss_percent === null ? null : Number(f.max_daily_loss_percent),
        accountRule?.maxDailyLossPercent,
      ),
      globalMaxDailyLossPercent: settings.maxDailyLossPercent,
      currentDrawdownPercent: risk.currentDrawdownPercent,
      maxDrawdownPercent: lowestRuntimeLimit(
        f.max_drawdown_percent === null ? null : Number(f.max_drawdown_percent),
        accountRule?.maxDrawdownPercent,
      ),
      globalMaxDrawdownPercent: settings.maxDrawdownPercent,
      consecutiveLosses: risk.consecutiveLosses,
      stopAfterLosses: accountRule?.stopAfterLosses,
    });

    const baseLog = {
      strategy_id: strategy.id,
      master_event_id: eventRow.id,
      follower_account_id: f.follower_account_id,
      trader_id: f.trader_id,
      mode: "SIMULATION",
      symbol: followerSymbol,
      side: followerSide,
    };

    if (f.copy_new_trades_only && new Date(eventRow.event_time) < new Date(f.created_at)) {
      logs.push({
        ...baseLog,
        action: "SKIPPED",
        status: "SKIPPED",
        error_code: COPY_ERROR.FOLLOWER_NOT_ELIGIBLE,
        error_message: "Trade predates this follower setup; new trades only is enabled.",
      });
      result.skipped++;
      continue;
    }

    if (!elig.eligible) {
      logs.push({ ...baseLog, action: "SKIPPED", status: "SKIPPED", error_code: COPY_ERROR.FOLLOWER_NOT_ELIGIBLE, error_message: elig.reason });
      const ruleEvent = buildRuleEvent({ eligibility: elig, accountId: f.follower_account_id, strategyId: strategy.id, masterEventId: eventRow.id, followerId: f.id, mode: "SIMULATION" });
      if (ruleEvent) ruleEvents.push(ruleEvent);
      result.skipped++;
      continue;
    }

    const lot = calculateFollowerLot({
      masterLot,
      masterEquity: masterSnap?.equity ?? null,
      masterBalance: masterSnap?.balance ?? null,
      followerEquity: followerSnap?.equity ?? null,
      followerBalance: followerSnap?.balance ?? null,
      scalingMode: (
        (f.copy_mode ? copyModeToScalingMode(f.copy_mode) : null)
        ?? f.scaling_mode
        ?? strategy.default_scaling_mode
      ) as ScalingMode,
      riskMultiplier: f.lot_multiplier === null
        ? (f.risk_multiplier === null ? Number(strategy.risk_multiplier) : Number(f.risk_multiplier))
        : Number(f.lot_multiplier),
      fixedLot: f.fixed_lot === null ? null : Number(f.fixed_lot),
      minLot: f.min_lot === null ? null : Number(f.min_lot),
      maxLot: f.max_lot === null ? (strategy.max_follower_lot === null ? null : Number(strategy.max_follower_lot)) : Number(f.max_lot),
    });

    if (lot.lot <= 0) {
      logs.push({ ...baseLog, action: "SKIPPED", status: "SKIPPED", error_code: COPY_ERROR.COPY_INVALID_LOT, error_message: lot.reason, calculated_lot: 0 });
      result.skipped++;
      continue;
    }

    const lotEligibility = evaluateFollowerEligibility({
      globalEmergencyStop: settings.emergencyStopEnabled || f.emergency_stop,
      globalCopyEnabled: settings.copyEnabled,
      accountCopyEnabled: f.copy_enabled && (accountRule?.copyEnabled ?? true),
      followerStatus: f.status,
      consentAccepted: Boolean(f.consent_accepted_at),
      accountStatus,
      symbol: followerSymbol,
      proposedLot: lot.lot,
      maxLot: accountRule?.maxCopiedLots,
      globalMaxLot: settings.maxLotSize,
      slippagePoints: 0,
      maxSlippagePoints: settings.maxSlippagePoints,
    });
    if (!lotEligibility.eligible) {
      logs.push({ ...baseLog, action: "SKIPPED", status: "SKIPPED", error_code: COPY_ERROR.COPY_RISK_BLOCKED, error_message: lotEligibility.reason, calculated_lot: lot.lot });
      const ruleEvent = buildRuleEvent({ eligibility: lotEligibility, accountId: f.follower_account_id, strategyId: strategy.id, masterEventId: eventRow.id, followerId: f.id, mode: "SIMULATION" });
      if (ruleEvent) ruleEvents.push(ruleEvent);
      result.skipped++;
      continue;
    }

    logs.push({ ...baseLog, action: eventRow.event_type, status: "SUCCESS", calculated_lot: lot.lot });
    result.success++;
  }

  result.simulated = logs.length;
  if (logs.length > 0) {
    const { error } = await supabase.from("copy_execution_logs").insert(logs);
    if (error) throw new Error(`Failed to write simulation logs: ${error.message}`);
  }
  if (ruleEvents.length > 0) {
    await supabase.from("copy_rule_events").insert(ruleEvents);
  }
  return result;
}

export async function simulateCopyForEvent(eventId: string, actorUserId: string | null): Promise<SimResult> {
  const supabase = createAdminClient();
  const { data: ev } = await supabase
    .from("copy_master_events")
    .select("id, strategy_id, event_type, master_trade_id, symbol, side, volume, previous_volume, stop_loss, take_profit, event_time")
    .eq("id", eventId)
    .maybeSingle();
  if (!ev) throw new CopyError(COPY_ERROR.COPY_DUPLICATE_EVENT, "Master event not found", 404);

  const strategy = await getStrategyRow(ev.strategy_id);
  const settings = await getCopyGlobalSettings();
  const result = await simulateOneEvent(ev as Parameters<typeof simulateOneEvent>[0], strategy, settings);

  await writeAuditLog({
    actorUserId,
    action: "COPY_SIMULATED",
    entityType: "copy_master_event",
    entityId: eventId,
    metadata: { ...result },
  });
  return result;
}

export async function simulateStrategy(strategyId: string, actorUserId: string | null): Promise<SimResult> {
  const strategy = await getStrategyRow(strategyId);
  const settings = await getCopyGlobalSettings();
  const supabase = createAdminClient();

  // Simulate only events that have no SIMULATION log yet (avoid piling duplicates).
  const { data: events } = await supabase
    .from("copy_master_events")
    .select("id, strategy_id, event_type, symbol, side, volume, event_time")
    .eq("strategy_id", strategyId)
    .order("created_at", { ascending: false })
    .limit(100);

  const { data: simmed } = await supabase
    .from("copy_execution_logs")
    .select("master_event_id")
    .eq("strategy_id", strategyId)
    .eq("mode", "SIMULATION")
    .limit(10000);
  const simmedSet = new Set((simmed ?? []).map((l) => l.master_event_id as string));

  const total: SimResult = { simulated: 0, success: 0, skipped: 0, failed: 0 };
  for (const ev of events ?? []) {
    if (simmedSet.has(ev.id)) continue;
    const r = await simulateOneEvent(ev as Parameters<typeof simulateOneEvent>[0], strategy, settings);
    total.simulated += r.simulated;
    total.success += r.success;
    total.skipped += r.skipped;
    total.failed += r.failed;
  }

  await writeAuditLog({
    actorUserId,
    action: "COPY_SIMULATED",
    entityType: "copy_strategy",
    entityId: strategyId,
    metadata: { ...total },
  });
  return total;
}

// ── Logs ─────────────────────────────────────────────────────────────────────

function mapLog(row: {
  id: string;
  strategy_id: string;
  master_event_id: string;
  follower_account_id: string | null;
  trader_id: string | null;
  mode: CopyLogDto["mode"];
  action: CopyLogDto["action"];
  status: CopyLogDto["status"];
  calculated_lot: number | string | null;
  executed_lot: number | string | null;
  symbol: string | null;
  side: string | null;
  broker_order_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  copy_strategies: { name: string } | Array<{ name: string }> | null;
}): CopyLogDto {
  const strategy = Array.isArray(row.copy_strategies) ? row.copy_strategies[0] : row.copy_strategies;
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyName: strategy?.name ?? "Deleted strategy",
    masterEventId: row.master_event_id,
    followerAccountId: row.follower_account_id,
    traderId: row.trader_id,
    mode: row.mode,
    action: row.action,
    status: row.status,
    calculatedLot: row.calculated_lot === null ? null : Number(row.calculated_lot),
    executedLot: row.executed_lot === null ? null : Number(row.executed_lot),
    symbol: row.symbol,
    side: row.side,
    brokerOrderId: row.broker_order_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

const LOG_COLS =
  "id, strategy_id, master_event_id, follower_account_id, trader_id, mode, action, status, calculated_lot, executed_lot, symbol, side, broker_order_id, error_code, error_message, created_at, copy_strategies(name)";

export async function listCopyLogs(filters?: { strategyId?: string }): Promise<CopyLogDto[]> {
  const supabase = createAdminClient();
  let query = supabase.from("copy_execution_logs").select(LOG_COLS).order("created_at", { ascending: false }).limit(500);
  if (filters?.strategyId) query = query.eq("strategy_id", filters.strategyId);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch copy logs: ${error.message}`);
  return (data ?? []).map(mapLog);
}

// ── Live execution (GUARDED — currently not configured) ──────────────────────

export interface ExecSummary {
  attempted: number;
  success: number;
  failed: number;
  skipped: number;
}

export type LinkedEvent = {
  id: string;
  strategy_id: string;
  event_type: "OPEN" | "CLOSE" | "MODIFY";
  master_trade_id: string;
  symbol: string;
  side: string | null;
  volume: number | string | null;
  previous_volume: number | string | null;
  stop_loss: number | string | null;
  take_profit: number | string | null;
  event_time: string;
};

async function inParallelBatches<T>(items: T[], size: number, task: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(task));
  }
}

async function executeLinkedCloseOrModify(ev: LinkedEvent, adapter: BrokerAdapter, startedAt = Date.now()): Promise<ExecSummary> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("copy_trade_links")
    .select("id, follower_id, follower_account_id, trader_id, follower_position_id, symbol, side, copied_volume, status")
    .eq("strategy_id", ev.strategy_id)
    .eq("master_trade_id", ev.master_trade_id)
    .eq("status", "OPEN")
    .limit(5000);
  const links = data ?? [];
  const summary: ExecSummary = { attempted: links.length, success: 0, failed: 0, skipped: 0 };
  const hotPathWarmup = getBrokerProviderId() !== "api2trade" || process.env.WSA_COPY_HOT_PATH_WARMUP === "true";
  if (hotPathWarmup) {
    await adapter.warmAccounts?.(links.map((link) => link.follower_account_id));
  }
  logCopyTiming(ev.id, "linked positions loaded", startedAt, {
    type: ev.event_type,
    links: links.length,
    hotPathWarmup,
  });

  const previousVolume = Number(ev.previous_volume ?? ev.volume ?? 0);
  const currentVolume = Number(ev.volume ?? previousVolume);
  if (ev.event_type === "MODIFY" && previousVolume > 0 && currentVolume > previousVolume) {
    const byFollower = new Map<string, typeof links>();
    for (const link of links) {
      const group = byFollower.get(link.follower_account_id) ?? [];
      group.push(link);
      byFollower.set(link.follower_account_id, group);
    }
    await inParallelBatches([...byFollower.values()], 12, async (group) => {
      const first = group[0];
      const additionalVolume = group.reduce((sum, link) => sum + Number(link.copied_volume), 0)
        * ((currentVolume - previousVolume) / previousVolume);
      if (additionalVolume <= 0) return;
      const { data: existing } = await supabase.from("copy_trade_links").select("id, status").eq("source_event_id", ev.id).eq("follower_account_id", first.follower_account_id).maybeSingle();
      if (existing && existing.status !== "FAILED") return;
      let linkId = existing?.id as string | undefined;
      if (!linkId) {
        const { data: reservation, error } = await supabase.from("copy_trade_links").insert({
          strategy_id: ev.strategy_id,
          follower_id: first.follower_id,
          follower_account_id: first.follower_account_id,
          trader_id: first.trader_id,
          master_trade_id: ev.master_trade_id,
          source_event_id: ev.id,
          symbol: first.symbol,
          side: first.side,
          copied_volume: additionalVolume,
          status: "PENDING",
        }).select("id").single();
        if (error || !reservation) throw new Error(`Scale-in reservation failed: ${error?.message}`);
        linkId = reservation.id;
      }
      try {
        const result = await adapter.openTrade({
          accountId: first.follower_account_id,
          symbol: first.symbol,
          side: first.side === "SELL" ? "SELL" : "BUY",
          volume: additionalVolume,
          stopLoss: ev.stop_loss === null ? null : Number(ev.stop_loss),
          takeProfit: ev.take_profit === null ? null : Number(ev.take_profit),
          comment: `wsa:scale:${ev.strategy_id.slice(0, 8)}`,
        });
        await supabase.from("copy_trade_links").update({
          status: "OPEN",
          follower_position_id: result.brokerPositionId ?? result.brokerOrderId ?? null,
          follower_order_id: result.brokerOrderId ?? null,
          copied_volume: result.executedVolume ?? additionalVolume,
          opened_at: new Date().toISOString(),
        }).eq("id", linkId);
      } catch (error) {
        const message = (error instanceof Error ? error.message : "Scale-in failed").slice(0, 400);
        await supabase.from("copy_trade_links").update({ status: "FAILED", error_code: COPY_ERROR.COPY_PROVIDER_ERROR, error_message: message }).eq("id", linkId);
        throw error;
      }
    });
  }

  await inParallelBatches(links, 12, async (link) => {
    if (!link.follower_position_id) {
      summary.skipped++;
      return;
    }
    const baseLog = {
      strategy_id: ev.strategy_id,
      master_event_id: ev.id,
      follower_account_id: link.follower_account_id,
      trader_id: link.trader_id,
      mode: "LIVE" as const,
      symbol: link.symbol,
      side: link.side,
    };
    try {
      if (ev.event_type === "CLOSE") {
        await supabase.from("copy_trade_links").update({ status: "CLOSING" }).eq("id", link.id).eq("status", "OPEN");
        const brokerStartedAt = Date.now();
        const result = await adapter.closeTrade({
          accountId: link.follower_account_id,
          brokerPositionId: link.follower_position_id,
          comment: `wsa:close:${ev.strategy_id.slice(0, 8)}`,
        });
        logCopyTiming(ev.id, "follower close broker response", startedAt, {
          followerAccountId: link.follower_account_id,
          brokerMs: Date.now() - brokerStartedAt,
        });
        await Promise.all([
          supabase.from("copy_trade_links").update({ status: "CLOSED", closed_at: new Date().toISOString(), error_code: null, error_message: null }).eq("id", link.id),
          supabase.from("copy_execution_logs").insert({ ...baseLog, action: "CLOSE", status: "SUCCESS", executed_lot: Number(link.copied_volume), broker_order_id: result.brokerOrderId ?? null, raw_response: result.rawResponse ?? null }),
        ]);
      } else {
        if (previousVolume > 0 && currentVolume < previousVolume) {
          const amount = Number(link.copied_volume) * ((previousVolume - currentVolume) / previousVolume);
          if (amount > 0) {
            await adapter.closeTrade({ accountId: link.follower_account_id, brokerPositionId: link.follower_position_id, volume: amount, comment: `wsa:partial:${ev.strategy_id.slice(0, 8)}` });
            await supabase.from("copy_trade_links").update({ copied_volume: Math.max(0, Number(link.copied_volume) - amount) }).eq("id", link.id);
          }
        }
        const result = await adapter.modifyTrade({
          accountId: link.follower_account_id,
          brokerPositionId: link.follower_position_id,
          stopLoss: ev.stop_loss === null ? null : Number(ev.stop_loss),
          takeProfit: ev.take_profit === null ? null : Number(ev.take_profit),
        });
        await supabase.from("copy_execution_logs").insert({ ...baseLog, action: "MODIFY", status: "SUCCESS", broker_order_id: result.brokerOrderId ?? null, raw_response: result.rawResponse ?? null });
      }
      summary.success++;
    } catch (error) {
      const code = error instanceof BrokerExecutionError ? error.code : COPY_ERROR.COPY_PROVIDER_ERROR;
      const message = (error instanceof Error ? error.message : "Broker execution failed").slice(0, 400);
      await Promise.all([
        supabase.from("copy_trade_links").update({ status: ev.event_type === "CLOSE" ? "OPEN" : link.status, error_code: code, error_message: message }).eq("id", link.id),
        supabase.from("copy_execution_logs").insert({ ...baseLog, action: ev.event_type, status: "FAILED", error_code: code, error_message: message }),
      ]);
      summary.failed++;
    }
  });
  logCopyTiming(ev.id, "linked event complete", startedAt, summary);
  return summary;
}

export async function closeAllStrategyPositions(strategyId: string): Promise<ExecSummary> {
  const supabase = createAdminClient();
  const adapter = createBrokerAdapter();
  if (!adapter.executionAvailable()) {
    throw new CopyError(COPY_ERROR.COPY_EXECUTION_NOT_CONFIGURED, "Live broker execution is disabled.", 501);
  }
  const [{ data: strategy }, { data: links }] = await Promise.all([
    supabase.from("copy_strategies").select("id, master_account_id").eq("id", strategyId).maybeSingle(),
    supabase.from("copy_trade_links").select("master_trade_id, symbol, side").eq("strategy_id", strategyId).eq("status", "OPEN").limit(5000),
  ]);
  if (!strategy) throw new CopyError(COPY_ERROR.COPY_STRATEGY_NOT_FOUND, "Strategy not found", 404);

  const unique = new Map((links ?? []).map((link) => [link.master_trade_id as string, link]));
  const total: ExecSummary = { attempted: 0, success: 0, failed: 0, skipped: 0 };
  for (const [masterTradeId, link] of unique) {
    const dedupeKey = `${strategyId}:${masterTradeId}:ARCHIVE_CLOSE`;
    const { data: event, error } = await supabase.from("copy_master_events").upsert({
      strategy_id: strategyId,
      master_account_id: strategy.master_account_id,
      event_type: "CLOSE",
      master_trade_id: masterTradeId,
      symbol: link.symbol,
      side: link.side,
      event_time: new Date().toISOString(),
      dedupe_key: dedupeKey,
      source: "WSA_ENGINE",
      raw_payload: { reason: "STRATEGY_ARCHIVED" },
    }, { onConflict: "dedupe_key" }).select("id, strategy_id, event_type, master_trade_id, symbol, side, volume, previous_volume, stop_loss, take_profit, event_time").single();
    if (error || !event) throw new Error(`Could not queue strategy close: ${error?.message}`);
    const result = await executeLinkedCloseOrModify(event as LinkedEvent, adapter);
    total.attempted += result.attempted;
    total.success += result.success;
    total.failed += result.failed;
    total.skipped += result.skipped;
  }
  if (total.failed === 0) {
    await supabase.from("copy_strategies").update({ status: "ARCHIVED", engine_status: "ARCHIVED", engine_error: null }).eq("id", strategyId);
  } else {
    await supabase.from("copy_strategies").update({ engine_status: "ERROR", engine_error: `${total.failed} follower position(s) could not be closed.` }).eq("id", strategyId);
  }
  return total;
}

export async function executeCopyForEvent(
  eventId: string | LinkedEvent,
  actorUserId: string | null,
  startedAtOverride?: number,
): Promise<ExecSummary> {
  const startedAt = startedAtOverride ?? Date.now();
  const supabase = createAdminClient();
  const ev = typeof eventId === "string"
    ? (await supabase
        .from("copy_master_events")
        .select("id, strategy_id, event_type, master_trade_id, symbol, side, volume, previous_volume, stop_loss, take_profit, event_time")
        .eq("id", eventId)
        .maybeSingle()).data
    : eventId;
  if (!ev) throw new CopyError(COPY_ERROR.COPY_DUPLICATE_EVENT, "Master event not found", 404);
  logCopyTiming(ev.id, "master event loaded", startedAt, {
    type: ev.event_type,
    symbol: ev.symbol,
  });
  const hotRuntime = getStrategyHotRuntime(ev.strategy_id);
  const [strategy, settings, followers] = hotRuntime
    ? [hotRuntime.strategy, hotRuntime.settings, hotRuntime.followers]
    : await Promise.all([
        getStrategyRowCached(ev.strategy_id),
        getCopyGlobalSettingsCached(),
        loadActiveFollowersCached(ev.strategy_id),
      ]);
  logCopyTiming(ev.id, "strategy/settings loaded", startedAt, {
    strategyId: strategy.id,
    provider: getBrokerProviderId(),
    hotRuntime: Boolean(hotRuntime),
  });

  // Safety gates — every one must pass before any broker call is even attempted.
  if (!settings.copyEnabled) {
    const reason = "Global copy is paused - live copy blocked.";
    await writeGlobalRuleEvent({
      ruleCode: "GLOBAL_COPY_PAUSED",
      reason,
      strategyId: strategy.id,
      masterEventId: ev.id,
      mode: "LIVE",
    });
    throw new CopyError(COPY_ERROR.COPY_RISK_BLOCKED, reason, 423);
  }
  if (settings.emergencyStopEnabled) {
    await writeGlobalRuleEvent({
      ruleCode: "EMERGENCY_STOP",
      reason: "Emergency stop is enabled - live copy blocked.",
      strategyId: strategy.id,
      masterEventId: ev.id,
      mode: "LIVE",
    });
    throw new CopyError(COPY_ERROR.COPY_EMERGENCY_STOP, "Emergency stop is enabled — live copy blocked.", 423);
  }
  if (!settings.liveCopyEnabled) {
    throw new CopyError(COPY_ERROR.COPY_LIVE_DISABLED, "Global live copy is disabled.", 403);
  }
  if (strategy.mode !== "LIVE" || !strategy.live_enabled) {
    throw new CopyError(COPY_ERROR.COPY_LIVE_DISABLED, "This strategy is not live-enabled.", 403);
  }

  void writeAuditLog({
    actorUserId,
    action: "COPY_LIVE_ATTEMPTED",
    entityType: "copy_master_event",
    entityId: ev.id,
    metadata: { strategyId: strategy.id },
  }).catch(() => undefined);

  // Provider gate: live execution must use the real broker adapter AND the
  // operator must have explicitly enabled execution (BROKER_EXECUTION_ENABLED).
  // Otherwise we refuse rather than fabricate an order.
  const adapter = createBrokerAdapter();
  if (!adapter.executionAvailable()) {
    throw new CopyError(
      COPY_ERROR.COPY_EXECUTION_NOT_CONFIGURED,
      "Live copy execution is not enabled. Set BROKER_EXECUTION_ENABLED=true (after demo testing) to allow live orders.",
      501,
    );
  }

  // OPEN creates the durable master-to-follower position mapping. CLOSE and
  // MODIFY reuse that mapping to operate on the follower's broker position.
  if (ev.event_type !== "OPEN") {
    logCopyTiming(ev.id, "close/modify routing", startedAt, { type: ev.event_type });
    return executeLinkedCloseOrModify(ev as LinkedEvent, adapter, startedAt);
  }

  const summary: ExecSummary = { attempted: 0, success: 0, failed: 0, skipped: 0 };
  if (followers.length === 0) return summary;
  logCopyTiming(ev.id, "followers loaded", startedAt, { followers: followers.length });

  const masterLot = ev.volume === null ? 0 : Number(ev.volume);
  const accountIds = followers.map((f) => f.follower_account_id);
  const [masterSnap, accountRules, statusByAccount] = hotRuntime
    ? [hotRuntime.masterSnap, hotRuntime.accountRules, hotRuntime.statusByAccount]
    : await Promise.all([
        getSnapshotCached(strategy.master_account_id),
        loadAccountRuleMapCached(accountIds),
        loadAccountStatusMapCached(accountIds),
      ]);
  const hotPathWarmup = getBrokerProviderId() !== "api2trade" || process.env.WSA_COPY_HOT_PATH_WARMUP === "true";
  if (hotPathWarmup) {
    await adapter.warmAccounts?.([strategy.master_account_id, ...accountIds]);
  }
  logCopyTiming(ev.id, "runtime gates loaded", startedAt, {
    followers: followers.length,
    premium: followers.filter((f) => f.tier === "PREMIUM").length,
    standard: followers.filter((f) => f.tier !== "PREMIUM").length,
    hotPathWarmup,
  });

  const executeFollower = async (
    f: Awaited<ReturnType<typeof loadActiveFollowers>>[number],
  ) => {
    const followerStartedAt = Date.now();
    const followerSymbol = mapFollowerSymbol(ev.symbol, f.symbol_mapping);
    const followerSide = reverseFollowerSide(ev.side, f.reverse_copy);
    const baseLog = {
      strategy_id: strategy.id,
      master_event_id: ev.id,
      follower_account_id: f.follower_account_id,
      trader_id: f.trader_id,
      mode: "LIVE" as const,
      symbol: followerSymbol,
      side: followerSide,
    };

    if (f.copy_new_trades_only && new Date(ev.event_time) < new Date(f.created_at)) {
      await supabase.from("copy_execution_logs").insert({
        ...baseLog,
        action: "SKIPPED",
        status: "SKIPPED",
        error_code: COPY_ERROR.FOLLOWER_NOT_ELIGIBLE,
        error_message: "Trade predates this follower setup; new trades only is enabled.",
      });
      summary.skipped++;
      return;
    }

    const accountStatus = statusByAccount.get(f.follower_account_id) ?? "DISCONNECTED";
    const accountRule = accountRules.get(f.follower_account_id);
    const hotFollowerRuntime = hotRuntime?.followerRuntimeByAccount.get(f.follower_account_id);
    const [generalRiskState, risk, followerSnap] = hotFollowerRuntime
      ? [hotFollowerRuntime.generalRiskState, hotFollowerRuntime.risk, hotFollowerRuntime.snapshot]
      : await Promise.all([
          getRiskEnforcementStateCached(f.follower_account_id),
          loadAccountRiskRuntimeCached(f.follower_account_id, "LIVE"),
          getSnapshotCached(f.follower_account_id),
        ]);
    if (generalRiskState?.blockedNewTrades) {
      const reason = generalRiskState.breachedRules.length > 0
        ? `General risk rule blocked new copied trades: ${generalRiskState.breachedRules.map((rule) => rule.name).join(", ")}.`
        : "General risk controls blocked new copied trades.";
      await Promise.all([
        supabase.from("copy_execution_logs").insert({
          ...baseLog,
          action: "SKIPPED",
          status: "SKIPPED",
          error_code: COPY_ERROR.COPY_RISK_BLOCKED,
          error_message: reason,
        }),
        supabase.from("copy_rule_events").insert({
          scope: "ACCOUNT",
          rule_code: "GENERAL_RISK_RULE",
          reason,
          trading_account_id: f.follower_account_id,
          strategy_id: strategy.id,
          master_event_id: ev.id,
          follower_id: f.id,
          mode: "LIVE",
          details: {
            source: "general_risk_engine",
            rules: generalRiskState.breachedRules.map((rule) => rule.ruleId),
          },
        }),
      ]);
      summary.skipped++;
      return;
    }
    const elig = evaluateFollowerEligibility({
      globalEmergencyStop: settings.emergencyStopEnabled || f.emergency_stop,
      globalCopyEnabled: settings.copyEnabled,
      accountCopyEnabled: f.copy_enabled && (accountRule?.copyEnabled ?? true),
      pauseOnDisconnect: settings.pauseOnDisconnect || f.pause_on_disconnect,
      followerStatus: f.status,
      consentAccepted: Boolean(f.consent_accepted_at),
      accountStatus,
      symbol: followerSymbol,
      symbolAllowlist: accountRule?.symbolAllowlist ?? f.symbol_allowlist ?? strategy.symbol_allowlist,
      symbolBlocklist: accountRule?.symbolBlocklist ?? f.symbol_blocklist ?? strategy.symbol_blocklist,
      openCopiedTrades: risk.openCopiedTrades,
      maxOpenTrades: lowestRuntimeLimit(f.max_open_trades, accountRule?.maxOpenCopiedPositions),
      globalMaxOpenTrades: settings.maxCopiedOpenPositions,
      currentDailyLossPercent: risk.currentDailyLossPercent,
      maxDailyLossPercent: lowestRuntimeLimit(
        f.max_daily_loss_percent === null ? null : Number(f.max_daily_loss_percent),
        accountRule?.maxDailyLossPercent,
      ),
      globalMaxDailyLossPercent: settings.maxDailyLossPercent,
      currentDrawdownPercent: risk.currentDrawdownPercent,
      maxDrawdownPercent: lowestRuntimeLimit(
        f.max_drawdown_percent === null ? null : Number(f.max_drawdown_percent),
        accountRule?.maxDrawdownPercent,
      ),
      globalMaxDrawdownPercent: settings.maxDrawdownPercent,
      consecutiveLosses: risk.consecutiveLosses,
      stopAfterLosses: accountRule?.stopAfterLosses,
    });
    if (!elig.eligible) {
      let eligibilityMessage = elig.reason;
      if (elig.reason === "Max open copied trades reached") {
        const { data: oppositePosition } = await supabase
          .from("copy_trade_links")
          .select("id")
          .eq("strategy_id", strategy.id)
          .eq("follower_account_id", f.follower_account_id)
          .eq("symbol", followerSymbol)
          .neq("side", followerSide)
          .eq("status", "OPEN")
          .limit(1)
          .maybeSingle();
        if (oppositePosition) {
          eligibilityMessage = `Max open copied trades reached. This master ${followerSide} is a new hedged position, not a close. Close the original master position to close its follower copy.`;
        }
      }
      await supabase.from("copy_execution_logs").insert({ ...baseLog, action: "SKIPPED", status: "SKIPPED", error_code: COPY_ERROR.FOLLOWER_NOT_ELIGIBLE, error_message: eligibilityMessage });
      const ruleEvent = buildRuleEvent({ eligibility: elig, accountId: f.follower_account_id, strategyId: strategy.id, masterEventId: ev.id, followerId: f.id, mode: "LIVE" });
      if (ruleEvent) await supabase.from("copy_rule_events").insert(ruleEvent);
      summary.skipped++;
      return;
    }

    const lot = calculateFollowerLot({
      masterLot,
      masterEquity: masterSnap?.equity ?? null,
      masterBalance: masterSnap?.balance ?? null,
      followerEquity: followerSnap?.equity ?? null,
      followerBalance: followerSnap?.balance ?? null,
      scalingMode: (
        (f.copy_mode ? copyModeToScalingMode(f.copy_mode) : null)
        ?? f.scaling_mode
        ?? strategy.default_scaling_mode
      ) as ScalingMode,
      riskMultiplier: f.lot_multiplier === null
        ? (f.risk_multiplier === null ? Number(strategy.risk_multiplier) : Number(f.risk_multiplier))
        : Number(f.lot_multiplier),
      fixedLot: f.fixed_lot === null ? null : Number(f.fixed_lot),
      minLot: f.min_lot === null ? null : Number(f.min_lot),
      maxLot: f.max_lot === null ? (strategy.max_follower_lot === null ? null : Number(strategy.max_follower_lot)) : Number(f.max_lot),
    });
    if (lot.lot <= 0) {
      await supabase.from("copy_execution_logs").insert({ ...baseLog, action: "SKIPPED", status: "SKIPPED", error_code: COPY_ERROR.COPY_INVALID_LOT, error_message: lot.reason, calculated_lot: 0 });
      summary.skipped++;
      return;
    }

    const lotEligibility = evaluateFollowerEligibility({
      globalEmergencyStop: settings.emergencyStopEnabled || f.emergency_stop,
      globalCopyEnabled: settings.copyEnabled,
      accountCopyEnabled: f.copy_enabled && (accountRule?.copyEnabled ?? true),
      followerStatus: f.status,
      consentAccepted: Boolean(f.consent_accepted_at),
      accountStatus,
      symbol: followerSymbol,
      proposedLot: lot.lot,
      maxLot: accountRule?.maxCopiedLots,
      globalMaxLot: settings.maxLotSize,
      slippagePoints: settings.maxSlippagePoints,
      maxSlippagePoints: settings.maxSlippagePoints,
      enforceSlippageAvailability: true,
    });
    if (!lotEligibility.eligible) {
      await supabase.from("copy_execution_logs").insert({ ...baseLog, action: "SKIPPED", status: "SKIPPED", error_code: COPY_ERROR.COPY_RISK_BLOCKED, error_message: lotEligibility.reason, calculated_lot: lot.lot });
      const ruleEvent = buildRuleEvent({ eligibility: lotEligibility, accountId: f.follower_account_id, strategyId: strategy.id, masterEventId: ev.id, followerId: f.id, mode: "LIVE" });
      if (ruleEvent) await supabase.from("copy_rule_events").insert(ruleEvent);
      summary.skipped++;
      return;
    }

    // ── Place the live order. Failures are logged, never faked; one follower's
    //    failure does not abort the others. ──
    summary.attempted++;
    try {
      const ultraFast = ultraPremiumCopyEnabled() && f.tier === "PREMIUM" && actorUserId === null;
      const ultraKey = `${ev.id}:${f.follower_account_id}:OPEN`;
      if (ultraFast) {
        if (inFlightUltraCopyKeys.has(ultraKey)) {
          summary.skipped++;
          return;
        }
        inFlightUltraCopyKeys.add(ultraKey);
      }

      const { data: reserved, error: reserveError } = ultraFast ? { data: null, error: null } : await supabase.from("copy_trade_links").insert({
        strategy_id: strategy.id,
        follower_id: f.id,
        follower_account_id: f.follower_account_id,
        trader_id: f.trader_id,
        master_trade_id: ev.master_trade_id,
        source_event_id: ev.id,
        symbol: followerSymbol,
        side: followerSide === "SELL" ? "SELL" : "BUY",
        copied_volume: lot.lot,
        status: "PENDING",
      }).select("id").single();

      let linkId = reserved?.id as string | undefined;
      if (!ultraFast && (reserveError || !linkId)) {
        if ((reserveError as { code?: string } | null)?.code !== "23505") {
          throw new Error(`Trade reservation failed: ${reserveError?.message}`);
        }
        const { data: existing } = await supabase
          .from("copy_trade_links")
          .select("id, status")
          .eq("source_event_id", ev.id)
          .eq("follower_account_id", f.follower_account_id)
          .maybeSingle();
        if (!existing || existing.status !== "FAILED") {
          summary.skipped++;
          return;
        }
        linkId = existing.id as string;
        await supabase.from("copy_trade_links").update({ status: "PENDING", error_code: null, error_message: null }).eq("id", linkId);
      }
      logCopyTiming(ev.id, "follower broker submit", startedAt, {
        followerAccountId: f.follower_account_id,
        tier: f.tier,
        symbol: followerSymbol,
        lot: lot.lot,
        followerPrepMs: Date.now() - followerStartedAt,
        ultraFast,
      });
      markExecutionPriority([strategy.master_account_id, f.follower_account_id]);
      const brokerStartedAt = Date.now();
      const result = await adapter.openTrade({
        accountId: f.follower_account_id,
        symbol: followerSymbol,
        side: followerSide === "SELL" ? "SELL" : "BUY",
        volume: lot.lot,
        stopLoss: ev.stop_loss === null ? null : Number(ev.stop_loss),
        takeProfit: ev.take_profit === null ? null : Number(ev.take_profit),
        slippage: settings.maxSlippagePoints,
        comment: `wsa:${strategy.id.slice(0, 8)}`,
      });
      logCopyTiming(ev.id, "follower broker response", startedAt, {
        followerAccountId: f.follower_account_id,
        tier: f.tier,
        brokerMs: Date.now() - brokerStartedAt,
      });
      markExecutionPriority([strategy.master_account_id, f.follower_account_id]);
      const linkWrite = linkId
        ? supabase.from("copy_trade_links").update({
          status: "OPEN",
          follower_position_id: result.brokerPositionId ?? result.brokerOrderId ?? null,
          follower_order_id: result.brokerOrderId ?? null,
          copied_volume: result.executedVolume ?? lot.lot,
          opened_at: new Date().toISOString(),
          error_code: null,
          error_message: null,
        }).eq("id", linkId)
        : supabase.from("copy_trade_links").upsert({
          strategy_id: strategy.id,
          follower_id: f.id,
          follower_account_id: f.follower_account_id,
          trader_id: f.trader_id,
          master_trade_id: ev.master_trade_id,
          source_event_id: ev.id,
          symbol: followerSymbol,
          side: followerSide === "SELL" ? "SELL" : "BUY",
          copied_volume: result.executedVolume ?? lot.lot,
          status: "OPEN",
          follower_position_id: result.brokerPositionId ?? result.brokerOrderId ?? null,
          follower_order_id: result.brokerOrderId ?? null,
          opened_at: new Date().toISOString(),
          error_code: null,
          error_message: null,
        }, { onConflict: "source_event_id,follower_account_id" });
      await linkWrite;
      void Promise.allSettled([
        supabase.from("copy_execution_logs").insert({
          ...baseLog,
          action: "OPEN",
          status: "SUCCESS",
          calculated_lot: lot.lot,
          executed_lot: result.executedVolume ?? lot.lot,
          broker_order_id: result.brokerOrderId ?? null,
          raw_response: result.rawResponse ?? null,
        }),
        logBrokerOperation({
          accountId: f.follower_account_id,
          userId: f.trader_id,
          operation: "OPEN_TRADE",
          status: "SUCCESS",
          safeMetadata: { strategyId: strategy.id, symbol: followerSymbol, lot: lot.lot },
        }),
      ]);
      summary.success++;
      logCopyTiming(ev.id, "follower completed", startedAt, {
        followerAccountId: f.follower_account_id,
        totalFollowerMs: Date.now() - followerStartedAt,
      });
      if (ultraFast) inFlightUltraCopyKeys.delete(ultraKey);
    } catch (err) {
      const ultraKey = `${ev.id}:${f.follower_account_id}:OPEN`;
      inFlightUltraCopyKeys.delete(ultraKey);
      const code = err instanceof BrokerExecutionError ? err.code : COPY_ERROR.COPY_PROVIDER_ERROR;
      const message = (err instanceof Error ? err.message : "Broker execution failed").slice(0, 400);
      await supabase.from("copy_trade_links").update({ status: "FAILED", error_code: code, error_message: message }).eq("source_event_id", ev.id).eq("follower_account_id", f.follower_account_id);
      void Promise.allSettled([
        supabase.from("copy_execution_logs").insert({
          ...baseLog,
          action: "OPEN",
          status: "FAILED",
          calculated_lot: lot.lot,
          error_code: code,
          error_message: message,
        }),
        logBrokerOperation({
          accountId: f.follower_account_id,
          userId: f.trader_id,
          operation: "OPEN_TRADE",
          status: "FAILED",
          errorCode: code,
          errorMessage: message,
          safeMetadata: { strategyId: strategy.id, symbol: followerSymbol },
        }),
      ]);
      summary.failed++;
      logCopyTiming(ev.id, "follower failed", startedAt, {
        followerAccountId: f.follower_account_id,
        totalFollowerMs: Date.now() - followerStartedAt,
        error: message,
      });
    }
  };

  const premiumFollowers = followers.filter((f) => f.tier === "PREMIUM");
  const standardFollowers = followers.filter((f) => f.tier !== "PREMIUM");
  const premiumDelay = getBrokerProviderId() === "api2trade" ? 0 : Math.max(0, strategy.premium_delay_ms);
  const standardDelay = Math.max(premiumDelay, strategy.standard_delay_ms);
  logCopyTiming(ev.id, "dispatching followers", startedAt, {
    premiumFollowers: premiumFollowers.length,
    standardFollowers: standardFollowers.length,
    premiumDelay,
    standardDelay,
  });

  await Promise.all([
    premiumFollowers.length
      ? (async () => {
          if (premiumDelay > 0) await new Promise((resolve) => setTimeout(resolve, premiumDelay));
          await inParallelBatches(premiumFollowers, 12, executeFollower);
        })()
      : Promise.resolve(),
    standardFollowers.length
      ? (async () => {
          if (standardDelay > 0) await new Promise((resolve) => setTimeout(resolve, standardDelay));
          await inParallelBatches(standardFollowers, 12, executeFollower);
        })()
      : Promise.resolve(),
  ]);

  logCopyTiming(ev.id, "copy event complete", startedAt, summary);
  return summary;
}

/** Admin-triggered retry of a FAILED live log. Re-runs the gated execution path. */
export async function retryCopyExecution(logId: string, actorUserId: string | null): Promise<ExecSummary> {
  const supabase = createAdminClient();
  const { data: log } = await supabase
    .from("copy_execution_logs")
    .select("id, master_event_id, mode, status")
    .eq("id", logId)
    .maybeSingle();
  if (!log) throw new CopyError(COPY_ERROR.COPY_DUPLICATE_EVENT, "Log not found", 404);
  if (log.mode !== "LIVE" || log.status !== "FAILED") {
    throw new CopyError(COPY_ERROR.VALIDATION_ERROR, "Only failed live executions can be retried.", 400);
  }
  // Re-runs all gates; today this surfaces COPY_EXECUTION_NOT_CONFIGURED.
  return executeCopyForEvent(log.master_event_id, actorUserId);
}

// ── Trader-facing (scoped to the authenticated trader) ───────────────────────

export interface TraderStrategyDto {
  id: string;
  name: string;
  description: string | null;
  mode: CopyStrategyDto["mode"];
  riskMultiplier: number;
  defaultScalingMode: ScalingMode;
  monthlyPrice: number;
  standardMonthlyPrice: number;
  premiumMonthlyPrice: number;
  standardBillingProductCode: string;
  premiumBillingProductCode: string;
  standardDelayMs: number;
  premiumDelayMs: number;
  currency: string;
  billingProductCode: string;
  engineStatus: "LIVE";
}

export async function listActiveStrategiesForTrader(): Promise<TraderStrategyDto[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("copy_strategies")
    .select("id, name, description, mode, risk_multiplier, default_scaling_mode, monthly_price, standard_monthly_price, premium_monthly_price, standard_billing_product_id, premium_billing_product_id, standard_delay_ms, premium_delay_ms, currency, engine_status, billing_product_id")
    .eq("status", "ACTIVE")
    .eq("live_enabled", true)
    .eq("engine_status", "LIVE")
    .not("standard_billing_product_id", "is", null)
    .not("premium_billing_product_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    mode: s.mode,
    riskMultiplier: Number(s.risk_multiplier),
    defaultScalingMode: s.default_scaling_mode as ScalingMode,
    monthlyPrice: Number(s.monthly_price),
    standardMonthlyPrice: Number(s.standard_monthly_price),
    premiumMonthlyPrice: Number(s.premium_monthly_price),
    standardBillingProductCode: `COPY_STRATEGY_${s.id.replaceAll("-", "").toUpperCase()}_STANDARD`,
    premiumBillingProductCode: `COPY_STRATEGY_${s.id.replaceAll("-", "").toUpperCase()}_PREMIUM`,
    standardDelayMs: s.standard_delay_ms,
    premiumDelayMs: s.premium_delay_ms,
    currency: s.currency,
    billingProductCode: `COPY_STRATEGY_${s.id.replaceAll("-", "").toUpperCase()}`,
    engineStatus: "LIVE" as const,
  }));
}

export async function listMySubscriptions(traderUserId: string): Promise<CopyFollowerDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("copy_strategy_followers")
    .select(
      "id, strategy_id, follower_account_id, trader_id, status, tier, scaling_mode, risk_multiplier, fixed_lot, max_lot, min_lot, copy_enabled, copy_mode, lot_multiplier, max_open_trades, max_daily_loss_percent, max_drawdown_percent, symbol_allowlist, symbol_blocklist, symbol_mapping, copy_new_trades_only, reverse_copy, pause_on_disconnect, emergency_stop, engine_status, engine_error, engine_synced_at, consent_accepted_at, created_at, copy_strategies(name), trading_accounts!follower_account_id(account_name)",
    )
    .eq("trader_id", traderUserId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Failed to fetch subscriptions: ${error.message}`);

  type SubscriptionRow = (typeof data)[number] & { tier?: "NORMAL" | "PREMIUM" | null };

  return ((data ?? []) as SubscriptionRow[]).map((r) => {
    const strat = (r as { copy_strategies?: { name?: string } }).copy_strategies;
    const acct = (r as { trading_accounts?: { account_name?: string } }).trading_accounts;
    return {
      id: r.id,
      strategyId: r.strategy_id,
      strategyName: strat?.name ?? null,
      followerAccountId: r.follower_account_id,
      followerAccountName: acct?.account_name ?? null,
      traderId: r.trader_id,
      status: r.status,
      scalingMode: r.scaling_mode,
      riskMultiplier: r.risk_multiplier === null ? null : Number(r.risk_multiplier),
      fixedLot: r.fixed_lot === null ? null : Number(r.fixed_lot),
      maxLot: r.max_lot === null ? null : Number(r.max_lot),
      copyEnabled: r.copy_enabled ?? true,
      copyMode: r.copy_mode ?? scalingModeToCopyMode(r.scaling_mode),
      lotMultiplier: r.lot_multiplier === null ? null : Number(r.lot_multiplier),
      minLot: r.min_lot === null ? null : Number(r.min_lot),
      maxOpenTrades: r.max_open_trades ?? null,
      maxDailyLossPercent: r.max_daily_loss_percent === null ? null : Number(r.max_daily_loss_percent),
      maxDrawdownPercent: r.max_drawdown_percent === null ? null : Number(r.max_drawdown_percent),
      allowedSymbols: r.symbol_allowlist ?? null,
      blockedSymbols: r.symbol_blocklist ?? null,
      symbolMapping: (r.symbol_mapping as Record<string, string> | null) ?? {},
      copyNewTradesOnly: r.copy_new_trades_only ?? true,
      reverseCopy: r.reverse_copy ?? false,
      pauseOnDisconnect: r.pause_on_disconnect ?? true,
      emergencyStop: r.emergency_stop ?? false,
      engineStatus: r.engine_status ?? "DRAFT",
      engineError: r.engine_error ?? null,
      engineSyncedAt: r.engine_synced_at ?? null,
      consentAcceptedAt: r.consent_accepted_at,
      createdAt: r.created_at,
      tier: r.tier ?? "NORMAL",
    };
  });
}

export async function followStrategy(
  traderUserId: string,
  strategyId: string,
  input: {
    followerAccountId: string;
    tier: "NORMAL" | "PREMIUM";
    scalingMode?: ScalingMode;
    riskMultiplier?: number;
    fixedLot?: number;
    maxLot?: number;
  },
): Promise<CopyFollowerDto> {
  const supabase = createAdminClient();

  // Strategy must exist and be ACTIVE.
  const { data: strat } = await supabase
    .from("copy_strategies")
    .select("id, status, live_enabled, engine_status")
    .eq("id", strategyId)
    .maybeSingle();
  if (!strat) throw new CopyError(COPY_ERROR.COPY_STRATEGY_NOT_FOUND, "Strategy not found", 404);
  if (strat.status !== "ACTIVE") throw new CopyError(COPY_ERROR.COPY_STRATEGY_NOT_FOUND, "Strategy is not active", 400);
  if (!strat.live_enabled || strat.engine_status !== "LIVE") {
    throw new CopyError(COPY_ERROR.COPY_EXECUTION_NOT_CONFIGURED, "This strategy is not live on the WSA engine.", 409);
  }

  // Follower account must belong to this trader.
  const { data: account } = await supabase
    .from("trading_accounts")
    .select("id, user_id, status, provider_account_id, account_usage")
    .eq("id", input.followerAccountId)
    .eq("user_id", traderUserId)
    .maybeSingle();
  if (!account) throw new CopyError(COPY_ERROR.FORBIDDEN, "Account not found or not yours", 403);
  if (account.account_usage !== "TRADER" || account.status !== "CONNECTED" || !account.provider_account_id) {
    throw new CopyError(COPY_ERROR.FOLLOWER_NOT_ELIGIBLE, "Connect and synchronize this trading account before following live strategies.", 409);
  }

  const { data, error } = await supabase
    .from("copy_strategy_followers")
    .upsert(
      {
        strategy_id: strategyId,
        follower_account_id: input.followerAccountId,
        trader_id: traderUserId,
        tier: input.tier,
        status: "ACTIVE",
        scaling_mode: input.scalingMode ?? null,
        risk_multiplier: input.riskMultiplier ?? null,
        fixed_lot: input.fixedLot ?? null,
        max_lot: input.maxLot ?? null,
        copy_mode: scalingModeToCopyMode(input.scalingMode ?? null),
        lot_multiplier: input.riskMultiplier ?? null,
        consent_accepted_at: new Date().toISOString(),
        paused_at: null,
        engine_status: "LIVE",
        engine_error: null,
        engine_synced_at: new Date().toISOString(),
      },
      { onConflict: "strategy_id,follower_account_id" },
    )
    .select(
      "id, strategy_id, follower_account_id, trader_id, status, scaling_mode, risk_multiplier, fixed_lot, max_lot, min_lot, copy_enabled, copy_mode, lot_multiplier, max_open_trades, max_daily_loss_percent, max_drawdown_percent, symbol_allowlist, symbol_blocklist, symbol_mapping, copy_new_trades_only, reverse_copy, pause_on_disconnect, emergency_stop, engine_status, engine_error, engine_synced_at, consent_accepted_at, created_at",
    )
    .single();
  if (error || !data) throw new Error(`Failed to follow strategy: ${error?.message}`);

  await writeAuditLog({
    actorUserId: traderUserId,
    action: "COPY_FOLLOWER_CHANGED",
    entityType: "copy_strategy_follower",
    entityId: data.id,
    metadata: { strategyId, action: "FOLLOW" },
  });

  return {
    id: data.id,
    strategyId: data.strategy_id,
    strategyName: null,
    followerAccountId: data.follower_account_id,
    followerAccountName: null,
    traderId: data.trader_id,
    status: data.status,
    scalingMode: data.scaling_mode,
    riskMultiplier: data.risk_multiplier === null ? null : Number(data.risk_multiplier),
    fixedLot: data.fixed_lot === null ? null : Number(data.fixed_lot),
    maxLot: data.max_lot === null ? null : Number(data.max_lot),
    copyEnabled: data.copy_enabled ?? true,
    copyMode: data.copy_mode ?? scalingModeToCopyMode(data.scaling_mode),
    lotMultiplier: data.lot_multiplier === null ? null : Number(data.lot_multiplier),
    minLot: data.min_lot === null ? null : Number(data.min_lot),
    maxOpenTrades: data.max_open_trades ?? null,
    maxDailyLossPercent: data.max_daily_loss_percent === null ? null : Number(data.max_daily_loss_percent),
    maxDrawdownPercent: data.max_drawdown_percent === null ? null : Number(data.max_drawdown_percent),
    allowedSymbols: data.symbol_allowlist ?? null,
    blockedSymbols: data.symbol_blocklist ?? null,
    symbolMapping: (data.symbol_mapping as Record<string, string> | null) ?? {},
    copyNewTradesOnly: data.copy_new_trades_only ?? true,
    reverseCopy: data.reverse_copy ?? false,
    pauseOnDisconnect: data.pause_on_disconnect ?? true,
    emergencyStop: data.emergency_stop ?? false,
    engineStatus: "LIVE",
    engineError: null,
    engineSyncedAt: new Date().toISOString(),
    consentAcceptedAt: data.consent_accepted_at,
    createdAt: data.created_at,
    tier: "NORMAL" as const,
  };
}

export async function updateMySubscription(
  traderUserId: string,
  subscriptionId: string,
  patch: { status?: "ACTIVE" | "PAUSED" | "REVOKED"; riskMultiplier?: number; maxLot?: number | null; scalingMode?: ScalingMode },
): Promise<void> {
  const supabase = createAdminClient();
  const { data: sub } = await supabase
    .from("copy_strategy_followers")
    .select("id, trader_id, strategy_id, follower_account_id")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (!sub) throw new CopyError(COPY_ERROR.FOLLOWER_NOT_FOUND, "Subscription not found", 404);
  if (sub.trader_id !== traderUserId) throw new CopyError(COPY_ERROR.FORBIDDEN, "Not your subscription", 403);

  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) {
    row.status = patch.status;
    row.paused_at = patch.status === "PAUSED" ? new Date().toISOString() : null;
  }
  if (patch.riskMultiplier !== undefined) row.risk_multiplier = patch.riskMultiplier;
  if (patch.maxLot !== undefined) row.max_lot = patch.maxLot;
  if (patch.scalingMode !== undefined) row.scaling_mode = patch.scalingMode;

  const { error } = await supabase.from("copy_strategy_followers").update(row).eq("id", subscriptionId);
  if (error) throw new Error(`Failed to update subscription: ${error.message}`);

  await supabase.from("copy_strategy_followers").update({
    engine_status: patch.status === "REVOKED" ? "REMOVED" : patch.status === "PAUSED" ? "PAUSED" : "LIVE",
    engine_error: null,
    engine_synced_at: new Date().toISOString(),
  }).eq("id", subscriptionId);

  await writeAuditLog({
    actorUserId: traderUserId,
    action: "COPY_FOLLOWER_CHANGED",
    entityType: "copy_strategy_follower",
    entityId: subscriptionId,
    metadata: { ...patch },
  });
}

export interface FollowerSettingsPatch {
  copyEnabled: boolean;
  copyMode: CopyFollowerDto["copyMode"];
  fixedLot: number | null;
  lotMultiplier: number | null;
  minLot: number | null;
  maxLot: number | null;
  maxOpenTrades: number | null;
  maxDailyLossPercent: number | null;
  maxDrawdownPercent: number | null;
  allowedSymbols: string[] | null;
  blockedSymbols: string[] | null;
  symbolMapping: Record<string, string>;
  copyNewTradesOnly: true;
  reverseCopy: boolean;
  pauseOnDisconnect: boolean;
  emergencyStop: boolean;
}

export async function updateMyFollowerSettings(
  traderUserId: string,
  subscriptionId: string,
  settings: FollowerSettingsPatch,
): Promise<void> {
  const supabase = createAdminClient();
  const { data: subscription } = await supabase
    .from("copy_strategy_followers")
    .select("id, trader_id, follower_account_id")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (!subscription) throw new CopyError(COPY_ERROR.FOLLOWER_NOT_FOUND, "Subscription not found", 404);
  if (subscription.trader_id !== traderUserId) {
    throw new CopyError(COPY_ERROR.FORBIDDEN, "Not your subscription", 403);
  }
  const scalingMode = copyModeToScalingMode(settings.copyMode);
  if (!scalingMode) {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "Risk-percent mode is coming soon and cannot be enabled yet.",
      400,
    );
  }
  const { error } = await supabase
    .from("copy_strategy_followers")
    .update({
      copy_enabled: settings.copyEnabled,
      copy_mode: settings.copyMode,
      scaling_mode: scalingMode,
      fixed_lot: settings.fixedLot,
      lot_multiplier: settings.lotMultiplier,
      risk_multiplier: settings.lotMultiplier,
      min_lot: settings.minLot,
      max_lot: settings.maxLot,
      max_open_trades: settings.maxOpenTrades,
      max_daily_loss_percent: settings.maxDailyLossPercent,
      max_drawdown_percent: settings.maxDrawdownPercent,
      symbol_allowlist: settings.allowedSymbols,
      symbol_blocklist: settings.blockedSymbols,
      symbol_mapping: settings.symbolMapping,
      copy_new_trades_only: true,
      copy_existing_trades: false,
      reverse_copy: settings.reverseCopy,
      pause_on_disconnect: settings.pauseOnDisconnect,
      emergency_stop: settings.emergencyStop,
    })
    .eq("id", subscriptionId);
  if (error) throw new Error(`Failed to update follower settings: ${error.message}`);
  await supabase.from("copy_strategy_followers").update({
    engine_error: null,
    engine_synced_at: new Date().toISOString(),
  }).eq("id", subscriptionId);
  await writeAuditLog({
    actorUserId: traderUserId,
    action: "COPY_FOLLOWER_CHANGED",
    entityType: "copy_strategy_follower",
    entityId: subscriptionId,
    metadata: {
      action: "SETTINGS_UPDATED",
      copyMode: settings.copyMode,
      copyEnabled: settings.copyEnabled,
      emergencyStop: settings.emergencyStop,
    },
  });
}

export async function listTraderCopyLogs(traderUserId: string): Promise<CopyLogDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("copy_execution_logs")
    .select(LOG_COLS)
    .eq("trader_id", traderUserId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`Failed to fetch logs: ${error.message}`);
  return (data ?? []).map(mapLog);
}
