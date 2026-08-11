import type { TradeDto, TraderAccountSummary } from "@/lib/domain/types";

export interface BrokerConnectionHealth {
  ok: boolean;
  provider: string;
  message: string;
}

export interface OpenTradeRequest {
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  comment?: string | null;
  magic?: number | null;
  slippage?: number | null;
}

export interface CloseTradeRequest {
  accountId: string;
  brokerPositionId: string;
  symbol?: string;
  volume?: number | null;
  comment?: string | null;
}

export interface ModifyTradeRequest {
  accountId: string;
  brokerPositionId: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface BrokerExecutionResult {
  ok: boolean;
  brokerOrderId?: string;
  brokerPositionId?: string;
  executedVolume?: number;
  executedPrice?: number;
  rawResponse?: unknown;
}

export interface BrokerAdapter {
  verifyConnection(accountId: string): Promise<BrokerConnectionHealth>;
  fetchSnapshot(accountId: string): Promise<TraderAccountSummary>;
  fetchOpenTrades(accountId: string): Promise<TradeDto[]>;
  fetchTradeHistory(accountId: string): Promise<TradeDto[]>;

  /**
   * Optional low-latency preparation hook for adapters that maintain provider
   * sessions. Copy workers can call this before live bursts so order execution
   * does not pay a reconnect/status-check penalty on the hot path.
   */
  warmAccounts?(accountIds: string[]): Promise<void>;

  // Order execution (copy trading). Default-off until an operator enables it.
  /** True only when real order execution is wired AND explicitly enabled by env. */
  executionAvailable(): boolean;
  openTrade(req: OpenTradeRequest): Promise<BrokerExecutionResult>;
  closeTrade(req: CloseTradeRequest): Promise<BrokerExecutionResult>;
  modifyTrade(req: ModifyTradeRequest): Promise<BrokerExecutionResult>;
}

export const BROKER_EXEC_ERROR = {
  PROVIDER_NOT_CONFIGURED: "BROKER_PROVIDER_NOT_CONFIGURED",
  ACCOUNT_NOT_FOUND: "BROKER_ACCOUNT_NOT_FOUND",
  ACCOUNT_NOT_CONNECTED: "BROKER_ACCOUNT_NOT_CONNECTED",
  PROVIDER_ERROR: "BROKER_PROVIDER_ERROR",
  NOT_IMPLEMENTED: "BROKER_EXECUTION_NOT_IMPLEMENTED",
} as const;

export class BrokerExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 502,
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
