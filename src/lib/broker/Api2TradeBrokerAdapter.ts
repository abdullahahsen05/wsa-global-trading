if (typeof window !== "undefined") {
  throw new Error("[wsa] Api2TradeBrokerAdapter is server-only.");
}

import type { TradeDto, TraderAccountSummary } from "@/lib/domain/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BROKER_EXEC_ERROR,
  BrokerExecutionError,
  type BrokerAdapter,
  type BrokerConnectionHealth,
  type BrokerExecutionResult,
  type BrokerQuote,
  type BrokerSymbolInfo,
  type BrokerSymbolSpecifications,
  type BrokerTradingState,
  type CancelOrderRequest,
  type CloseTradeRequest,
  type ExecutionStages,
  type ModifyTradeRequest,
  type OpenTradeRequest,
  type OrderKind,
} from "./BrokerAdapter";
import { classifyOrderType, mapOpenPositions, orderVolumeLots, positionTicket } from "./openPositions";
import { parseQuote, QUOTE_ENDPOINTS } from "./quote";
import {
  Api2TradeClient,
  type Api2TradeAccountDetails,
  type Api2TradeConnectionStatus,
  type Api2TradeOperation,
  type Api2TradeOrder,
  type Api2TradeSymbolSpecifications,
  loadApi2TradeConfig,
} from "./api2TradeClient";
import { publicApi2TradeError, publicBrokerConnectionError } from "./api2TradeErrors";
import { describeProviderFailure, evaluateExecutionResponse, readExecutionResponse } from "./tradeRetcodes";
import { readAccountFigures } from "./accountFigures";
import {
  estimateServerOffsetMs,
  extractCashFlows,
  isTradeRecord,
  orderNetProfit,
  resolveOrderTimes,
  type BrokerCashFlow,
} from "./orderNormalization";
import {
  backfillBudgetFromEnv,
  backfillDaysFromEnv,
  backfillOrderHistory,
  mergeBackfilledOrders,
  type BackfillMode,
  type BackfillState,
} from "./historyBackfill";
import { getDecryptedCredentials } from "@/lib/services/brokerCredentialService";

function isConnectedText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "connected" || normalized === "ok" || normalized.includes("connected");
}

function isConnectedStatus(value: Api2TradeConnectionStatus | string): boolean {
  if (typeof value === "string") return isConnectedText(value);
  return Boolean(value.isConnected);
}

/** Direction by the platform-wide rule (`openPositions.ts`): a sell limit / sell stop is a SELL too. */
function toSide(value: unknown): "BUY" | "SELL" {
  return classifyOrderType(value).side ?? "BUY";
}

/** 32-bit FNV-1a of a text, in hex: a stable stand-in id for a row the bridge sent without any id. */
function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The id a trade is stored under: the position id, else the ticket (an id of 0 is "none").
 * A row without any id gets one made of its own figures - the same row always gets the
 * same id, so a sync never stores it twice (a random id used to do exactly that).
 */
function tradeId(order: Api2TradeOrder): string {
  const found = positionTicket(order);
  if (found) return found;
  const fingerprint = [
    order.symbol,
    order.openTimestampUTC ?? order.openTime,
    order.closeTimestampUTC ?? order.closeTime,
    order.openPrice,
    order.closePrice,
    order.lots ?? order.volume,
    order.profit,
  ].join("|");
  return `anon-${stableHash(fingerprint)}`;
}

/** Everything in `OpenedOrders` that is not a pending order (pending orders are no trades yet). */
function isMarketRow(order: Api2TradeOrder): boolean {
  return !classifyOrderType(order.orderType ?? order.type ?? order.dealType).pending;
}

function orderVolume(order: Api2TradeOrder): number {
  // MT5 sometimes exposes integer volume in centi-lots. Prefer lots when present;
  // otherwise normalize very large integer-style values defensively.
  return orderVolumeLots(order);
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateTimeParam(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/**
 * `openTime` / `closeTime` are broker SERVER time (no zone); `openTimestampUTC` /
 * `closeTimestampUTC` are real UTC. `resolveOrderTimes` takes the UTC epoch first
 * and only falls back to the server-time text (converted with the offset the same
 * payload reveals), so trades land on the same clock as the equity snapshots.
 */
function mapOrder(
  accountId: string,
  order: Api2TradeOrder,
  status: "OPEN" | "CLOSED",
  currency: string,
  serverOffsetMs = 0,
): TradeDto {
  const id = tradeId(order);
  const { openedAt, closedAt } = resolveOrderTimes(order, status, { serverOffsetMs });
  return {
    id,
    shortTradeId: `LIVE-${id.slice(-8).toUpperCase()}`,
    accountId,
    symbol: order.symbol ?? "",
    side: toSide(order.orderType ?? order.type ?? order.dealType),
    status,
    volume: orderVolume(order),
    openPrice: Number(order.openPrice ?? 0),
    closePrice: status === "CLOSED" ? Number(order.closePrice ?? 0) : null,
    // A closed order's result is what reached the balance: profit + commission + swap.
    // An open order keeps the floating profit exactly as the broker reports it.
    profit: { amount: status === "CLOSED" ? orderNetProfit(order) : Number(order.profit ?? 0), currency },
    openedAt,
    closedAt,
  };
}

/**
 * The broker's answer to an order as a result, or the reason it was refused in words a
 * trader can act on ("Not enough free margin", "Invalid stop loss / take profit") - the
 * `comment` and `retcode` of the answer used to be thrown away.
 */
function interpretExecution(raw: unknown): BrokerExecutionResult {
  const response = readExecutionResponse(raw);
  const outcome = evaluateExecutionResponse(response);
  if (!outcome.ok) {
    throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_ERROR, outcome.message, 502, outcome.retry);
  }
  return {
    ok: true,
    brokerOrderId: outcome.orderId ?? undefined,
    brokerPositionId: outcome.positionId ?? undefined,
    ...(outcome.price !== null ? { executedPrice: outcome.price } : {}),
    ...(outcome.volume !== null ? { executedVolume: outcome.volume } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
    rawResponse: {
      ticket: response.ticket,
      order: response.order,
      orderId: response.orderId,
      positionId: response.positionId,
      message: response.message,
      comment: response.comment,
      retcode: response.retcode,
      code: response.code,
    },
  };
}

/** A call that failed on the way to the broker, as an error the callers understand. */
function asExecutionError(error: unknown): never {
  if (error instanceof BrokerExecutionError) throw error;
  const text = publicApi2TradeError(error);
  if (/did not answer/i.test(text)) {
    // The order may or may not exist: never offered to another symbol, never sent again by itself.
    throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_TIMEOUT, describeProviderFailure(error).message, 504);
  }
  // A refusal the bridge put into an HTTP answer or an error record: the broker said no.
  if (/request failed \(\d{3}\)|\bfailed:\s/i.test(text)) {
    const failure = describeProviderFailure(error);
    throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_ERROR, failure.message, 502, failure.retry);
  }
  throw error;
}

