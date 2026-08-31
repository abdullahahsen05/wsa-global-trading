if (typeof window !== "undefined") {
  throw new Error("[wsa] broker provider factory is server-only.");
}

import { Api2TradeBrokerAdapter } from "./Api2TradeBrokerAdapter";
import type { BrokerAdapter } from "./BrokerAdapter";

export type BrokerProviderId = "metaapi" | "api2trade";

type Api2TradeAuthMode = "auto" | "basic" | "apikey";

export function getBrokerProviderId(): BrokerProviderId {
  return "api2trade";
}

export function getBrokerProviderLabel(provider = getBrokerProviderId()): string {
  return provider === "api2trade" ? "API2Trade" : "API2Trade";
}

export function api2TradeUsesDashboardAccounts(): boolean {
  return getBrokerProviderId() === "api2trade"
    && process.env.API2TRADE_CONNECTION_MODE?.trim().toLowerCase() === "dashboard-uuid";
}

function getApi2TradeAuthMode(): Api2TradeAuthMode {
  const configured = process.env.API2TRADE_AUTH_MODE?.trim().toLowerCase();
  if (configured === "basic" || configured === "apikey") return configured;
  return "auto";
}

export function api2TradeUsesApiKeyAuth(): boolean {
  if (getBrokerProviderId() !== "api2trade") return false;
  if (getApi2TradeAuthMode() === "basic") return false;
  if (getApi2TradeAuthMode() === "apikey") return Boolean(process.env.API2TRADE_API_KEY?.trim());

  const configuredBaseUrl = process.env.API2TRADE_BASE_URL?.trim().toLowerCase() ?? "";
  if (configuredBaseUrl.includes("mt5.mt4api.dev")) return false;

  return Boolean(process.env.API2TRADE_API_KEY?.trim())
    && !(
      process.env.API2TRADE_USERNAME?.trim()
      && process.env.API2TRADE_PASSWORD?.trim()
      && configuredBaseUrl.includes("mt4api.dev")
    );
}

export function getResolvedApi2TradeBaseUrl(): string | null {
  const configured = process.env.API2TRADE_BASE_URL?.trim();
  if (api2TradeUsesApiKeyAuth()) {
    if (!configured || /mt5\.mt4api\.dev|api\.api2trade\.com/i.test(configured)) {
      return "https://api.metatraderapi.dev";
    }
  } else if (!configured && process.env.API2TRADE_USERNAME?.trim() && process.env.API2TRADE_PASSWORD?.trim()) {
    return "https://mt5.mt4api.dev";
  }
  return configured ?? null;
}

export function getResolvedApi2TradeEventsUrl(): string | undefined {
  const configured = process.env.API2TRADE_EVENTS_URL?.trim();
  if (api2TradeUsesApiKeyAuth()) {
    if (!configured || /mt5\.mt4api\.dev|api\.api2trade\.com/i.test(configured)) {
      return undefined;
    }
  }
  return configured || undefined;
}

export function createBrokerAdapter(): BrokerAdapter {
  return new Api2TradeBrokerAdapter();
}

export function brokerProviderConfigured(): boolean {
  return Boolean(
    getResolvedApi2TradeBaseUrl()
    && (process.env.API2TRADE_API_KEY?.trim()
      || (process.env.API2TRADE_USERNAME?.trim() && process.env.API2TRADE_PASSWORD?.trim())),
  );
}
