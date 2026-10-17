import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brokerFetch,
  connectionPoolEnabled,
  databaseFetch,
  enableApi2TradeConnectionPool,
  resetApi2TradeConnectionPool,
  warmDatabaseConnections,
} from "@/lib/broker/api2TradeTransport";

// `undici` is replaced by a recorder: no socket is opened in this file.
const undiciMock = vi.hoisted(() => {
  const agents: Array<{ options: Record<string, unknown> }> = [];
  class Agent {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      agents.push(this);
    }
  }
  return { Agent, agents, fetch: vi.fn() };
});

vi.mock("undici", () => ({ Agent: undiciMock.Agent, fetch: undiciMock.fetch }));

const ENV_NAMES = [
  "API2TRADE_KEEPALIVE_POOL",
  "API2TRADE_KEEPALIVE_MS",
  "API2TRADE_POOL_CONNECTIONS",
  "WSA_DB_KEEPALIVE_POOL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  undiciMock.agents.length = 0;
  undiciMock.fetch.mockReset();
  undiciMock.fetch.mockResolvedValue({ ok: true, status: 200 });
  resetApi2TradeConnectionPool();
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  resetApi2TradeConnectionPool();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("brokerFetch without the pool", () => {
  it("is the platform fetch", async () => {
    const platformFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", platformFetch);
    const url = new URL("https://mt5.mt4api.dev/OpenedOrders?id=token");
    const init: RequestInit = { method: "GET", cache: "no-store" };

    await brokerFetch(url, init);

    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(platformFetch).toHaveBeenCalledWith(url, init);
    expect(connectionPoolEnabled()).toBe(false);
    expect(undiciMock.fetch).not.toHaveBeenCalled();
  });

  it("looks the platform fetch up when it is called, so a test can replace it at any time", async () => {
    const first = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const second = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    vi.stubGlobal("fetch", first);
    await brokerFetch("https://example.test/a");
    vi.stubGlobal("fetch", second);
    await brokerFetch("https://example.test/b");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("passes the failure of the platform fetch on", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(brokerFetch("https://example.test/a")).rejects.toThrow("fetch failed");
  });
});

describe("enableApi2TradeConnectionPool", () => {
  it("switches the pool on with half a minute of keep-alive and many parallel connections", async () => {
    await expect(enableApi2TradeConnectionPool()).resolves.toBe(true);

    expect(connectionPoolEnabled()).toBe(true);
    expect(undiciMock.agents).toHaveLength(1);
    expect(undiciMock.agents[0].options).toMatchObject({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 300_000,
      connections: 64,
      pipelining: 1,
      connect: { timeout: 8_000 },
    });
  });

  it("sends requests through undici with the pool as dispatcher, not through the platform fetch", async () => {
    const platformFetch = vi.fn();
    vi.stubGlobal("fetch", platformFetch);
    await enableApi2TradeConnectionPool();
    const url = new URL("https://mt5.mt4api.dev/OrderSendSafe?id=token");
    const signal = AbortSignal.timeout(20_000);

    await brokerFetch(url, { method: "GET", headers: { Accept: "application/json" }, signal });

    expect(platformFetch).not.toHaveBeenCalled();
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = undiciMock.fetch.mock.calls[0] as [URL, Record<string, unknown>];
    expect(calledUrl).toBe(url);
    expect(calledInit).toMatchObject({ method: "GET", headers: { Accept: "application/json" }, signal });
    expect(calledInit.dispatcher).toBe(undiciMock.agents[0]);
  });

  it("returns what undici answers", async () => {
    const answer = { ok: true, status: 201, marker: "from undici" };
    undiciMock.fetch.mockResolvedValue(answer);
    await enableApi2TradeConnectionPool();

    await expect(brokerFetch("https://example.test/a")).resolves.toBe(answer);
  });

  it("works without request options", async () => {
    await enableApi2TradeConnectionPool();

    await brokerFetch("https://example.test/a");

    const [, init] = undiciMock.fetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(init.dispatcher).toBe(undiciMock.agents[0]);
  });

  it("calling it twice keeps one pool", async () => {
    await expect(enableApi2TradeConnectionPool()).resolves.toBe(true);
    await expect(enableApi2TradeConnectionPool()).resolves.toBe(true);

    expect(undiciMock.agents).toHaveLength(1);
  });

  it("API2TRADE_KEEPALIVE_POOL=false keeps the platform fetch", async () => {
    process.env.API2TRADE_KEEPALIVE_POOL = "false";
    const platformFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", platformFetch);

    await expect(enableApi2TradeConnectionPool()).resolves.toBe(false);
    await brokerFetch("https://example.test/a");

    expect(connectionPoolEnabled()).toBe(false);
    expect(undiciMock.agents).toHaveLength(0);
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(undiciMock.fetch).not.toHaveBeenCalled();
  });

  it("reads the keep-alive time and the number of connections from the environment", async () => {
    process.env.API2TRADE_KEEPALIVE_MS = "60000";
    process.env.API2TRADE_POOL_CONNECTIONS = "16";

    await enableApi2TradeConnectionPool();

    expect(undiciMock.agents[0].options).toMatchObject({ keepAliveTimeout: 60_000, connections: 16 });
  });

  it("keeps both values inside the allowed range", async () => {
    process.env.API2TRADE_KEEPALIVE_MS = "100";
    process.env.API2TRADE_POOL_CONNECTIONS = "1";
    await enableApi2TradeConnectionPool();
    expect(undiciMock.agents[0].options).toMatchObject({ keepAliveTimeout: 4_000, connections: 4 });

    resetApi2TradeConnectionPool();
    process.env.API2TRADE_KEEPALIVE_MS = "999999999";
    process.env.API2TRADE_POOL_CONNECTIONS = "99999";
    await enableApi2TradeConnectionPool();
    expect(undiciMock.agents[1].options).toMatchObject({ keepAliveTimeout: 300_000, connections: 512 });
  });

  it("ignores values that are not numbers", async () => {
    process.env.API2TRADE_KEEPALIVE_MS = "long";
    process.env.API2TRADE_POOL_CONNECTIONS = "";

    await enableApi2TradeConnectionPool();

    expect(undiciMock.agents[0].options).toMatchObject({ keepAliveTimeout: 30_000, connections: 64 });
  });
});

describe("resetApi2TradeConnectionPool", () => {
  it("goes back to the platform fetch", async () => {
    const platformFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", platformFetch);
    await enableApi2TradeConnectionPool();
    expect(connectionPoolEnabled()).toBe(true);

    resetApi2TradeConnectionPool();
    await brokerFetch("https://example.test/a");

    expect(connectionPoolEnabled()).toBe(false);
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(undiciMock.fetch).not.toHaveBeenCalled();
  });
});

describe("databaseFetch (the database client's fetch)", () => {
  it("is the platform fetch while the pool is off - the web app never switches it on", async () => {
    const platformFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", platformFetch);
    const init: RequestInit = { method: "POST", body: "{}" };

    await databaseFetch("https://db.example.test/rest/v1/trades", init);

    expect(platformFetch).toHaveBeenCalledWith("https://db.example.test/rest/v1/trades", init);
    expect(undiciMock.fetch).not.toHaveBeenCalled();
  });

  it("uses the keep-alive pool once a worker has switched it on", async () => {
    const platformFetch = vi.fn();
    vi.stubGlobal("fetch", platformFetch);
    await enableApi2TradeConnectionPool();
    const init: RequestInit = { method: "POST", headers: { Prefer: "return=representation" }, body: "{}" };

    await databaseFetch("https://db.example.test/rest/v1/copy_trade_links", init);
    await databaseFetch(new URL("https://db.example.test/rest/v1/copy_master_events"));

    expect(platformFetch).not.toHaveBeenCalled();
    expect(undiciMock.fetch).toHaveBeenCalledTimes(2);
    const [, firstInit] = undiciMock.fetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(firstInit).toMatchObject({ method: "POST", body: "{}" });
    expect(firstInit.dispatcher).toBe(undiciMock.agents[0]);
  });

  it("WSA_DB_KEEPALIVE_POOL=false keeps the database on the platform fetch while orders stay pooled", async () => {
    process.env.WSA_DB_KEEPALIVE_POOL = "false";
    const platformFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", platformFetch);
    await enableApi2TradeConnectionPool();

    await databaseFetch("https://db.example.test/rest/v1/a");
    await brokerFetch("https://mt5.mt4api.dev/OrderSend");

    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1);
  });

  it("hands a ready-made Request to the platform fetch (the pool only takes an address and options)", async () => {
    const platformFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", platformFetch);
    await enableApi2TradeConnectionPool();
    const request = new Request("https://db.example.test/rest/v1/a", { method: "GET" });

    await databaseFetch(request);

    expect(platformFetch).toHaveBeenCalledWith(request, undefined);
    expect(undiciMock.fetch).not.toHaveBeenCalled();
  });
});

describe("warmDatabaseConnections", () => {
  it("does nothing while the pool is off", () => {
    const read = vi.fn().mockResolvedValue(undefined);

    warmDatabaseConnections(read, 5);

    expect(read).not.toHaveBeenCalled();
  });

  it("opens that many connections at once, once the pool is on", async () => {
    await enableApi2TradeConnectionPool();
    const read = vi.fn().mockResolvedValue(undefined);

    warmDatabaseConnections(read, 5);

    expect(read).toHaveBeenCalledTimes(5);
  });

  it("keeps the number between one and thirty-two", async () => {
    await enableApi2TradeConnectionPool();
    const read = vi.fn().mockResolvedValue(undefined);

    warmDatabaseConnections(read, 0);
    expect(read).toHaveBeenCalledTimes(1);

    resetApi2TradeConnectionPool();
    await enableApi2TradeConnectionPool();
    read.mockClear();
    warmDatabaseConnections(read, 500);
    expect(read).toHaveBeenCalledTimes(32);
  });

  it("is asked again at most every eight seconds", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-12T20:00:00Z"));
      await enableApi2TradeConnectionPool();
      const read = vi.fn().mockResolvedValue(undefined);

      warmDatabaseConnections(read, 3);
      vi.advanceTimersByTime(7_000);
      warmDatabaseConnections(read, 3);
      expect(read).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(1_500);
      warmDatabaseConnections(read, 3);
      expect(read).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WSA_DB_KEEPALIVE_POOL=false switches it off", async () => {
    process.env.WSA_DB_KEEPALIVE_POOL = "false";
    await enableApi2TradeConnectionPool();
    const read = vi.fn().mockResolvedValue(undefined);

    warmDatabaseConnections(read, 4);

    expect(read).not.toHaveBeenCalled();
  });

  it("never fails because a warming read failed - neither a rejection nor a throw", async () => {
    await enableApi2TradeConnectionPool();
    const rejecting = vi.fn().mockRejectedValue(new Error("database down"));

    expect(() => warmDatabaseConnections(rejecting, 2)).not.toThrow();
    await Promise.resolve();

    resetApi2TradeConnectionPool();
    await enableApi2TradeConnectionPool();
    const throwing = vi.fn(() => {
      throw new Error("client not ready");
    });
    expect(() => warmDatabaseConnections(throwing, 2)).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(2);
  });
});

describe("when undici cannot be used", () => {
  afterEach(() => {
    vi.doMock("undici", () => ({ Agent: undiciMock.Agent, fetch: undiciMock.fetch }));
  });

  it("falls back to the platform fetch with a warning, never an error", async () => {
    vi.resetModules();
    vi.doMock("undici", () => ({}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const platformFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", platformFetch);
    const fresh = await import("@/lib/broker/api2TradeTransport");

    await expect(fresh.enableApi2TradeConnectionPool()).resolves.toBe(false);
    await fresh.brokerFetch("https://example.test/a");

    expect(fresh.connectionPoolEnabled()).toBe(false);
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("keep-alive connection pool unavailable");
  });

  it("a module that fails to load is handled the same way", async () => {
    vi.resetModules();
    vi.doMock("undici", () => {
      throw new Error("Cannot find package 'undici'");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = await import("@/lib/broker/api2TradeTransport");

    await expect(fresh.enableApi2TradeConnectionPool()).resolves.toBe(false);

    expect(fresh.connectionPoolEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