/** Pauses before the first and second repeat of an order the trade server declined for a moment (a requote). */
const REPEAT_PAUSES_MS = [120, 300];

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function operationFor(side: "BUY" | "SELL", kind: OrderKind): Api2TradeOperation {
  if (kind === "LIMIT") return side === "BUY" ? "BuyLimit" : "SellLimit";
  if (kind === "STOP") return side === "BUY" ? "BuyStop" : "SellStop";
  return side === "BUY" ? "Buy" : "Sell";
}

function normalizeProviderAccountId(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return normalizeProviderAccountId(record.id ?? record.uuid ?? record.accountId);
  }
  let token = String(value).trim();
  if (!token) return "";
  if (token.startsWith("{") || token.startsWith("[")) {
    try {
      return normalizeProviderAccountId(JSON.parse(token) as unknown);
    } catch {
      return "";
    }
  }
  if (
    (token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith("'") && token.endsWith("'"))
  ) {
    try {
      const parsed = JSON.parse(token) as unknown;
      if (typeof parsed === "string") token = parsed.trim();
    } catch {
      token = token.slice(1, -1).trim();
    }
  }
  return token;
}

function firstFiniteNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().toUpperCase();
  }
  return null;
}

function mapSymbolSpecifications(
  symbol: string,
  raw: Api2TradeSymbolSpecifications | null,
  accountCurrency: string | null,
): BrokerSymbolSpecifications | null {
  if (!raw) return null;
  const record = raw as Record<string, unknown>;
  const tickSize = firstFiniteNumber(record, [
    "tickSize",
    "tick_size",
    "tradeTickSize",
    "trade_tick_size",
    "point",
    "pointSize",
    "point_size",
  ]);
  const tickValue = firstFiniteNumber(record, [
    "tickValue",
    "tick_value",
    "tradeTickValue",
    "trade_tick_value",
    "tickValueProfit",
    "tick_value_profit",
  ]);
  const contractSize = firstFiniteNumber(record, [
    "contractSize",
    "contract_size",
    "tradeContractSize",
    "trade_contract_size",
    "lotSize",
    "lot_size",
  ]);
  const volumeStep = firstFiniteNumber(record, [
    "volumeStep",
    "volume_step",
    "lotStep",
    "lot_step",
    "volumeMinStep",
    "volume_min_step",
  ]);
  const minVolume = firstFiniteNumber(record, [
    "minVolume",
    "min_volume",
    "volumeMin",
    "volume_min",
    "minLot",
    "min_lot",
  ]);
  const maxVolume = firstFiniteNumber(record, [
    "maxVolume",
    "max_volume",
    "volumeMax",
    "volume_max",
    "maxLot",
    "max_lot",
  ]);
  const profitCurrency = firstString(record, [
    "profitCurrency",
    "profit_currency",
    "currencyProfit",
    "currency_profit",
    "currency",
  ]);
  const conversionRate = firstFiniteNumber(record, [
    "accountCurrencyConversionRate",
    "account_currency_conversion_rate",
    "conversionRate",
    "conversion_rate",
    "currencyRate",
    "currency_rate",
    "rate",
  ]);

  return {
    symbol,
    tickSize,
    tickValue,
    contractSize,
    volumeStep,
    minVolume,
    maxVolume,
    accountCurrency,
    profitCurrency,
    accountCurrencyConversionRate: conversionRate ?? (profitCurrency && accountCurrency && profitCurrency !== accountCurrency ? null : 1),
    rawResponse: raw,
  };
}

function isMissingApi2TradeClient(error: unknown): boolean {
  const message = publicApi2TradeError(error).toLowerCase();
  return message.includes("invalid_token")
    || message.includes("client with id")
    || message.includes("not found");
}

