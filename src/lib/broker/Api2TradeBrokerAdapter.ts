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
  loadApi2TradeConfig,
} from "./api2TradeClient";
import { publicApi2TradeError } from "./api2TradeErrors";
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
      publicApi2TradeError(response.error ?? response.message ?? "API2Trade rejected the broker operation."),
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
        "API2Trade is not configured. Set API2TRADE_BASE_URL plus API2TRADE_API_KEY or API2TRADE_USERNAME/API2TRADE_PASSWORD.",
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
        "Account is not connected to API2Trade yet.",
        409,
      );
    }
    return data.provider_account_id as string;
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
        await this.checkApi2TradeSession(refreshedProviderAccountId).catch(() => true);
        return refreshedProviderAccountId;
      }
      const reconnected = await client.connectByToken(providerAccountId)
        .then(() => providerAccountId)
        .catch(async () => this.reconnectWithStoredCredentials(accountId, providerAccountId));
      if (!reconnected) throw error;
      return this.checkApi2TradeSession(reconnected).catch(() => true).then(() => reconnected);
    }

    if (client.usesApiKeyAuth()) {
      const refreshedProviderAccountId = await this.reconnectWithStoredCredentials(accountId, providerAccountId);
      if (!refreshedProviderAccountId) {
        throw new Error("API2Trade account is not connected and could not be re-registered.");
      }
      await this.checkApi2TradeSession(refreshedProviderAccountId).catch(() => true);
      return refreshedProviderAccountId;
    }

    const tokenReconnectOk = await client.connectByToken(providerAccountId)
      .then(() => true)
      .catch(async (error) => {
        if (!isRecoverableApi2TradeSessionError(error)) return false;
        return Boolean(await this.reconnectWithStoredCredentials(accountId, providerAccountId));
      });
    if (!tokenReconnectOk) {
      throw new Error("API2Trade account is not connected and reconnect by token failed.");
    }
    await this.checkApi2TradeSession(providerAccountId).catch(() => true);
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
        message: "API2Trade is not configured.",
      };
    }
    try {
      const providerAccountId = await this.resolveProviderAccountId(accountId);
      const connectedProviderAccountId = await this.ensureApi2TradeSession(accountId, providerAccountId);
      return {
        ok: Boolean(connectedProviderAccountId),
        provider: "api2trade",
        message: connectedProviderAccountId ? "Connected to API2Trade." : "API2Trade account is reconnecting.",
      };
    } catch (error) {
      return { ok: false, provider: "api2trade", message: publicApi2TradeError(error) };
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
      "API2Trade reactivation requires reconnecting the stored MT4/MT5 credentials.",
      501,
    );
  }
}
