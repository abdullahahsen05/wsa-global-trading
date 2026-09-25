/**
 * Market Data Service — provider selection layer
 *
 * Reads MARKET_DATA_PROVIDER env var at runtime.
 * Production never falls back to generated market data. To use the legacy
 * terminal API, configure a real provider explicitly. Mock data is available
 * only for local development when ALLOW_MOCK_MARKET_DATA=true.
 *
 * The dxFeed provider gracefully falls back to an error response when
 * credentials are missing — the API routes catch that and surface a clear label.
 */

import { MockMarketDataProvider } from "./providers/mockMarketDataProvider";
import { DxfeedMarketDataProvider } from "./providers/dxfeedMarketDataProvider";
import type { BaseMarketDataProvider } from "./providers/baseMarketDataProvider";

let _instance: BaseMarketDataProvider | null = null;

export function getMarketDataProvider(): BaseMarketDataProvider {
  if (_instance) return _instance;

  const providerEnv = process.env.MARKET_DATA_PROVIDER?.trim().toLowerCase() ?? "";
  const allowMock = process.env.NODE_ENV !== "production"
    && process.env.ALLOW_MOCK_MARKET_DATA === "true";

  if (providerEnv === "mock" && allowMock) {
    _instance = new MockMarketDataProvider();
  } else {
    _instance = new DxfeedMarketDataProvider();
  }

  return _instance;
}

/** For testing — reset singleton so a different provider can be injected */
export function resetMarketDataProvider(): void {
  _instance = null;
}