function isRecoverableApi2TradeSessionError(error: unknown): boolean {
  const message = publicApi2TradeError(error).toLowerCase();
  return isMissingApi2TradeClient(error)
    || message.includes("403")
    || message.includes("forbidden")
    || message.includes("401")
    || message.includes("unauthorized")
    || message.includes("checkconnect")
    || message.includes("connectionstatus");
}

const WARM_SESSION_TTL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.API2TRADE_WARM_SESSION_TTL_MS ?? "300000", 10) || 300_000,
);
const warmedSessions = new Map<string, { providerAccountId: string; expiresAt: number }>();
/** Sessions that are being checked / reconnected right now, so concurrent callers wait for the same preparation. */
const sessionsBeingPrepared = new Map<string, Promise<string>>();

/**
 * A session that has just answered a request is alive, so its "warm" window starts again.
 * Without this the window ran out five minutes after the status check even though the account
 * was being used all the time, and the next order paid for a database read and a status check
 * in front of it. A session that did die is still caught: the next call fails with a
 * recoverable error and `withSessionRetry` reconnects.
 */
function rememberWarmSession(accountId: string, providerAccountId: string): void {
  warmedSessions.set(accountId, { providerAccountId, expiresAt: Date.now() + WARM_SESSION_TTL_MS });
}

/** Adds a measured time to the stages object the caller handed over (nothing when it did not). */
function addStage(stages: ExecutionStages | undefined, key: "sessionMs" | "sendMs", startedAt: number): void {
  if (!stages) return;
  stages[key] = (stages[key] ?? 0) + Math.max(0, Date.now() - startedAt);
}
const SYMBOL_SPEC_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.API2TRADE_SYMBOL_SPEC_CACHE_MS ?? "900000", 10) || 900_000,
);
const SYMBOL_SPEC_MISS_TTL_MS = Math.min(60_000, SYMBOL_SPEC_TTL_MS);
const symbolSpecificationCache = new Map<string, { value: BrokerSymbolSpecifications | null; expiresAt: number }>();

// Price endpoint of the bridge: the one that answered (per process), or "none answers" for a while.
const QUOTE_ENDPOINT_MISSING_TTL_MS = 10 * 60 * 1000;
const QUOTE_MISS_TTL_MS = 15 * 1000;
let knownQuoteEndpoint: string | null = null;
let quoteEndpointMissingUntil = 0;
const quoteMisses = new Map<string, number>();

// The symbols of an account, as its broker spells them (the WSA Trade symbol picker, copy calibration).
const SYMBOL_LIST_TTL_MS = 15 * 60_000;
const SYMBOL_LIST_MISS_TTL_MS = 60_000;
const SYMBOL_LIST_MAX_ACCOUNTS = 500;
const symbolListCache = new Map<string, { value: BrokerSymbolInfo[]; expiresAt: number }>();

function symbolSpecCacheKey(accountId: string, symbol: string): string {
  return `${accountId}:${symbol.trim().toUpperCase()}`;
}

function getCachedSymbolSpecifications(accountId: string, symbol: string): BrokerSymbolSpecifications | null | undefined {
  const cached = symbolSpecificationCache.get(symbolSpecCacheKey(accountId, symbol));
  if (!cached || cached.expiresAt <= Date.now()) return undefined;
  return cached.value;
}

function setCachedSymbolSpecifications(accountId: string, symbol: string, value: BrokerSymbolSpecifications | null) {
  symbolSpecificationCache.set(symbolSpecCacheKey(accountId, symbol), {
    value,
    expiresAt: Date.now() + (value ? SYMBOL_SPEC_TTL_MS : SYMBOL_SPEC_MISS_TTL_MS),
  });
}

// ── deposits / withdrawals seen in the history ───────────────────────────────
// `fetchTradeHistory` returns trades only; the balance operations it saw on the
// way are parked here (module level, because every sync creates a new adapter)
// until the sync picks them up with `takeCashFlows`.
const CASH_FLOW_STASH_TTL_MS = 5 * 60_000;
const cashFlowStash = new Map<string, { flows: BrokerCashFlow[]; at: number }>();
/** When the history of an account that showed no balance operation was last searched for them. */
const cashFlowProbeAt = new Map<string, number>();
const CASH_FLOW_PROBE_EVERY_MS = 12 * 60 * 60_000;
const CASH_FLOW_LOOKBACK_MS = 365 * 24 * 60 * 60_000;

// ── older history (3M / 6M / 1Y charts) ──────────────────────────────────────
// The closed-orders list of the bridge is short. Once per account (and again
// weekly) the dated history is walked backwards - see historyBackfill.ts. The
// progress is kept per process; a restart only means one more pass.
// API2TRADE_HISTORY_BACKFILL_DAYS (default 365, 0 = off, at most 3650) and
// API2TRADE_HISTORY_BACKFILL_BUDGET_MS (default 12000) tune it.
const HISTORY_BACKFILL_DAYS = backfillDaysFromEnv(process.env.API2TRADE_HISTORY_BACKFILL_DAYS);
const HISTORY_BACKFILL_BUDGET_MS = backfillBudgetFromEnv(process.env.API2TRADE_HISTORY_BACKFILL_BUDGET_MS);
const historyBackfillStates = new Map<string, BackfillState>();
const HISTORY_BACKFILL_MAX_ACCOUNTS = 2000;

