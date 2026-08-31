import { afterEach, describe, expect, it, vi } from "vitest";
import { Api2TradeClient, loadApi2TradeConfig } from "@/lib/broker/api2TradeClient";
import { api2TradeUsesApiKeyAuth, getResolvedApi2TradeBaseUrl } from "@/lib/broker/provider";

const ORIGINAL_ENV = {
  BROKER_PROVIDER: process.env.BROKER_PROVIDER,
  API2TRADE_AUTH_MODE: process.env.API2TRADE_AUTH_MODE,
  API2TRADE_BASE_URL: process.env.API2TRADE_BASE_URL,
  API2TRADE_API_KEY: process.env.API2TRADE_API_KEY,
  API2TRADE_USERNAME: process.env.API2TRADE_USERNAME,
  API2TRADE_PASSWORD: process.env.API2TRADE_PASSWORD,
};

afterEach(() => {
  process.env.BROKER_PROVIDER = ORIGINAL_ENV.BROKER_PROVIDER;
  process.env.API2TRADE_AUTH_MODE = ORIGINAL_ENV.API2TRADE_AUTH_MODE;
  process.env.API2TRADE_BASE_URL = ORIGINAL_ENV.API2TRADE_BASE_URL;
  process.env.API2TRADE_API_KEY = ORIGINAL_ENV.API2TRADE_API_KEY;
  process.env.API2TRADE_USERNAME = ORIGINAL_ENV.API2TRADE_USERNAME;
  process.env.API2TRADE_PASSWORD = ORIGINAL_ENV.API2TRADE_PASSWORD;
  vi.restoreAllMocks();
});

describe("api2trade auth mode resolution", () => {
  it("prefers direct MT5 auth for mt5.mt4api.dev even when an api key is still present", () => {
    process.env.BROKER_PROVIDER = "api2trade";
    process.env.API2TRADE_BASE_URL = "https://mt5.mt4api.dev";
    process.env.API2TRADE_API_KEY = "legacy-key";
    process.env.API2TRADE_USERNAME = "swagger-user";
    process.env.API2TRADE_PASSWORD = "swagger-pass";
    delete process.env.API2TRADE_AUTH_MODE;

    expect(api2TradeUsesApiKeyAuth()).toBe(false);
    expect(getResolvedApi2TradeBaseUrl()).toBe("https://mt5.mt4api.dev");

    const config = loadApi2TradeConfig();
    expect(config).not.toBeNull();
    expect(config?.authMode).toBe("basic");
    expect(config?.apiKey).toBeUndefined();
    expect(config?.username).toBe("swagger-user");
  });

  it("allows forcing the old api-key mode explicitly", () => {
    process.env.BROKER_PROVIDER = "api2trade";
    process.env.API2TRADE_AUTH_MODE = "apikey";
    process.env.API2TRADE_BASE_URL = "https://mt5.mt4api.dev";
    process.env.API2TRADE_API_KEY = "paid-key";
    process.env.API2TRADE_USERNAME = "swagger-user";
    process.env.API2TRADE_PASSWORD = "swagger-pass";

    expect(api2TradeUsesApiKeyAuth()).toBe(true);
    expect(getResolvedApi2TradeBaseUrl()).toBe("https://api.metatraderapi.dev");

    const config = loadApi2TradeConfig();
    expect(config?.authMode).toBe("apikey");
    expect(config?.apiKey).toBe("paid-key");
  });
});

describe("api2trade execution transport", () => {
  it("uses GET OrderSendSafe for direct MT5 auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ticket: 12345, orderId: 12345 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Api2TradeClient({
      authMode: "basic",
      baseUrl: "https://mt5.mt4api.dev",
      username: "swagger-user",
      password: "swagger-pass",
    });

    const response = await client.orderSend({
      accountId: "session-token",
      symbol: "EURUSD",
      operation: "Buy",
      volume: 0.01,
      stopLoss: 1.1,
      takeProfit: 1.2,
      comment: "test",
      slippage: 5,
    });

    expect(response.ticket).toBe(12345);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("/OrderSendSafe?");
    expect(url.toString()).toContain("id=session-token");
    expect(url.toString()).toContain("operation=0");
    expect(url.toString()).toContain("stoploss=1.1");
    expect(url.toString()).toContain("takeprofit=1.2");
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
  });
});
