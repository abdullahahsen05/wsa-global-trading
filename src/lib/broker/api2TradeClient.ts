if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeClient is server-only.");
}

import { publicApi2TradeError } from "./api2TradeErrors";
import { brokerFetch } from "./api2TradeTransport";
import { parseSymbolList, type ParsedSymbol } from "./symbolList";
import {
  api2TradeUsesApiKeyAuth,
  getResolvedApi2TradeBaseUrl,
  getResolvedApi2TradeEventsUrl,
} from "./provider";

// ── time limits ──────────────────────────────────────────────────────────────
// A request used to wait for as long as the network allowed, and one hung call stalls
// whatever awaits it (the copy worker's detection loop, a follower's order). Every call
// now has a limit; an answer that comes later is thrown away.
//   API2TRADE_REQUEST_TIMEOUT_MS  everything else                       (default 12 s)
//   API2TRADE_POLL_TIMEOUT_MS     OpenedOrders, read ~3 times a second   (default 5 s)
//   API2TRADE_ORDER_TIMEOUT_MS    OrderSend / Close / Modify / Delete   (default 20 s)
// An order that hits its limit may still have been executed at the broker - the caller
// reports it as failed to answer, it never retries it by itself.
function timeoutFromEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function requestTimeoutMs(endpoint: string): number {
  if (/^Order(Send|Close|Modify|Delete)/i.test(endpoint)) {
    return timeoutFromEnv("API2TRADE_ORDER_TIMEOUT_MS", 20_000, 3_000, 120_000);
  }
  if (/^OpenedOrders$/i.test(endpoint)) {
    return timeoutFromEnv("API2TRADE_POLL_TIMEOUT_MS", 5_000, 500, 60_000);
  }
  return timeoutFromEnv("API2TRADE_REQUEST_TIMEOUT_MS", 12_000, 1_000, 120_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// ── symbol specification endpoints ───────────────────────────────────────────
const SYMBOL_ENDPOINTS = ["SymbolInfo", "SymbolParams", "SymbolSpecification", "GetSymbolInfo", "MarketInfo"] as const;
const SYMBOL_ENDPOINT_MISSING_TTL_MS = 10 * 60_000;
let knownSymbolEndpoint: string | null = null;
const missingSymbolEndpoints = new Map<string, number>();

/** The HTTP answer of a path the server does not have (a plain "symbol not found" is not that). */
function answeredNoSuchEndpoint(error: unknown): boolean {
  return /request failed \((404|405|501)\)/i.test(publicApi2TradeError(error));
}

// ── symbol list and pending-order cancel endpoints ───────────────────────────
// Neither is documented where we could read it, so a short list is tried. The one that
// answered goes first next time, and a path the server answered "no such endpoint" for is
// skipped for ten minutes.
const SYMBOL_LIST_ENDPOINTS = ["SymbolList", "Symbols", "GetSymbols"] as const;
const CANCEL_ENDPOINTS = ["OrderDelete", "OrderDeleteSafe", "OrderCloseSafe"] as const;
let knownSymbolListEndpoint: string | null = null;
let knownCancelEndpoint: string | null = null;
const missingListEndpoints = new Map<string, number>();

/** Endpoints to try, the remembered one first, the ones known to be missing left out. */
function endpointsToTry(all: ReadonlyArray<string>, known: string | null, missing: Map<string, number>): string[] {
  const now = Date.now();
  const list = [
    ...(known ? [known] : []),
    ...all.filter((endpoint) => endpoint !== known && (missing.get(endpoint) ?? 0) <= now),
  ];
  return list.length > 0 ? list : [...all];
}

/** Test hook: forget which symbol endpoint answered. */
export function resetSymbolEndpointMemory(): void {
  knownSymbolEndpoint = null;
  missingSymbolEndpoints.clear();
  knownSymbolListEndpoint = null;
  knownCancelEndpoint = null;
  missingListEndpoints.clear();
}

/** The operation codes of the bridge's order calls (MetaTrader's own numbering). */
const OPERATION_CODES = { Buy: 0, Sell: 1, BuyLimit: 2, SellLimit: 3, BuyStop: 4, SellStop: 5 } as const;
export type Api2TradeOperation = keyof typeof OPERATION_CODES;

export interface Api2TradeConfig {
  baseUrl: string;
  eventsUrl?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  authMode: "basic" | "apikey";
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
  /** signed charges of the order (a cost is negative); `profit` alone is the gross result */
  commission?: number;
  swap?: number;
  fee?: number;
  state?: string | number;
  openTimestampUTC?: number;
  closeTimestampUTC?: number;
}

export interface Api2TradeEquityHistoryPoint {
  time?: string | number;
  balance?: number;
  equity?: number;
  balanceDrawdownRaw?: number;
  balanceDrawdownRelative?: number;
  equityDrawdownRaw?: number;
  equityDrawdownRelative?: number;
  realizedPL?: number;
  unrealizedPL?: number;
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
  logo?: string;
  logoUrl?: string;
  icon?: string;
  image?: string;
  website?: string;
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
  /** the trade server's own words ("Invalid stops", "No money") */
  comment?: string;
  error?: string;
  retcode?: number | string;
  code?: number | string;
  done?: boolean;
  success?: boolean;
  volume?: number;
  price?: number;
}

export interface Api2TradeRegisteredAccount {
  id?: string;
  uuid?: string;
  accountId?: string;
}

export type Api2TradeSymbolSpecifications = Record<string, unknown>;

/**
 * API2Trade returns order collections in two valid shapes: a raw array for
 * some endpoints and an envelope such as `{ orders: [...] }` for history
 * endpoints. Treat both as the same broker payload so a valid history never
 * disappears merely because the server used its paged response shape.
 */
function extractOrders(value: unknown): Api2TradeOrder[] {
  if (Array.isArray(value)) return value as Api2TradeOrder[];
  if (typeof value !== "object" || value === null) return [];

  const record = value as Record<string, unknown>;
  for (const key of ["orders", "positions", "data", "results"]) {
    if (Array.isArray(record[key])) return record[key] as Api2TradeOrder[];
  }
  return [];
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

function normalizeApi2TradeToken(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return normalizeApi2TradeToken(record.id ?? record.uuid ?? record.accountId);
  }
  let token = String(value).trim();
  if (!token) return "";
  if (token.startsWith("{") || token.startsWith("[")) {
    try {
      return normalizeApi2TradeToken(JSON.parse(token) as unknown);
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

export function loadApi2TradeConfig(): Api2TradeConfig | null {
  const baseUrl = getResolvedApi2TradeBaseUrl();
  const eventsUrl = getResolvedApi2TradeEventsUrl();
  const username = process.env.API2TRADE_USERNAME?.trim();
  const password = process.env.API2TRADE_PASSWORD?.trim();
  if (!baseUrl) return null;
  const authMode = api2TradeUsesApiKeyAuth() ? "apikey" as const : "basic" as const;
  if (authMode === "basic" && !(username && password)) return null;
  return {
    baseUrl: trimSlash(baseUrl),
    eventsUrl: eventsUrl ? trimSlash(eventsUrl) : undefined,
    apiKey: undefined,
    username: authMode === "basic" ? username : undefined,
    password: authMode === "basic" ? password : undefined,
    authMode,
  };
}

function isProviderErrorRecord(record: Record<string, unknown>): boolean {
  if (record.error) return true;
  const code = String(record.code ?? "").trim().toUpperCase();
  const message = String(record.message ?? "").trim();
  if (!code && !message) return false;
  if (
    /client with id .*not found|invalid[_ -]?account|invalid[_ -]?token|not authorized|unauthorized|forbidden|server .*not found|connection failed|failed|error/i
      .test(message)
  ) {
    return true;
  }
  if (code && /ERROR|INVALID|NOT_FOUND|UNAUTHORIZED|FORBIDDEN|FAILED|FAIL/.test(code)) return true;
  if (code && ["OK", "DONE", "SUCCESS", "CONNECTED"].includes(code)) return false;
  return false;
}

function parseProviderRecord(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function assertNoProviderError(value: unknown, endpoint: string): void {
  const record = typeof value === "string"
    ? parseProviderRecord(value)
    : typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  if (!record || !isProviderErrorRecord(record)) return;
  const code = record.code ? `${String(record.code)}: ` : "";
  const message = record.message ?? record.error ?? "Broker service returned an error.";
  throw new Error(publicApi2TradeError(`${endpoint} failed: ${code}${String(message)}`));
}

function assertRecord(value: unknown, endpoint: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    assertNoProviderError(record, endpoint);
    return record;
  }
  throw new Error("Broker service returned an unexpected response.");
}

export class Api2TradeClient {
  constructor(private readonly config: Api2TradeConfig) {}

  usesApiKeyAuth(): boolean {
    return this.config.authMode === "apikey";
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }
    if (this.config.username && this.config.password) {
      headers.Authorization = `Basic ${toBasicAuth(this.config.username, this.config.password)}`;
    }
    return headers;
  }

  authHeaders(): Record<string, string> {
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

  private accountParams(accountId: string): Record<string, string> {
    if (this.config.apiKey) {
      return {
        id: accountId,
        accountId,
      };
    }
    return { id: accountId };
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    endpoint: string,
    params: Record<string, string | number | boolean | null | undefined> = {},
    options?: {
      expectText?: boolean;
      body?: Record<string, string | number | boolean | null | undefined>;
    },
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}/${endpoint.replace(/^\/+/, "")}`);
    if (this.config.apiKey) {
      url.searchParams.set("api_key", this.config.apiKey);
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = this.headers();
    let body: string | undefined;
    if (options?.body) {
      body = JSON.stringify(Object.fromEntries(
        Object.entries(options.body).filter(([, value]) => value !== undefined && value !== null && value !== ""),
      ));
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = requestTimeoutMs(endpoint);
    let response: Response;
    let bodyText: string;
    try {
      // one signal covers the connection, the headers and the body
      response = await brokerFetch(url, {
        method,
        headers,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      bodyText = await response.text();
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(
          publicApi2TradeError(`Broker service did not answer ${endpoint} within ${Math.round(timeoutMs / 1000)}s.`),
        );
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(publicApi2TradeError(`Broker service request failed (${response.status}): ${bodyText}`));
    }
    assertNoProviderError(bodyText, endpoint);
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
    method: "GET" | "POST",
    primaryEndpoint: string,
    fallbackEndpoint: string,
    params: Record<string, string | number | boolean | null | undefined> = {},
    body?: Record<string, string | number | boolean | null | undefined>,
    fallbackParams?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<T> {
    try {
      return await this.request<T>(method, primaryEndpoint, params, body ? { body } : undefined);
    } catch (error) {
      if (!shouldFallbackToSafeExecutionEndpoint(error)) {
        throw error;
      }
      return this.request<T>("GET", fallbackEndpoint, { ...params, ...(fallbackParams ?? body) });
    }
  }

  async registerAccount(params: {
    user: string;
    password: string;
    server: string;
    type: "MT4" | "MT5";
    name: string;
  }): Promise<string> {
    const normalizedType = params.type.toUpperCase() as "MT4" | "MT5";
    const providerType = normalizedType === "MT4" ? "Metatrader 4" : "Metatrader 5";
    const result = await this.request<unknown>("GET", "RegisterAccount", {
      user: params.user,
      login: params.user,
      password: params.password,
      server: params.server,
      type: providerType,
      name: params.name,
    });
    if (typeof result === "string") {
      const token = normalizeApi2TradeToken(result);
      if (token) return token;
    }
    const record = assertRecord(result, "RegisterAccount") as Api2TradeRegisteredAccount;
    const token = normalizeApi2TradeToken(record.id ?? record.uuid ?? record.accountId);
    if (!token) {
      throw new Error("Broker service did not return an account token.");
    }
    return token;
  }

  async connectEx(params: {
    id: string;
    server: string;
    user: string;
    password: string;
    downloadOrderHistory?: boolean;
  }): Promise<string> {
    const result = await this.request<string>("GET", "ConnectEx", {
      id: params.id,
      server: params.server,
      user: params.user,
      password: params.password,
      downloadOrderHistory: params.downloadOrderHistory ?? true,
      reconnectOnSymbolUpdate: true,
    }, { expectText: true });
    assertNoProviderError(result, "ConnectEx");
    const token = normalizeApi2TradeToken(result);
    if (!token) {
      throw new Error("Broker service did not return an account token.");
    }
    return token;
  }

  async connectByToken(accountId: string): Promise<string> {
    const result = await this.request<string>("GET", "ConnectByToken", this.accountParams(accountId), { expectText: true });
    assertNoProviderError(result, "ConnectByToken");
    const token = normalizeApi2TradeToken(result);
    if (!token) throw new Error("Broker service did not reconnect the account session.");
    return token;
  }

  async subscribeOrderUpdate(accountId: string): Promise<string> {
    return this.request<string>("GET", "SubscribeOrderUpdate", this.accountParams(accountId), { expectText: true });
  }

  async checkConnect(accountId: string): Promise<string | Api2TradeConnectionStatus> {
    const result = await this.request<unknown>("GET", "CheckConnect", this.accountParams(accountId));
    assertNoProviderError(result, "CheckConnect");
    return result as string | Api2TradeConnectionStatus;
  }

  async connectionStatus(accountId: string): Promise<Api2TradeConnectionStatus> {
    const result = await this.request<unknown>("GET", "ConnectionStatus", this.accountParams(accountId));
    return assertRecord(result, "ConnectionStatus") as Api2TradeConnectionStatus;
  }

  async disconnect(accountId: string): Promise<string> {
    if (this.config.apiKey) {
      return this.request<string>("GET", "DeleteAccount", this.accountParams(accountId), { expectText: true });
    }
    return this.request<string>("GET", "Disconnect", this.accountParams(accountId), { expectText: true });
  }

  async searchBroker(company: string, seedAccountId?: string): Promise<Api2TradeCompanySearchResult[]> {
    const result = await this.request<unknown>("GET", "Search", {
      company,
      ...(seedAccountId ? this.accountParams(seedAccountId) : {}),
    });
    return Array.isArray(result) ? result as Api2TradeCompanySearchResult[] : [];
  }

  async accountSummary(accountId: string): Promise<Api2TradeAccountSummary> {
    const result = await this.request<unknown>("GET", "AccountSummary", this.accountParams(accountId));
    return assertRecord(result, "AccountSummary") as Api2TradeAccountSummary;
  }

  async accountDetails(accountId: string): Promise<Api2TradeAccountDetails> {
    const result = await this.request<unknown>("GET", "AccountDetails", this.accountParams(accountId));
    return assertRecord(result, "AccountDetails") as Api2TradeAccountDetails;
  }

  async symbolSpecifications(accountId: string, symbol: string): Promise<Api2TradeSymbolSpecifications | null> {
    const params = {
      ...this.accountParams(accountId),
      symbol,
    };
    // The bridge's endpoint for this is not documented, so a list is tried. The one that
    // answered last goes first, and an endpoint that answered "no such endpoint" before
    // another one gave a real answer is skipped for ten minutes - the first copy of a
    // symbol used to pay for every failed probe, one after the other.
    const now = Date.now();
    const endpoints = [
      ...(knownSymbolEndpoint ? [knownSymbolEndpoint] : []),
      ...SYMBOL_ENDPOINTS.filter(
        (endpoint) => endpoint !== knownSymbolEndpoint && (missingSymbolEndpoints.get(endpoint) ?? 0) <= now,
      ),
    ];
    if (endpoints.length === 0) endpoints.push(...SYMBOL_ENDPOINTS);
    const failedWithoutEndpoint: string[] = [];
    let lastError: unknown = null;
    for (const endpoint of endpoints) {
      try {
        const result = await this.request<unknown>("GET", endpoint, params);
        knownSymbolEndpoint = endpoint;
        for (const failed of failedWithoutEndpoint) missingSymbolEndpoints.set(failed, now + SYMBOL_ENDPOINT_MISSING_TTL_MS);
        if (Array.isArray(result)) {
          const match = result.find((item) => {
            if (typeof item !== "object" || item === null) return false;
            const value = String((item as Record<string, unknown>).symbol ?? (item as Record<string, unknown>).name ?? "");
            return value.toUpperCase() === symbol.toUpperCase();
          });
          return match && typeof match === "object" ? match as Api2TradeSymbolSpecifications : null;
        }
        return typeof result === "object" && result !== null ? result as Api2TradeSymbolSpecifications : null;
      } catch (error) {
        if (answeredNoSuchEndpoint(error)) failedWithoutEndpoint.push(endpoint);
        lastError = error;
      }
    }
    void lastError;
    return null;
  }

  /**
   * Every symbol the account can trade, spelled the way its broker spells it. Throws only
   * when no endpoint answered at all; an answer that holds no symbol is an empty list.
   */
  async symbolList(accountId: string): Promise<ParsedSymbol[]> {
    const params = this.accountParams(accountId);
    const failedWithoutEndpoint: string[] = [];
    let lastError: unknown = null;
    for (const endpoint of endpointsToTry(SYMBOL_LIST_ENDPOINTS, knownSymbolListEndpoint, missingListEndpoints)) {
      try {
        const result = await this.request<unknown>("GET", endpoint, params);
        knownSymbolListEndpoint = endpoint;
        const now = Date.now();
        for (const failed of failedWithoutEndpoint) missingListEndpoints.set(failed, now + SYMBOL_ENDPOINT_MISSING_TTL_MS);
        return parseSymbolList(result);
      } catch (error) {
        if (answeredNoSuchEndpoint(error)) failedWithoutEndpoint.push(endpoint);
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("The broker service has no list of symbols.");
  }

  async openedOrders(accountId: string): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("GET", "OpenedOrders", this.accountParams(accountId));
    return extractOrders(result);
  }

  /**
   * The same call for the copy engine, which treats the answer as THE list of open
   * positions: an answer that says something else (a text such as "not connected", an
   * object) is an error here instead of "no open orders" - otherwise one bad answer
   * would look like the master closing every trade at once. A completely empty body
   * (some bridges answer that way when nothing is open) is still an empty list, as it
   * always was.
   */
  async openedOrdersChecked(accountId: string): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("GET", "OpenedOrders", this.accountParams(accountId));
    if (result === null || result === undefined) return [];
    if (!Array.isArray(result)) {
      throw new Error("Broker service returned an unexpected answer for the open positions.");
    }
    return result as Api2TradeOrder[];
  }

  /**
   * Raw answer of one price endpoint (`quote.ts` reads it). Which endpoint exists
   * is not documented anywhere we could read, so the adapter tries a short list.
   */
  async quoteVia(endpoint: string, accountId: string, symbol: string): Promise<unknown> {
    return this.request<unknown>("GET", endpoint, { ...this.accountParams(accountId), symbol });
  }

  async closedOrders(accountId: string): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("GET", "ClosedOrders", this.accountParams(accountId));
    return extractOrders(result);
  }

  async orderHistory(params: {
    accountId: string;
    from: string;
    to: string;
  }): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("GET", "OrderHistory", {
      ...this.accountParams(params.accountId),
      from: params.from,
      to: params.to,
      sort: 1,
      ascending: false,
    });
    return extractOrders(result);
  }

  /**
   * The paged history endpoint includes broker Balance operations (deposits and
   * withdrawals) when ignoreDepositWithdraw is false. Keep this explicit: the
   * dashboard must never infer cash movements from an equity delta.
   */
  async orderHistoryWithCashTransfers(params: {
    accountId: string;
    from: string;
    to: string;
    ordersPerPage?: number;
    pageNumber?: number;
  }): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("GET", "OrderHistoryPagination", {
      ...this.accountParams(params.accountId),
      from: params.from,
      to: params.to,
      ordersPerPage: params.ordersPerPage ?? 500,
      pageNumber: params.pageNumber ?? 0,
      requestAgain: false,
      sort: "OpenTime",
      ascending: true,
      ignoreDepositWithdraw: false,
    });
    return extractOrders(result);
  }

  async equityHistory(params: {
    accountId: string;
    from: string;
    excludeSameBars?: boolean;
  }): Promise<Api2TradeEquityHistoryPoint[]> {
    const result = await this.request<unknown>("GET", "EquityHistory", {
      ...this.accountParams(params.accountId),
      from: params.from,
      excludeSameBars: params.excludeSameBars ?? true,
    });
    return Array.isArray(result) ? result as Api2TradeEquityHistoryPoint[] : [];
  }

  async historyPositionsByCloseTime(params: {
    accountId: string;
    from: string;
    to: string;
  }): Promise<Api2TradeOrder[]> {
    const result = await this.request<unknown>("GET", "HistoryPositionsByCloseTime", {
      ...this.accountParams(params.accountId),
      from: params.from,
      to: params.to,
    });
    return extractOrders(result);
  }

  async orderSend(params: {
    accountId: string;
    symbol: string;
    operation: Api2TradeOperation;
    volume: number;
    /** entry price of a pending order (BuyLimit ... SellStop); a market order takes the current price */
    price?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    comment?: string | null;
    slippage?: number | null;
  }): Promise<Api2TradeExecutionResponse> {
    const operation = OPERATION_CODES[params.operation];
    if (!this.usesApiKeyAuth()) {
      const result = await this.request<unknown>("GET", "OrderSendSafe", {
        ...this.accountParams(params.accountId),
        symbol: params.symbol,
        operation,
        volume: params.volume,
        price: params.price,
        stoploss: params.stopLoss,
        takeprofit: params.takeProfit,
        comment: params.comment,
        slippage: params.slippage,
      });
      return assertRecord(result, "OrderSendSafe") as Api2TradeExecutionResponse;
    }
    const result = await this.requestWithExecutionFallback<unknown>(
      "POST",
      "OrderSend",
      "OrderSendSafe",
      this.accountParams(params.accountId),
      {
        symbol: params.symbol,
        operation,
        volume: params.volume,
        price: params.price,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        comment: params.comment,
        slippage: params.slippage,
      },
      {
        symbol: params.symbol,
        operation,
        volume: params.volume,
        price: params.price,
        stoploss: params.stopLoss,
        takeprofit: params.takeProfit,
        comment: params.comment,
        slippage: params.slippage,
      },
    );
    return assertRecord(result, "OrderSend") as Api2TradeExecutionResponse;
  }

  async orderClose(params: {
    accountId: string;
    ticket: string;
    lots?: number | null;
    comment?: string | null;
  }): Promise<Api2TradeExecutionResponse> {
    if (!this.usesApiKeyAuth()) {
      return this.request<Api2TradeExecutionResponse>("GET", "OrderCloseSafe", {
        ...this.accountParams(params.accountId),
        ticket: params.ticket,
        lots: params.lots,
        comment: params.comment,
      });
    }
    const result = await this.requestWithExecutionFallback<unknown>(
      "POST",
      "OrderClose",
      "OrderCloseSafe",
      this.accountParams(params.accountId),
      {
        ticket: params.ticket,
        volume: params.lots,
        lots: params.lots,
        comment: params.comment,
      },
      {
        ticket: params.ticket,
        lots: params.lots,
        comment: params.comment,
      },
    );
    return assertRecord(result, "OrderClose") as Api2TradeExecutionResponse;
  }

  async orderModify(params: {
    accountId: string;
    ticket: string;
    /** new entry price - only for a pending order */
    price?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }): Promise<Api2TradeExecutionResponse> {
    if (!this.usesApiKeyAuth()) {
      return this.request<Api2TradeExecutionResponse>("GET", "OrderModifySafe", {
        ...this.accountParams(params.accountId),
        ticket: params.ticket,
        price: params.price,
        stoploss: params.stopLoss,
        takeprofit: params.takeProfit,
      });
    }
    const result = await this.requestWithExecutionFallback<unknown>(
      "POST",
      "OrderModify",
      "OrderModifySafe",
      this.accountParams(params.accountId),
      {
        ticket: params.ticket,
        price: params.price,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        stoploss: params.stopLoss,
        takeprofit: params.takeProfit,
      },
      {
        ticket: params.ticket,
        price: params.price,
        stoploss: params.stopLoss,
        takeprofit: params.takeProfit,
      },
    );
    return assertRecord(result, "OrderModify") as Api2TradeExecutionResponse;
  }

  /**
   * Delete a pending order. The bridge's delete call is not documented where we could read
   * it: `OrderDelete`, `OrderDeleteSafe` and `OrderCloseSafe` are tried in turn. Only an
   * answer of "no such endpoint" moves on to the next one - a refusal from the broker
   * (the order is gone, trading is disabled) is the answer.
   */
  async orderCancel(params: {
    accountId: string;
    ticket: string;
  }): Promise<Api2TradeExecutionResponse> {
    const failedWithoutEndpoint: string[] = [];
    let lastError: unknown = null;
    for (const endpoint of endpointsToTry(CANCEL_ENDPOINTS, knownCancelEndpoint, missingListEndpoints)) {
      try {
        const result = await this.request<Api2TradeExecutionResponse>("GET", endpoint, {
          ...this.accountParams(params.accountId),
          ticket: params.ticket,
        });
        knownCancelEndpoint = endpoint;
        const now = Date.now();
        for (const failed of failedWithoutEndpoint) missingListEndpoints.set(failed, now + SYMBOL_ENDPOINT_MISSING_TTL_MS);
        return result;
      } catch (error) {
        if (!answeredNoSuchEndpoint(error)) throw error;
        failedWithoutEndpoint.push(endpoint);
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("The broker service cannot delete pending orders.");
  }
}
