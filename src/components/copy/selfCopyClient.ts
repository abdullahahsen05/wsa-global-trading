/**
 * What the self-copy screen receives from `/api/copy-trading/self-copy*` (the DTOs of
 * `lib/services/selfCopyService.ts`, written out here so the browser bundle never imports a server module).
 */

import type { CalibrationValues, EngineView, PlatformFactsView } from "@/lib/copy/selfCopyView";

export type SelfCopyMode = "BALANCE_RATIO" | "LOT_MULTIPLIER" | "FIXED_LOT" | "RISK_PERCENT";

export interface SelfCopySettings {
  copyEnabled: boolean;
  copyMode: SelfCopyMode;
  fixedLot: number | null;
  lotMultiplier: number | null;
  riskPercent: number | null;
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
  /** how a copied trade is shaped; absent in a payload for an older server */
  calibration?: CalibrationValues;
}

export interface SelfCopyEngine extends EngineView {
  listening: boolean;
  heartbeatAt: string | null;
}

export interface SelfCopyLastActivity {
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  outcome: "COPIED" | "SKIPPED" | "FAILED";
  code: string;
  message: string;
  symbol: string | null;
  createdAt: string;
}

export interface SelfCopyRelationship {
  id: string;
  sourceAccountId: string;
  sourceAccountName: string;
  sourceStatus: string;
  followerAccountId: string;
  followerAccountName: string;
  followerStatus: string;
  status: "LIVE" | "PAUSED";
  copySettings: SelfCopySettings;
  /** null = the worker's report columns (migration 061) are not in the database */
  engine?: SelfCopyEngine | null;
  /** null = nothing recorded yet */
  lastActivity?: SelfCopyLastActivity | null;
  createdAt: string;
  updatedAt: string;
}

export type SelfCopyPlatform = PlatformFactsView;

export interface SelfCopyResponse {
  relationships: SelfCopyRelationship[];
  /** the copy system as a whole; absent or null when it could not be worked out */
  platform?: SelfCopyPlatform | null;
}

export interface SelfCopyCheckItem {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info";
  detail: string;
}

export interface SelfCopyCheckResult {
  wouldCopy: boolean;
  code: string;
  message: string;
  checks: SelfCopyCheckItem[];
  sample: {
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
    entryPrice: number | null;
    origin: "open-position" | "last-trade" | "example";
  };
  plan: {
    followerSymbol: string;
    followerSide: "BUY" | "SELL";
    lot: number;
    stopLoss: number | null;
    takeProfit: number | null;
    symbolMatchedBy: "mapping" | "same-name" | "auto" | "as-is";
    notes: string[];
  } | null;
  checkedAt: string;
}

export interface SelfCopyActivityItem {
  id: string;
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  outcome: "COPIED" | "SKIPPED" | "FAILED";
  code: string;
  message: string;
  symbol: string | null;
  followerSymbol: string | null;
  side: string | null;
  sourceVolume: number | null;
  copiedVolume: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface SelfCopyActivityResponse {
  /** `links` = the activity table (migration 061) is missing, the lines come from the copy links */
  source: "events" | "links";
  items: SelfCopyActivityItem[];
}

export async function selfCopyApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!payload?.ok) throw new Error(payload?.error?.message ?? "Request failed.");
  return payload.data as T;
}