function stashCashFlows(accountId: string, flows: BrokerCashFlow[]) {
  const now = Date.now();
  for (const [key, entry] of cashFlowStash) {
    if (now - entry.at > CASH_FLOW_STASH_TTL_MS) cashFlowStash.delete(key);
  }
  if (flows.length > 0) cashFlowStash.set(accountId, { flows, at: now });
  else cashFlowStash.delete(accountId);
}

export class Api2TradeBrokerAdapter implements BrokerAdapter {
  private readonly config = loadApi2TradeConfig();
  private readonly client = this.config ? new Api2TradeClient(this.config) : null;

  executionAvailable(): boolean {
    return Boolean(this.client) && process.env.BROKER_EXECUTION_ENABLED === "true";
  }

  configured(): boolean {
    return Boolean(this.client);
  }

  private assertConfigured(): Api2TradeClient {
    if (!this.client) {
      throw new BrokerExecutionError(
        BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED,
        "Connection service is not configured. Set the required broker provider credentials first.",
        503,
      );
    }
    return this.client;
  }

  private async resolveProviderAccountId(accountId: string): Promise<string> {
    const warmed = warmedSessions.get(accountId);
    if (warmed && warmed.expiresAt > Date.now()) return warmed.providerAccountId;

    const supabase = createAdminClient();
    const { data } = await supabase
      .from("trading_accounts")
      .select("provider_account_id")
      .eq("id", accountId)
      .maybeSingle();
    if (!data) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.ACCOUNT_NOT_FOUND, "Trading account not found.", 404);
    }
    if (!data.provider_account_id) {
      throw new BrokerExecutionError(
        BROKER_EXEC_ERROR.ACCOUNT_NOT_CONNECTED,
        "This trading account has not been connected yet.",
        409,
      );
    }
    const providerAccountId = normalizeProviderAccountId(data.provider_account_id);
    if (!providerAccountId) {
      throw new BrokerExecutionError(
        BROKER_EXEC_ERROR.ACCOUNT_NOT_CONNECTED,
        "This trading account has an invalid broker connection reference. Reconnect the account to refresh it.",
        409,
      );
    }
    return providerAccountId;
  }

  private async reconnectWithStoredCredentials(
    accountId: string,
    providerAccountId: string,
  ): Promise<string | null> {
    const client = this.client;
    if (!client) return null;
    const credentials = await getDecryptedCredentials(accountId);
    if (!credentials) return null;

    const nextProviderAccountId = client.usesApiKeyAuth()
      ? await client.registerAccount({
          user: credentials.login,
          password: credentials.password,
          server: credentials.server,
          type: (credentials.platform ?? "mt5").toUpperCase() === "MT4" ? "MT4" : "MT5",
          name: credentials.server || accountId,
        })
      : await client.connectEx({
          id: providerAccountId,
          server: credentials.server,
          user: credentials.login,
          password: credentials.password,
          downloadOrderHistory: true,
        });

    if (nextProviderAccountId && nextProviderAccountId !== providerAccountId) {
      const supabase = createAdminClient();
      await supabase
        .from("trading_accounts")
        .update({
          provider_account_id: nextProviderAccountId,
          provider: "api2trade",
          sync_error: null,
        })
        .eq("id", accountId);
    }

    return nextProviderAccountId || providerAccountId;
  }

  private async checkApi2TradeSession(providerAccountId: string): Promise<boolean> {
    const client = this.assertConfigured();
    const status = await client.connectionStatus(providerAccountId).catch(() => client.checkConnect(providerAccountId));
    return isConnectedStatus(status);
  }

  private async ensureApi2TradeSession(accountId: string, providerAccountId: string): Promise<string> {
    const client = this.assertConfigured();
    try {
      if (await this.checkApi2TradeSession(providerAccountId)) return providerAccountId;
    } catch (error) {
      if (!isRecoverableApi2TradeSessionError(error)) throw error;
      if (client.usesApiKeyAuth()) {
        const refreshedProviderAccountId = await this.reconnectWithStoredCredentials(accountId, providerAccountId);
        if (!refreshedProviderAccountId) throw error;
        if (!(await this.checkApi2TradeSession(refreshedProviderAccountId).catch(() => false))) {
          throw new Error("Broker account reconnect was accepted but did not become active.");
        }
        return refreshedProviderAccountId;
      }
      const reconnected = await client.connectByToken(providerAccountId)
        .then(() => providerAccountId)
        .catch(async () => this.reconnectWithStoredCredentials(accountId, providerAccountId));
      if (!reconnected) throw error;
      if (!(await this.checkApi2TradeSession(reconnected).catch(() => false))) {
        throw new Error("Broker account reconnect was accepted but did not become active.");
      }
      return reconnected;
    }

    if (client.usesApiKeyAuth()) {
      const refreshedProviderAccountId = await this.reconnectWithStoredCredentials(accountId, providerAccountId);
      if (!refreshedProviderAccountId) {
        throw new Error("Broker account is not connected and could not be refreshed.");
      }
      if (!(await this.checkApi2TradeSession(refreshedProviderAccountId).catch(() => false))) {
        throw new Error("Broker account reconnect was accepted but did not become active.");
      }
      return refreshedProviderAccountId;
    }

    const tokenReconnectOk = await client.connectByToken(providerAccountId)
      .then(async () => this.checkApi2TradeSession(providerAccountId).catch(() => false))
      .catch(async (error) => {
        if (!isRecoverableApi2TradeSessionError(error)) return false;
        const refreshedProviderAccountId = await this.reconnectWithStoredCredentials(accountId, providerAccountId);
        return refreshedProviderAccountId
          ? this.checkApi2TradeSession(refreshedProviderAccountId).catch(() => false)
          : false;
      });
    if (!tokenReconnectOk) {
      throw new Error("Broker account is not connected and reconnect failed.");
    }
    return providerAccountId;
  }

  private async resolveReadyProviderAccountId(accountId: string): Promise<string> {
    const providerAccountId = await this.resolveProviderAccountId(accountId);
    const warmed = warmedSessions.get(accountId);
    if (warmed?.providerAccountId === providerAccountId && warmed.expiresAt > Date.now()) {
      return providerAccountId;
    }
    // A session that is not warm is prepared ONCE, however many calls need it at the same moment (an
    // order and the refresh of the panel, say): two status checks - and, for an account the bridge
    // dropped, two reconnects that could invalidate each other - would only be slower.
    const preparing = sessionsBeingPrepared.get(accountId);
    if (preparing) return preparing;
    const task = this.ensureApi2TradeSession(accountId, providerAccountId)
      .then((readyProviderAccountId) => {
        rememberWarmSession(accountId, readyProviderAccountId);
        return readyProviderAccountId;
      })
      .finally(() => {
        sessionsBeingPrepared.delete(accountId);
      });
    sessionsBeingPrepared.set(accountId, task);
    return task;
  }

  /**
   * Runs `operation` on a ready session. When `stages` is given it is filled in: `sessionMs` is
   * what getting (or recovering) the session cost - 0 when it was warm - and `sendMs` what the
   * operation itself took, so a slow order can be traced to the bridge or to the way to it.
   */
  private async withSessionRetry<T>(
    accountId: string,
    operation: (providerAccountId: string) => Promise<T>,
    stages?: ExecutionStages,
  ): Promise<T> {
    const sessionStartedAt = Date.now();
    let providerAccountId = await this.resolveReadyProviderAccountId(accountId);
    addStage(stages, "sessionMs", sessionStartedAt);

    const sendStartedAt = Date.now();
    try {
      const value = await operation(providerAccountId);
      addStage(stages, "sendMs", sendStartedAt);
      rememberWarmSession(accountId, providerAccountId);
      return value;
    } catch (error) {
      addStage(stages, "sendMs", sendStartedAt);
      if (!isRecoverableApi2TradeSessionError(error)) throw error;
      warmedSessions.delete(accountId);
      const recoveryStartedAt = Date.now();
      providerAccountId = await this.ensureApi2TradeSession(accountId, providerAccountId);
      rememberWarmSession(accountId, providerAccountId);
      addStage(stages, "sessionMs", recoveryStartedAt);

      const secondSendStartedAt = Date.now();
      try {
        return await operation(providerAccountId);
      } finally {
        addStage(stages, "sendMs", secondSendStartedAt);
      }
    }
  }

  async warmAccounts(accountIds: string[]): Promise<void> {
    const uniqueIds = Array.from(new Set(accountIds.filter(Boolean)));
    if (!uniqueIds.length || !this.client) return;

    const supabase = createAdminClient();
    const { data } = await supabase
      .from("trading_accounts")
      .select("id, provider_account_id")
      .in("id", uniqueIds);

    const rows = (data ?? [])
      .filter((row): row is { id: string; provider_account_id: string } => Boolean(row.provider_account_id));

    await Promise.all(rows.map(async (row) => {
      try {
        const readyProviderAccountId = await this.ensureApi2TradeSession(row.id, row.provider_account_id);
        rememberWarmSession(row.id, readyProviderAccountId);
      } catch {
        // The live execution path will surface the provider error for the
        // specific account. Warmup is only an optimization, never a fake pass.
      }
    }));
  }

  async registerAccount(params: {
    accountId: string;
    login: string;
    password: string;
    server: string;
    platform: "mt4" | "mt5";
    name: string;
  }): Promise<string> {
    const client = this.assertConfigured();
    if (client.usesApiKeyAuth()) {
      return client.registerAccount({
        user: params.login,
        password: params.password,
        server: params.server,
        type: params.platform.toUpperCase() === "MT4" ? "MT4" : "MT5",
        name: params.name,
      });
    }
    return client.connectEx({
      id: params.accountId,
      server: params.server,
      user: params.login,
      password: params.password,
      downloadOrderHistory: true,
    });
  }

  async verifyConnection(accountId: string): Promise<BrokerConnectionHealth> {
    const client = this.client;
    if (!client) {
      return {
        ok: false,
        provider: "api2trade",
        message: "Connection service is not configured.",
      };
    }
    try {
      const providerAccountId = await this.resolveProviderAccountId(accountId);
      const connectedProviderAccountId = await this.ensureApi2TradeSession(accountId, providerAccountId);
      return {
        ok: Boolean(connectedProviderAccountId),
        provider: "api2trade",
        message: connectedProviderAccountId ? "Broker connection is active." : "Broker connection is reconnecting.",
      };
    } catch (error) {
      return { ok: false, provider: "api2trade", message: publicBrokerConnectionError(error) };
    }
  }

  async fetchSnapshot(accountId: string): Promise<TraderAccountSummary> {
    const client = this.assertConfigured();
    const [summary, details, openOrders] = await this.withSessionRetry(accountId, async (providerAccountId) =>
      Promise.all([
        client.accountSummary(providerAccountId),
        client.accountDetails(providerAccountId).catch((): Api2TradeAccountDetails => ({})),
        client.openedOrders(providerAccountId).catch(() => []),
      ]),
    );
    // Throws on an incomplete answer: a half-loaded session must not be stored as "balance 0".
    const { balance, equity } = readAccountFigures(summary);
    const currency = summary.currency ?? details.currency ?? "USD";
    const marketRows = openOrders.filter(isMarketRow);
    return {
      accountId,
      accountName: details.accountName ?? "",
      brokerName: details.company ?? "WSA GLOBAL",
      serverName: details.serverName ?? null,
      platform: null,
      status: "CONNECTED",
      balance: { amount: balance, currency },
      equity: { amount: equity, currency },
      floatingPnl: { amount: Number((equity - balance).toFixed(2)), currency },
      // pending orders are no open trades
      openTradeCount: marketRows.length,
      drawdownPercent: balance > 0 ? Math.max(0, ((balance - equity) / balance) * 100) : 0,
      updatedAt: new Date().toISOString(),
      margin: finiteOrNull(summary.margin),
      freeMargin: finiteOrNull(summary.freeMargin),
      marginLevel: finiteOrNull(summary.marginLevel),
    };
  }

  async fetchOpenTrades(accountId: string): Promise<TradeDto[]> {
    const client = this.assertConfigured();
    const [summary, orders] = await this.withSessionRetry(accountId, async (providerAccountId) =>
      Promise.all([
        client.accountSummary(providerAccountId).catch(() => ({ currency: "USD" })),
        // the checked read: an answer that is not a list is an error here, never "no open trades"
        client.openedOrdersChecked(providerAccountId),
      ]),
    );
    const serverOffsetMs = estimateServerOffsetMs(orders) ?? 0;
    // A pending order is not a trade yet: it used to be listed as an open trade (a sell limit as a BUY).
    return orders
      .filter(isMarketRow)
      .map((order) => mapOrder(accountId, order, "OPEN", summary.currency ?? "USD", serverOffsetMs));
  }

  /** Figures and open positions of an account in one session round (the WSA Trade panel polls this). */
  async fetchTradingState(accountId: string): Promise<BrokerTradingState> {
    const client = this.assertConfigured();
    const [summary, orders] = await this.withSessionRetry(accountId, async (providerAccountId) =>
      Promise.all([client.accountSummary(providerAccountId), client.openedOrdersChecked(providerAccountId)]),
    );
    // Throws on an incomplete answer: a half-loaded session must not be shown as "balance 0".
    const { balance, equity } = readAccountFigures(summary);
    const { positions, pending, pendingOrders } = mapOpenPositions(orders);
    return {
      currency: summary.currency ?? "USD",
      balance,
      equity,
      floatingProfit: finiteOrNull(summary.profit) ?? Number((equity - balance).toFixed(2)),
      margin: finiteOrNull(summary.margin),
      freeMargin: finiteOrNull(summary.freeMargin),
      marginLevel: finiteOrNull(summary.marginLevel),
      readOnly: summary.isInvestor === true,
      positions,
      pending,
      pendingOrders,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Every symbol the account can trade, spelled the way its broker spells it. Empty when the
   * bridge has no symbol list. Kept for 15 minutes (a failed attempt for one), never throws.
   */
  async fetchSymbolList(accountId: string): Promise<BrokerSymbolInfo[]> {
    const cached = symbolListCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const client = this.client;
    if (!client) return [];
    let list: BrokerSymbolInfo[] = [];
    let ttl = SYMBOL_LIST_MISS_TTL_MS;
    try {
      list = await this.withSessionRetry(accountId, (providerAccountId) => client.symbolList(providerAccountId));
      if (list.length > 0) ttl = SYMBOL_LIST_TTL_MS;
    } catch {
      // the picker then falls back to what the person types - the next call asks again soon
    }
    if (symbolListCache.size >= SYMBOL_LIST_MAX_ACCOUNTS) symbolListCache.clear();
    symbolListCache.set(accountId, { value: list, expiresAt: Date.now() + ttl });
    return list;
  }

  /**
   * Bid / ask of a symbol, or null. Which price endpoint the bridge has is not
   * documented where we could read it: the first call tries a short list and
   * remembers the one that answers; when none does, nothing is asked again for ten
   * minutes (and an unknown symbol for fifteen seconds). Never throws - a price is
   * only a convenience next to the order ticket.
   */
  async fetchQuote(accountId: string, symbol: string): Promise<BrokerQuote | null> {
    const client = this.client;
    if (!client) return null;
    const now = Date.now();
    if (!knownQuoteEndpoint && now < quoteEndpointMissingUntil) return null;
    const key = `${accountId}|${symbol}`;
    if ((quoteMisses.get(key) ?? 0) > now) return null;

    try {
      const providerAccountId = await this.resolveReadyProviderAccountId(accountId);
      const endpoints = knownQuoteEndpoint ? [knownQuoteEndpoint] : QUOTE_ENDPOINTS;
      let notFound = 0;
      for (const endpoint of endpoints) {
        try {
          const parsed = parseQuote(await client.quoteVia(endpoint, providerAccountId, symbol), symbol);
          if (parsed) {
            knownQuoteEndpoint = endpoint;
            return { symbol, ...parsed };
          }
        } catch (error) {
          if (/\b404\b|not found/i.test(error instanceof Error ? error.message : "")) notFound += 1;
        }
      }
      if (!knownQuoteEndpoint && notFound === endpoints.length) {
        quoteEndpointMissingUntil = Date.now() + QUOTE_ENDPOINT_MISSING_TTL_MS;
      }
    } catch {
      // no ready session: the state call of the same poll reports that
    }
    if (quoteMisses.size > 500) quoteMisses.clear();
    quoteMisses.set(key, Date.now() + QUOTE_MISS_TTL_MS);
    return null;
  }

  async fetchTradeHistory(accountId: string, historyDays = 30): Promise<TradeDto[]> {
    const client = this.assertConfigured();
    const to = new Date();
    const safeHistoryDays = Math.min(Math.max(Math.floor(historyDays), 1), 3_650);
    const from = new Date(to.getTime() - safeHistoryDays * 24 * 60 * 60 * 1000);
    const [summary, providerOrders] = await this.withSessionRetry(accountId, async (providerAccountId) =>
      Promise.all([
        client.accountSummary(providerAccountId).catch(() => ({ currency: "USD" })),
        client.closedOrders(providerAccountId).then(async (closedOrders) => {
          if (closedOrders.length > 0) return closedOrders;
          const historyPositions = await client.historyPositionsByCloseTime({
            accountId: providerAccountId,
            from: dateTimeParam(from),
            to: dateTimeParam(to),
          }).catch(() => []);
          if (historyPositions.length > 0) return historyPositions;
          return client.orderHistory({
            accountId: providerAccountId,
            from: dateTimeParam(from),
            to: dateTimeParam(to),
          }).catch(() => []);
        }),
      ]),
    );
    // Older history than the bridge hands over by itself, so a 3M / 6M / 1Y chart has
    // something to draw (a pass of a few dated requests, never fatal, repeated weekly).
    const olderOrders = await this.backfillOlderHistory(accountId, providerOrders);
    const allOrders = olderOrders.length > 0 ? mergeBackfilledOrders(providerOrders, olderOrders) : providerOrders;

    // Deposits, withdrawals, credit and other balance rows sit in the same history;
    // they are not trades and must not show up as lot-size-0 "winners".
    const tradeOrders = allOrders.filter(
      (order) => isTradeRecord(order) && Boolean(order.symbol?.trim()),
    );
    const serverOffsetMs = estimateServerOffsetMs(tradeOrders) ?? 0;

    // ...but the deposits and withdrawals among them are kept apart for the growth curve.
    let cashFlows = extractCashFlows(allOrders, { serverOffsetMs });
    if (cashFlows.length === 0) cashFlows = await this.probeCashFlows(accountId, serverOffsetMs);
    stashCashFlows(accountId, cashFlows);

    return tradeOrders.map((order) => mapOrder(accountId, order, "CLOSED", summary.currency ?? "USD", serverOffsetMs));
  }

  /**
   * The orders older than `current` reaches, found by walking the dated order
   * history backwards (see historyBackfill.ts). Any problem gives "nothing older":
   * the normal sync is never held up by it.
   */
  private async backfillOlderHistory(accountId: string, current: Api2TradeOrder[]): Promise<Api2TradeOrder[]> {
    if (HISTORY_BACKFILL_DAYS <= 0) return [];
    try {
      const client = this.assertConfigured();
      const result = await backfillOrderHistory<Api2TradeOrder>({
        now: Date.now(),
        horizonDays: HISTORY_BACKFILL_DAYS,
        budgetMs: HISTORY_BACKFILL_BUDGET_MS,
        current,
        state: historyBackfillStates.get(accountId),
        fetchWindow: (fromMs, toMs, mode) =>
          this.withSessionRetry(accountId, async (providerAccountId) => {
            const window = {
              accountId: providerAccountId,
              from: dateTimeParam(new Date(fromMs)),
              to: dateTimeParam(new Date(toMs)),
            };
            // MT5 answers with positions, MT4 with orders; the endpoint that answered
            // first is the one asked for the other windows.
            if (mode !== "orders") {
              const positions = await client.historyPositionsByCloseTime(window).catch(() => []);
              if (positions.length > 0 || mode === "positions") {
                return { rows: positions, mode: (positions.length > 0 ? "positions" : mode) as BackfillMode | null };
              }
            }
            const orders = await client.orderHistory(window).catch(() => []);
            return { rows: orders, mode: (orders.length > 0 ? "orders" : mode) as BackfillMode | null };
          }),
      });
      if (historyBackfillStates.size >= HISTORY_BACKFILL_MAX_ACCOUNTS) historyBackfillStates.clear();
      historyBackfillStates.set(accountId, result.state);
      return result.rows;
    } catch {
      return [];
    }
  }

  takeCashFlows(accountId: string): BrokerCashFlow[] {
    const entry = cashFlowStash.get(accountId);
    cashFlowStash.delete(accountId);
    return entry && Date.now() - entry.at <= CASH_FLOW_STASH_TTL_MS ? entry.flows : [];
  }

  /**
   * Some bridges leave balance operations out of the closed-orders list. When a
   * history showed none, the dated order history is searched for them - at most
   * once every 12 hours per account, never fatal.
   */
  private async probeCashFlows(accountId: string, serverOffsetMs: number): Promise<BrokerCashFlow[]> {
    const now = Date.now();
    const last = cashFlowProbeAt.get(accountId) ?? 0;
    if (now - last < CASH_FLOW_PROBE_EVERY_MS) return [];
    cashFlowProbeAt.set(accountId, now);
    try {
      const client = this.assertConfigured();
      const history = await this.withSessionRetry(accountId, (providerAccountId) =>
        client.orderHistory({
          accountId: providerAccountId,
          from: dateTimeParam(new Date(now - CASH_FLOW_LOOKBACK_MS)),
          to: dateTimeParam(new Date(now)),
        }),
      );
      return extractCashFlows(history, { serverOffsetMs });
    } catch {
      return [];
    }
  }

  async fetchSymbolSpecifications(accountId: string, symbol: string): Promise<BrokerSymbolSpecifications | null> {
    const cached = getCachedSymbolSpecifications(accountId, symbol);
    if (cached !== undefined) return cached;

    const client = this.assertConfigured();
    const specifications = await this.withSessionRetry(accountId, async (providerAccountId) => {
      const [summary, raw] = await Promise.all([
        client.accountSummary(providerAccountId).catch(() => ({ currency: null })),
        client.symbolSpecifications(providerAccountId, symbol).catch(() => null),
      ]);
      return mapSymbolSpecifications(symbol, raw, summary.currency ?? null);
    });
    setCachedSymbolSpecifications(accountId, symbol, specifications);
    return specifications;
  }

  private assertExecutionAvailable(): void {
    if (!this.executionAvailable()) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED, "Broker execution is disabled.", 503);
    }
  }

  /**
   * One order call, with the session handling and the reading of the answer. When the
   * trade server says it did NOT execute the request and that asking again is fine (a
   * requote, a busy trade context), the same request is sent again up to twice after a
   * short pause - a copied trade used to be lost on the first requote. An answer that
   * never came (a time-out) is never repeated: the order may exist.
   */
  private async executeOrder(
    accountId: string,
    call: (providerAccountId: string) => Promise<unknown>,
    stages?: ExecutionStages,
  ): Promise<BrokerExecutionResult> {
    for (let attempt = 0; ; attempt += 1) {
      if (stages) stages.attempts = attempt + 1;
      try {
        const raw = await this.withSessionRetry(accountId, call, stages).catch(asExecutionError);
        return interpretExecution(raw);
      } catch (error) {
        const again = error instanceof BrokerExecutionError && error.retryable && attempt < REPEAT_PAUSES_MS.length;
        if (!again) throw error;
      }
      await pause(REPEAT_PAUSES_MS[attempt]);
    }
  }

  async openTrade(req: OpenTradeRequest): Promise<BrokerExecutionResult> {
    const client = this.assertConfigured();
    this.assertExecutionAvailable();
    const kind: OrderKind = req.orderKind ?? "MARKET";
    if (kind !== "MARKET" && !(typeof req.price === "number" && req.price > 0)) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.INVALID_REQUEST, "A pending order needs the price it waits for.", 400);
    }
    const result = await this.executeOrder(
      req.accountId,
      (providerAccountId) =>
        client.orderSend({
          accountId: providerAccountId,
          symbol: req.symbol,
          operation: operationFor(req.side, kind),
          volume: req.volume,
          price: kind === "MARKET" ? undefined : req.price,
          stopLoss: req.stopLoss,
          takeProfit: req.takeProfit,
          comment: req.comment,
          slippage: kind === "MARKET" ? req.slippage : undefined,
        }),
      req.stages,
    );
    return { ...result, executedVolume: result.executedVolume ?? req.volume };
  }

  async closeTrade(req: CloseTradeRequest): Promise<BrokerExecutionResult> {
    const client = this.assertConfigured();
    this.assertExecutionAvailable();
    return this.executeOrder(
      req.accountId,
      (providerAccountId) =>
        client.orderClose({
          accountId: providerAccountId,
          ticket: req.brokerPositionId,
          lots: req.volume,
          comment: req.comment,
        }),
      req.stages,
    );
  }

  async modifyTrade(req: ModifyTradeRequest): Promise<BrokerExecutionResult> {
    const client = this.assertConfigured();
    this.assertExecutionAvailable();
    return this.executeOrder(
      req.accountId,
      (providerAccountId) =>
        client.orderModify({
          accountId: providerAccountId,
          ticket: req.brokerPositionId,
          price: req.price,
          stopLoss: req.stopLoss,
          takeProfit: req.takeProfit,
        }),
      req.stages,
    );
  }

  /** Delete a pending order. */
  async cancelOrder(req: CancelOrderRequest): Promise<BrokerExecutionResult> {
    const client = this.assertConfigured();
    this.assertExecutionAvailable();
    return this.executeOrder(
      req.accountId,
      (providerAccountId) => client.orderCancel({ accountId: providerAccountId, ticket: req.brokerOrderId }),
      req.stages,
    );
  }

  async deactivateAccount(providerAccountId: string): Promise<void> {
    const client = this.assertConfigured();
    await client.disconnect(providerAccountId);
  }

  async reactivateAccount(): Promise<void> {
    throw new BrokerExecutionError(
      BROKER_EXEC_ERROR.NOT_IMPLEMENTED,
      "Reactivation requires reconnecting the stored MT4/MT5 credentials.",
      501,
    );
  }
}
