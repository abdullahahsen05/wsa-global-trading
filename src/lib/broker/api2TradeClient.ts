if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeClient is server-only.");
}

import { publicApi2TradeError } from "./api2TradeErrors";
import {
  getResolvedApi2TradeBaseUrl,
  getResolvedApi2TradeEventsUrl,
} from "./provider";

export interface Api2TradeConfig {
  baseUrl: string;
  eventsUrl?: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface Api2TradeAccountSummary {
  balance?: number;
  credit?: number;
  profit?: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  marginLevel?: number;
  leverage?: number;
  currency?: string;
  type?: string;
  isInvestor?: boolean;
}

export interface Api2TradeAccountDetails {
  serverName?: string;
  user?: number | string;
  host?: string;
  port?: number;
  serverTime?: string;
  company?: string;
  currency?: string;
  accountName?: string;
  accountType?: string;
  accountLeverage?: number;
  isInvestor?: boolean;
}

export interface Api2TradeOrder {
  ticket?: number | string;
  id?: number | string;
  positionId?: number | string;
  orderId?: number | string;
  openTime?: string | number;
  closeTime?: string | number;
  type?: string | number;
  orderType?: string | number;
  dealType?: string | number;
  lots?: number;
  volume?: number;
  closeLots?: number;
  closeVolume?: number;
  symbol?: string;
  openPrice?: number;
  closePrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  profit?: number;
  state?: string | number;
  openTimestampUTC?: number;
  closeTimestampUTC?: number;
}

export interface Api2TradeConnectionStatus {
  id?: string;
  isConnected?: boolean;
  connectTimeUTC?: string;
  lastQuoteTimeUTC?: string;
  clientIp?: string;
}

export interface Api2TradeCompanySearchResult {
  companyName?: string;
  results?: Array<{
    name?: string;
    access?: string[];
  }>;
}

export interface Api2TradeOrderUpdateSummary {
  openedOrders?: Api2TradeOrder[];
  update?: {
    order?: Api2TradeOrder;
    type?: number;
    closeByTicket?: number | string;
    deal?: Record<string, unknown>;
    trans?: Record<string, unknown>;
  };
  balance?: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  profit?: number;
  marginLevel?: number;
  credit?: number;
  user?: number | string;
}

export interface Api2TradeExecutionResponse {
  ticket?: number | string;
  order?: number | string;
  orderId?: number | string;
  positionId?: number | string;
  message?: string;
  error?: string;
  retcode?: number | string;
  code?: number | string;
  done?: boolean;
  success?: boolean;
}

function shouldFallbackToSafeExecutionEndpoint(error: unknown): boolean {
  const message = publicApi2TradeError(error).toLowerCase();
  return message.includes("404")
    || message.includes("405")
    || message.includes("501")
    || message.includes("not found")
    || message.includes("unknown")
    || message.includes("unsupported");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function toBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString("base64");
}

export function loadApi2TradeConfig(): Api2TradeConfig | null {
  const baseUrl = getResolvedApi2TradeBaseUrl();
  const eventsUrl = getResolvedApi2TradeEventsUrl();
  const apiKey = process.env.API2TRADE_API_KEY?.trim();
  const username = process.env.API2TRADE_USERNAME?.trim();
  const password = process.env.API2TRADE_PASSWORD?.trim();
  if (!baseUrl) return null;
  if (!apiKey && !(username && password)) return null;
  return { baseUrl: trimSlash(baseUrl), eventsUrl: eventsUrl ? trimSlash(eventsUrl) : undefined, apiKey, username, password };
}

function assertRecord(value: unknown, endpoint: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${endpoint} returned an unexpected response.`);
}

export class Api2TradeClient {
  constructor(private readonly config: Api2TradeConfig) {}

  private headers(): HeadersInit {
    if (this.config.apiKey) {
      return { "x-api-key": this.config.apiKey };
    }
    if (this.config.username && this.config.password) {
      return { Authorization: `Basic ${toBasicAuth(this.config.username, this.config.password)}` };
    }
    return {};
  }

  authHeaders(): HeadersInit {
    return this.headers();
  }

  basicAuthValue(): string | null {
    if (!this.config.username || !this.config.password) return null;
    return `Basic ${toBasicAuth(this.config.username, this.config.password)}`;
  }

  eventsUrl(path = "/events", params: Record<string, string | number | boolean | null | undefined> = {}): string {
    const configured = this.config.eventsUrl;
    const base = configured
      ? configured
      : this.config.baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    endpoint: string,
    params: Record<string, string | number | boolean | null | undefined> = {},
    options?: { expectText?: boolean },
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}/${endpoint.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
      cache: "no-store",
    });
    const bodyText = await response.text();
    if (!response.ok || response.status >= 201) {
      throw new Error(publicApi2TradeError(`API2Trade ${endpoint} failed (${response.status}): ${bodyText}`));
    }
    if (options?.expectText) return bodyText as T;
    if (!bodyText.trim()) return null as T;
    try {
      const parsed = JSON.parse(bodyText) as T;
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const error = (parsed as { error?: unknown }).error;
        if (error) throw new Error(publicApi2TradeError(String(error)));
      }
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return bodyText as T;
      }
      throw error;
    }
  }

  private async requestWithExecutionFallback<T>(
    primaryEndpoint: string,
    fallbackEndpoint: string,
    params: Record<string, string | number | boolean | null | undefined> = {},
  ): Promise<T> {
    try {
      return await this.request<T>(primaryEndpoint, params);
    } catch (error) {
      if (!shouldFallbackToSafeExecutionEndpoint(error)) {
        throw error;
      }
      return this.request<T>(fallbackEndpoint, params);
    }
  }

  async connectEx(params: {
    id: string;
    server: string;
    user: string;
    password: string;
    downloadOrderHistory?: boolean;
  }): Promise<string> {
    const result = await this.request<string>("ConnectEx", {
      id: params.id,
      server: params.server,
      user: params.user,
      password: params.password,
      downloadOrderHistory: params.downloadOrderHistory ?? true,
      reconnectOnSymbolUpdate: true,
    }, { expectText: true });
    const token = String(result ?? "").trim();
    if (!token) {
      throw new Error("API2Trade ConnectEx did not return an account token.");
    }
    return token;
  }

  async connectByToken(accountId: string): Promise<string> {
    return this.request<string>("ConnectByToken", { id: accountId }, { expectText: true });
  }

  async subscribeOrderUpdate(accountId: string): Promise<string> {
    return this.request<string>("SubscribeOrderUpdate", { id: accountId }, { expectText: true });
  }

  async checkConnect(accountId: string): Promise<string> {
    return this.request<string>("CheckConnect", { id: accountId }, { expectText: true });
  }

  async connectionStatus(accountId: string): Promise<Api2TradeConnectionStatus> {
    const result = await this.request<unknown>("ConnectionStatus", { id: accountId });
    return assertRecord(result, "ConnectionStatus") as Api2TradeConnectionStatus;
  }

  async disconnect(accountId: string): Promise<string> {
    return this.request<string>("Disconnect", { id: accountId }, { expectText: true });
  }

  async searchBroker(company: string): Promise<Api2TradeCompanySearchResult[]> {
    const result = await this.request<unknown>("Search", { company });
    return Array.isArray(result) ? result as Api2TradeCompanySearchResult[] : [];
  }

  async accountSummary(accountId: string): Promise<Api2TradeAccountSummary> {
    const result = await this.request<unknown>("AccountSummary", { id: accountId });
    return assertRecord(result, "AccountSummary") as Api2TradeAccountSummary;
  }

  async accountDetails(accountId: string): Promise<Api2TradeAccountDetails> {
    const result = await this.request<unknown>("AccountDetails", { id: accountId });
    return assertRecord(result, "AccountDetails") as Api2TradeAccountDetails;
  }

  async openedOrders(accountId: string): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("OpenedOrders", { id: accountId });
    return Array.isArray(result) ? result as Api2TradeOrder[] : [];
  }

  async closedOrders(accountId: string): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("ClosedOrders", { id: accountId });
    return Array.isArray(result) ? result as Api2TradeOrder[] : [];
  }

  async orderHistory(params: {
    accountId: string;
    from: string;
    to: string;
  }): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("OrderHistory", {
      id: params.accountId,
      from: params.from,
      to: params.to,
      sort: 1,
      ascending: false,
    });
    return Array.isArray(result) ? result as Api2TradeOrder[] : [];
  }

  async historyPositionsByCloseTime(params: {
    accountId: string;
    from: string;
    to: string;
  }): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("HistoryPositionsByCloseTime", {
      id: params.accountId,
      from: params.from,
      to: params.to,
    });
    return Array.isArray(result) ? result as Api2TradeOrder[] : [];
  }

  async orderSend(params: {
    accountId: string;
    symbol: string;
    operation: "Buy" | "Sell";
    volume: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
    comment?: string | null;
    slippage?: number | null;
  }): Promise<Api2TradeExecutionResponse> {
    const result = await this.requestWithExecutionFallback<unknown>("OrderSend", "OrderSendSafe", {
      id: params.accountId,
      symbol: params.symbol,
      operation: params.operation === "Buy" ? 0 : 1,
      volume: params.volume,
      stoploss: params.stopLoss,
      takeprofit: params.takeProfit,
      comment: params.comment,
      slippage: params.slippage,
    });
    return assertRecord(result, "OrderSend") as Api2TradeExecutionResponse;
  }

  async orderClose(params: {
    accountId: string;
    ticket: string;
    lots?: number | null;
    comment?: string | null;
  }): Promise<Api2TradeExecutionResponse> {
    const result = await this.requestWithExecutionFallback<unknown>("OrderClose", "OrderCloseSafe", {
      id: params.accountId,
      ticket: params.ticket,
      lots: params.lots,
      comment: params.comment,
    });
    return assertRecord(result, "OrderClose") as Api2TradeExecutionResponse;
  }

  async orderModify(params: {
    accountId: string;
    ticket: string;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }): Promise<Api2TradeExecutionResponse> {
    const result = await this.requestWithExecutionFallback<unknown>("OrderModify", "OrderModifySafe", {
      id: params.accountId,
      ticket: params.ticket,
      stoploss: params.stopLoss,
      takeprofit: params.takeProfit,
    });
    return assertRecord(result, "OrderModify") as Api2TradeExecutionResponse;
  }
}
