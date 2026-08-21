if (typeof window !== "undefined") {
  throw new Error("[wsa] broker provider factory is server-only.");
}

import { Api2TradeBrokerAdapter } from "./Api2TradeBrokerAdapter";
import type { BrokerAdapter } from "./BrokerAdapter";
import { MetaApiBrokerAdapter } from "./MetaApiBrokerAdapter";

export type BrokerProviderId = "metaapi" | "api2trade";

export function getBrokerProviderId(): BrokerProviderId {
  return process.env.BROKER_PROVIDER?.trim().toLowerCase() === "api2trade"
    ? "api2trade"
    : "metaapi";
}

export function getBrokerProviderLabel(provider = getBrokerProviderId()): string {
  return provider === "api2trade" ? "API2Trade" : "MetaApi";
}

export function api2TradeUsesDashboardAccounts(): boolean {
  return getBrokerProviderId() === "api2trade"
    && Boolean(process.env.API2TRADE_API_KEY?.trim())
    && !(process.env.API2TRADE_USERNAME?.trim() && process.env.API2TRADE_PASSWORD?.trim());
}

export function getResolvedApi2TradeBaseUrl(): string | null {
  const configured = process.env.API2TRADE_BASE_URL?.trim();
  if (api2TradeUsesDashboardAccounts()) {
    if (!configured || /mt5\.mt4api\.dev/i.test(configured)) {
      return "https://api.api2trade.com";
    }
  }
  return configured ?? null;
}

export function getResolvedApi2TradeEventsUrl(): string | undefined {
  const configured = process.env.API2TRADE_EVENTS_URL?.trim();
  if (api2TradeUsesDashboardAccounts()) {
    if (!configured || /mt5\.mt4api\.dev/i.test(configured)) {
      return undefined;
    }
  }
  return configured || undefined;
}

export function createBrokerAdapter(): BrokerAdapter {
  return getBrokerProviderId() === "api2trade"
    ? new Api2TradeBrokerAdapter()
    : new MetaApiBrokerAdapter();
}

export function brokerProviderConfigured(): boolean {
  return getBrokerProviderId() === "api2trade"
    ? Boolean(
        getResolvedApi2TradeBaseUrl()
        && (process.env.API2TRADE_API_KEY?.trim()
          || (process.env.API2TRADE_USERNAME?.trim() && process.env.API2TRADE_PASSWORD?.trim())),
      )
    : Boolean(process.env.METAAPI_TOKEN?.trim());
}
