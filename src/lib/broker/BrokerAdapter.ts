import type { TradeDto, TraderAccountSummary } from "@/lib/domain/types";
import type { BrokerCashFlow } from "./orderNormalization";
import type { BrokerOpenPosition, BrokerPendingOrder } from "./openPositions";

export type { BrokerOpenPosition, BrokerPendingOrder, PendingKind } from "./openPositions";

export interface BrokerConnectionHealth {
  ok: boolean;
  provider: string;
  message: string;
}

/** MARKET executes now; LIMIT / STOP wait for `price` (a pending order). */
export type OrderKind = "MARKET" | "LIMIT" | "STOP";

/**
 * Where the time of one order call went. The caller creates the object and passes it with
 * the request; an adapter that measures fills it in (the others leave it empty). It never
 * changes what is sent - it only says how long each part took.
 */
export interface ExecutionStages {
  /** getting a ready broker session (a status check or a reconnect); 0 = it was already warm */
  sessionMs?: number;
  /** the order request(s) to the bridge, all attempts together */
  sendMs?: number;
  /** how often the request was sent (more than once after a requote or a busy trade context) */
  attempts?: number;
}

export interface OpenTradeRequest {
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  /** default MARKET */
  orderKind?: OrderKind;
  /** entry price of a pending order (required for LIMIT / STOP, ignored for MARKET) */
  price?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  comment?: string | null;
  magic?: number | null;
  slippage?: number | null;
  stages?: ExecutionStages;
}

export interface CloseTradeRequest {
  accountId: string;
  brokerPositionId: string;
  symbol?: string;
  volume?: number | null;
  comment?: string | null;
  stages?: ExecutionStages;
}

export interface ModifyTradeRequest {
  accountId: string;
  brokerPositionId: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** new entry price - only for a PENDING order */
  price?: number | null;
  stages?: ExecutionStages;
}

/** Cancel (delete) a pending order. */
export interface CancelOrderRequest {
  accountId: string;
  brokerOrderId: string;
  stages?: ExecutionStages;
}

/** One tradable symbol of a broker account, spelled the way THAT broker spells it. */
export interface BrokerSymbolInfo {
  name: string;
  description: string | null;
  /** the broker's folder, e.g. "Forex\\Majors" */
  path: string | null;
  digits: number | null;
}

export interface BrokerExecutionResult {
  ok: boolean;
  brokerOrderId?: string;
  brokerPositionId?: string;
  executedVolume?: number;
  executedPrice?: number;
  /** something the person should know ("only part of the volume was executed", "nothing was changed") */
  note?: string;
  rawResponse?: unknown;
}

export interface BrokerSymbolSpecifications {
  symbol: string;
  tickSize: number | null;
  tickValue: number | null;
  contractSize: number | null;
  volumeStep: number | null;
  minVolume: number | null;
  maxVolume: number | null;
  accountCurrency: string | null;
  profitCurrency: string | null;
  accountCurrencyConversionRate: number | null;
  rawResponse?: unknown;
}

/** What the WSA Trade panel needs of one account, read in one go: figures + open positions. */
export interface BrokerTradingState {
  currency: string;
  balance: number;
  equity: number;
  floatingProfit: number;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  /** connected with the read-only (investor) password: the account can be read but not traded */
  readOnly?: boolean;
  positions: BrokerOpenPosition[];
  /** pending (limit / stop) orders that can be shown and managed */
  pending: BrokerPendingOrder[];
  /** every pending order the broker listed, also the ones that could not be shown */
  pendingOrders: number;
  fetchedAt: string;
}

export interface BrokerQuote {
  symbol: string;
  bid: number;
  ask: number;
}

export interface BrokerAdapter {
  verifyConnection(accountId: string): Promise<BrokerConnectionHealth>;
  fetchSnapshot(accountId: string): Promise<TraderAccountSummary>;
  fetchOpenTrades(accountId: string): Promise<TradeDto[]>;
  fetchTradeHistory(accountId: string, historyDays?: number): Promise<TradeDto[]>;

  /**
   * Optional: the deposits and withdrawals seen by the last `fetchTradeHistory`
   * of this account (handed over once, then forgotten). They are not trades, but
   * the growth and drawdown curves need them.
   */
  takeCashFlows?(accountId: string): BrokerCashFlow[];

  /**
   * Optional low-latency preparation hook for adapters that maintain provider
   * sessions. Copy workers can call this before live bursts so order execution
   * does not pay a reconnect/status-check penalty on the hot path.
   */
  warmAccounts?(accountIds: string[]): Promise<void>;
  fetchSymbolSpecifications?(accountId: string, symbol: string): Promise<BrokerSymbolSpecifications | null>;

  /** Optional: account figures and open positions of one account (the WSA Trade panel). */
  fetchTradingState?(accountId: string): Promise<BrokerTradingState>;
  /**
   * Optional: the current bid / ask of a symbol. Null when the bridge has no quote
   * endpoint or does not know the symbol - the panel then just does not show a price.
   */
  fetchQuote?(accountId: string, symbol: string): Promise<BrokerQuote | null>;
  /**
   * Optional: every symbol the account can trade, with the broker's own spelling
   * ("EURUSD.r", "XAUUSDm", "GOLD"). Empty when the bridge cannot list them.
   */
  fetchSymbolList?(accountId: string): Promise<BrokerSymbolInfo[]>;

  // Order execution (copy trading). Default-off until an operator enables it.
  /** True only when real order execution is wired AND explicitly enabled by env. */
  executionAvailable(): boolean;
  openTrade(req: OpenTradeRequest): Promise<BrokerExecutionResult>;
  closeTrade(req: CloseTradeRequest): Promise<BrokerExecutionResult>;
  modifyTrade(req: ModifyTradeRequest): Promise<BrokerExecutionResult>;
  /** Optional: delete a pending order. */
  cancelOrder?(req: CancelOrderRequest): Promise<BrokerExecutionResult>;
}

export const BROKER_EXEC_ERROR = {
  PROVIDER_NOT_CONFIGURED: "BROKER_PROVIDER_NOT_CONFIGURED",
  ACCOUNT_NOT_FOUND: "BROKER_ACCOUNT_NOT_FOUND",
  ACCOUNT_NOT_CONNECTED: "BROKER_ACCOUNT_NOT_CONNECTED",
  PROVIDER_ERROR: "BROKER_PROVIDER_ERROR",
  /** the bridge did not answer in time: the order may or may not exist, it must never be sent again by itself */
  PROVIDER_TIMEOUT: "BROKER_PROVIDER_TIMEOUT",
  /** the request itself is incomplete (a pending order without a price ...) */
  INVALID_REQUEST: "BROKER_INVALID_REQUEST",
  NOT_IMPLEMENTED: "BROKER_EXECUTION_NOT_IMPLEMENTED",
} as const;

export class BrokerExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 502,
    /** the trade server said the request was certainly NOT executed (a requote): sending it again is safe */
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "BrokerExecutionError";
  }
}

export class BrokerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerConfigurationError";
  }
}
