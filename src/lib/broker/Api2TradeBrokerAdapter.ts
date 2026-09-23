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
  type BrokerSymbolSpecifications,
  type CloseTradeRequest,
  type ModifyTradeRequest,
  type OpenTradeRequest,
} from "./BrokerAdapter";
import {
  Api2TradeClient,
  type Api2TradeAccountDetails,
  type Api2TradeConnectionStatus,
  type Api2TradeExecutionResponse,
  type Api2TradeOrder,
  type Api2TradeSymbolSpecifications,
  loadApi2TradeConfig,
} from "./api2TradeClient";
import { publicApi2TradeError, publicBrokerConnectionError } from "./api2TradeErrors";
import { getDecryptedCredentials } from "@/lib/services/brokerCredentialService";

function safeIso(value: unknown, fallback = new Date().toISOString()): string {
  if (value == null || value === "") return fallback;
  const date = typeof value === "number"
    ? new Date(value > 100_000_000_000 ? value : value * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function isConnectedText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "connected" || normalized === "ok" || normalized.includes("connected");
}

function isConnectedStatus(value: Api2TradeConnectionStatus | string): boolean {
  if (typeof value === "string") return isConnectedText(value);
  return Boolean(value.isConnected);
}

function toSide(value: unknown): "BUY" | "SELL" {
  if (value === 1 || value === "1") return "SELL";
  if (value === 0 || value === "0") return "BUY";
  const normalized = String(value ?? "").toUpperCase();
  return normalized.includes("SELL") ? "SELL" : "BUY";
}

function tradeId(order: Api2TradeOrder): string {
  return String(order.positionId ?? order.ticket ?? order.orderId ?? order.id ?? crypto.randomUUID());
}

function orderVolume(order: Api2TradeOrder): number {
  const raw = Number(order.lots || order.closeLots || order.volume || order.closeVolume || 0);
  // MT5 sometimes exposes integer volume in centi-lots. Prefer lots when present;
  // otherwise normalize very large integer-style values defensively.
  if (order.lots == null && order.closeLots == null && raw >= 100) return raw / 100_000_000;
  return raw;
}

function orderOpenTime(order: Api2TradeOrder): unknown {
  return order.openTime ?? order.openTimestampUTC;
}

function orderCloseTime(order: Api2TradeOrder): unknown {
  return order.closeTime ?? order.closeTimestampUTC;
}

function dateTimeParam(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function mapOrder(accountId: string, order: Api2TradeOrder, status: "OPEN" | "CLOSED", currency: string): TradeDto {
  const id = tradeId(order);
  const closeTime = status === "CLOSED" ? orderCloseTime(order) : null;
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
    profit: { amount: Number(order.profit ?? 0), currency },
    openedAt: safeIso(orderOpenTime(order)),
    closedAt: closeTime == null ? null : safeIso(closeTime),
  };
}

function responseOk(response: Api2TradeExecutionResponse): boolean {
  if (response.error) return false;
  if (response.success === true || response.done === true) return true;
  if (response.ticket || response.order || response.orderId || response.positionId) return true;
  const message = String(response.message ?? "").toLowerCase();
  return message.includes("done") || message.includes("success") || message.includes("placed");
}

function interpretExecution(response: Api2TradeExecutionResponse): BrokerExecutionResult {
  if (!responseOk(response)) {
      throw new BrokerExecutionError(
      BROKER_EXEC_ERROR.PROVIDER_ERROR,
      publicBrokerConnectionError(response.error ?? response.message ?? "Broker rejected the operation."),
      502,
    );
  }
  const orderId = response.orderId ?? response.order ?? response.ticket;
  const positionId = response.positionId ?? response.ticket ?? response.orderId ?? response.order;
  return {
    ok: true,
    brokerOrderId: orderId == null ? undefined : String(orderId),
    brokerPositionId: positionId == null ? undefined : String(positionId),
    rawResponse: {
      ticket: response.ticket,
      order: response.order,
      orderId: response.orderId,
      positionId: response.positionId,
      message: response.message,
      retcode: response.retcode,
      code: response.code,
    },
  };
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
const SYMBOL_SPEC_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.API2TRADE_SYMBOL_SPEC_CACHE_MS ?? "900000", 10) || 900_000,
);
const SYMBOL_SPEC_MISS_TTL_MS = Math.min(60_000, SYMBOL_SPEC_TTL_MS);
const symbolSpecificationCache = new Map<string, { value: BrokerSymbolSpecifications | null; expiresAt: number }>();

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
    const readyProviderAccountId = await this.ensureApi2TradeSession(accountId, providerAccountId);
    warmedSessions.set(accountId, {
      providerAccountId: readyProviderAccountId,
      expiresAt: Date.now() + WARM_SESSION_TTL_MS,
    });
    return readyProviderAccountId;
  }

  private async withSessionRetry<T>(
    accountId: string,
    operation: (providerAccountId: string) => Promise<T>,
  ): Promise<T> {
    let providerAccountId = await this.resolveReadyProviderAccountId(accountId);
    try {
      return await operation(providerAccountId);
    } catch (error) {
      if (!isRecoverableApi2TradeSessionError(error)) throw error;
      warmedSessions.delete(accountId);
      providerAccountId = await this.ensureApi2TradeSession(accountId, providerAccountId);
      warmedSessions.set(accountId, {
        providerAccountId,
        expiresAt: Date.now() + WARM_SESSION_TTL_MS,
      });
      return operation(providerAccountId);
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
        warmedSessions.set(row.id, {
          providerAccountId: readyProviderAccountId,
          expiresAt: Date.now() + WARM_SESSION_TTL_MS,
        });
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
    const balance = Number(summary.balance ?? 0);
    const equity = Number(summary.equity ?? balance);
    const currency = summary.currency ?? details.currency ?? "USD";
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
      openTradeCount: openOrders.length,
      drawdownPercent: balance > 0 ? Math.max(0, ((balance - equity) / balance) * 100) : 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async fetchOpenTrades(accountId: string): Promise<TradeDto[]> {
    const client = this.assertConfigured();
    const [summary, orders] = await this.withSessionRetry(accountId, async (providerAccountId) =>
      Promise.all([
        client.accountSummary(providerAccountId).catch(() => ({ currency: "USD" })),
        client.openedOrders(providerAccountId),
      ]),
    );
    return orders.map((order) => mapOrder(accountId, order, "OPEN", summary.currency ?? "USD"));
  }

  async fetchTradeHistory(accountId: string): Promise<TradeDto[]> {
    const client = this.assertConfigured();
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
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
    return providerOrders.map((order) => mapOrder(accountId, order, "CLOSED", summary.currency ?? "USD"));
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

  async openTrade(req: OpenTradeRequest): Promise<BrokerExecutionResult> {
    const client = this.assertConfigured();
    if (!this.executionAvailable()) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED, "Broker execution is disabled.", 503);
    }
    const result = interpretExecution(await this.withSessionRetry(req.accountId, async (providerAccountId) =>
      client.orderSend({
        accountId: providerAccountId,
        symbol: req.symbol,
        operation: req.side === "BUY" ? "Buy" : "Sell",
        volume: req.volume,
        stopLoss: req.stopLoss,
        takeProfit: req.takeProfit,
        comment: req.comment,
        slippage: req.slippage,
      }),
    ));
    return { ...result, executedVolume: req.volume };
  }

  async closeTrade(req: CloseTradeRequest): Promise<BrokerExecutionResult> {
    const client = this.assertConfigured();
    if (!this.executionAvailable()) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED, "Broker execution is disabled.", 503);
    }
    return interpretExecution(await this.withSessionRetry(req.accountId, async (providerAccountId) =>
      client.orderClose({
        accountId: providerAccountId,
        ticket: req.brokerPositionId,
        lots: req.volume,
        comment: req.comment,
      }),
    ));
  }

  async modifyTrade(req: ModifyTradeRequest): Promise<BrokerExecutionResult> {
    const client = this.assertConfigured();
    if (!this.executionAvailable()) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED, "Broker execution is disabled.", 503);
    }
    return interpretExecution(await this.withSessionRetry(req.accountId, async (providerAccountId) =>
      client.orderModify({
        accountId: providerAccountId,
        ticket: req.brokerPositionId,
        stopLoss: req.stopLoss,
        takeProfit: req.takeProfit,
      }),
    ));
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
