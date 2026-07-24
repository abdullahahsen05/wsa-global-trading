// ─────────────────────────────────────────────────────────────────────────────
// Copy Trading — shared types + typed errors
// ─────────────────────────────────────────────────────────────────────────────

export type CopyMode = "SIMULATION" | "LIVE";
export type StrategyStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
export type FollowerStatus = "PENDING" | "ACTIVE" | "PAUSED" | "DISABLED" | "REVOKED";
export type ScalingMode =
  | "FIXED_MULTIPLIER"
  | "BALANCE_PROPORTIONAL"
  | "EQUITY_PROPORTIONAL"
  | "FIXED_LOT";
export type MasterEventType = "OPEN" | "CLOSE" | "MODIFY";
export type LogAction = "OPEN" | "CLOSE" | "MODIFY" | "SKIPPED";
export type LogStatus = "PENDING" | "SUCCESS" | "FAILED" | "SKIPPED" | "RETRYING";

export const COPY_ERROR = {
  COPY_STRATEGY_NOT_FOUND: "COPY_STRATEGY_NOT_FOUND",
  MASTER_ACCOUNT_NOT_FOUND: "MASTER_ACCOUNT_NOT_FOUND",
  FOLLOWER_NOT_FOUND: "FOLLOWER_NOT_FOUND",
  FOLLOWER_NOT_ELIGIBLE: "FOLLOWER_NOT_ELIGIBLE",
  COPY_LIVE_DISABLED: "COPY_LIVE_DISABLED",
  COPY_EMERGENCY_STOP: "COPY_EMERGENCY_STOP",
  COPY_CONSENT_REQUIRED: "COPY_CONSENT_REQUIRED",
  COPY_DUPLICATE_EVENT: "COPY_DUPLICATE_EVENT",
  COPY_EXECUTION_NOT_CONFIGURED: "COPY_EXECUTION_NOT_CONFIGURED",
  COPY_PROVIDER_ERROR: "COPY_PROVIDER_ERROR",
  COPY_RISK_BLOCKED: "COPY_RISK_BLOCKED",
  COPY_INVALID_LOT: "COPY_INVALID_LOT",
  FORBIDDEN: "FORBIDDEN",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type CopyErrorCode = (typeof COPY_ERROR)[keyof typeof COPY_ERROR];

/** Typed copy-trading error. Routes map it to jsonFail(code, message, status), like AuthError. */
export class CopyError extends Error {
  constructor(
    public readonly code: CopyErrorCode,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "CopyError";
  }
}

export interface CopyStrategyDto {
  id: string;
  name: string;
  description: string | null;
  masterAccountId: string;
  masterAccountName: string | null;
  status: StrategyStatus;
  mode: CopyMode;
  liveEnabled: boolean;
  riskMultiplier: number;
  defaultScalingMode: ScalingMode;
  maxFollowerLot: number | null;
  maxOpenCopiedTrades: number | null;
  symbolAllowlist: string[] | null;
  symbolBlocklist: string[] | null;
  followerCount: number;
  engineStatus: "DRAFT" | "STARTING" | "LIVE" | "PAUSED" | "DRAINING" | "ERROR" | "ARCHIVED";
  engineError: string | null;
  engineHeartbeatAt: string | null;
  monthlyPrice: number;
  standardMonthlyPrice: number;
  premiumMonthlyPrice: number;
  standardBillingProductCode: string | null;
  premiumBillingProductCode: string | null;
  standardDelayMs: number;
  premiumDelayMs: number;
  currency: string;
  billingProductCode: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface MasterEventDto {
  id: string;
  strategyId: string;
  eventType: MasterEventType;
  masterTradeId: string;
  symbol: string;
  side: string | null;
  volume: number | null;
  openPrice: number | null;
  closePrice: number | null;
  eventTime: string;
  createdAt: string;
}

export type FollowerTier = "NORMAL" | "PREMIUM";
export type FollowerCopyMode = "FIXED_LOT" | "LOT_MULTIPLIER" | "BALANCE_RATIO" | "RISK_PERCENT";

export interface CopyFollowerDto {
  id: string;
  strategyId: string;
  strategyName: string | null;
  followerAccountId: string;
  followerAccountName: string | null;
  traderId: string;
  status: FollowerStatus;
  tier: FollowerTier;
  scalingMode: ScalingMode | null;
  riskMultiplier: number | null;
  fixedLot: number | null;
  maxLot: number | null;
  copyEnabled: boolean;
  copyMode: FollowerCopyMode;
  lotMultiplier: number | null;
  minLot: number | null;
  maxOpenTrades: number | null;
  maxDailyLossPercent: number | null;
  maxDrawdownPercent: number | null;
  allowedSymbols: string[] | null;
  blockedSymbols: string[] | null;
  symbolMapping: Record<string, string>;
  copyNewTradesOnly: boolean;
  reverseCopy: boolean;
  pauseOnDisconnect: boolean;
  emergencyStop: boolean;
  engineStatus: "DRAFT" | "LIVE" | "PAUSED" | "ERROR" | "REMOVED";
  engineError: string | null;
  engineSyncedAt: string | null;
  consentAcceptedAt: string | null;
  createdAt: string;
}

export interface CopyLogDto {
  id: string;
  strategyId: string;
  strategyName: string;
  masterEventId: string;
  followerAccountId: string | null;
  traderId: string | null;
  mode: CopyMode;
  action: LogAction;
  status: LogStatus;
  calculatedLot: number | null;
  executedLot: number | null;
  symbol: string | null;
  side: string | null;
  brokerOrderId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface CopyGlobalSettingsDto {
  copyEnabled: boolean;
  liveCopyEnabled: boolean;
  emergencyStopEnabled: boolean;
  maxDailyLossPercent: number | null;
  maxDrawdownPercent: number | null;
  maxCopiedOpenPositions: number | null;
  maxLotSize: number | null;
  maxSlippagePoints: number | null;
  pauseOnDisconnect: boolean;
  updatedAt: string;
}

export interface CopyAccountRuleDto {
  tradingAccountId: string;
  accountName: string | null;
  copyEnabled: boolean;
  maxDailyLossPercent: number | null;
  maxDrawdownPercent: number | null;
  maxCopiedLots: number | null;
  maxOpenCopiedPositions: number | null;
  stopAfterLosses: number | null;
  symbolAllowlist: string[] | null;
  symbolBlocklist: string[] | null;
  pausedAt: string | null;
  updatedAt: string;
}

export interface CopyRuleEventDto {
  id: string;
  scope: "GLOBAL" | "ACCOUNT";
  ruleCode: string;
  reason: string;
  tradingAccountId: string | null;
  strategyId: string | null;
  masterEventId: string | null;
  mode: CopyMode;
  createdAt: string;
}
