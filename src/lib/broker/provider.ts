if (typeof window !== "undefined") {
  throw new Error("[wsa] broker provider factory is server-only.");
}

import { Api2TradeBrokerAdapter } from "./Api2TradeBrokerAdapter";
import type { BrokerAdapter } from "./BrokerAdapter";

export type BrokerProviderId = "metaapi" | "api2trade";

export function getBrokerProviderId(): BrokerProviderId {
  return "api2trade";
}

export function getBrokerProviderLabel(): string {
  return "API2Trade";
}

export function api2TradeUsesDashboardAccounts(): boolean {
  return false;
}

export function api2TradeUsesApiKeyAuth(): boolean {
  return false;
}

export function getResolvedApi2TradeBaseUrl(): string | null {
  const configured = process.env.API2TRADE_BASE_URL?.trim();
  if (!configured && process.env.API2TRADE_USERNAME?.trim() && process.env.API2TRADE_PASSWORD?.trim()) {
    return "https://mt5.mt4api.dev";
  }
  return configured ?? null;
}

export function getResolvedApi2TradeEventsUrl(): string | undefined {
  const configured = process.env.API2TRADE_EVENTS_URL?.trim();
  return configured || undefined;
}

export function createBrokerAdapter(): BrokerAdapter {
  return new Api2TradeBrokerAdapter();
}

export function brokerProviderConfigured(): boolean {
  return Boolean(
    getResolvedApi2TradeBaseUrl()
    && process.env.API2TRADE_USERNAME?.trim()
    && process.env.API2TRADE_PASSWORD?.trim(),
  );
}
