import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  WebTradeRequestError,
  newRequestId,
  nextStatePollMs,
  requestFastRefresh,
  sendWebTrade,
  warmWebTradeRoutes,
} from "@/hooks/useWebTrade";
import { REQUEST_ID_PATTERN, WEB_TRADE_BURST_MS, WEB_TRADE_BURST_POLL_MS, WEB_TRADE_POLL_MS } from "@/lib/trade/webTrade";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("how often the panel reads the account", () => {
  test("once a second normally", () => {
    // far in the future no burst can still be running
    expect(nextStatePollMs(Number.MAX_SAFE_INTEGER)).toBe(WEB_TRADE_POLL_MS);
  });

  test("every 400 ms for a few seconds after an order, then back to normal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const start = Date.now();

    requestFastRefresh();

    expect(nextStatePollMs(start)).toBe(WEB_TRADE_BURST_POLL_MS);
    expect(nextStatePollMs(start + WEB_TRADE_BURST_MS - 1)).toBe(WEB_TRADE_BURST_POLL_MS);
    expect(nextStatePollMs(start + WEB_TRADE_BURST_MS)).toBe(WEB_TRADE_POLL_MS);
    expect(WEB_TRADE_BURST_POLL_MS).toBeLessThan(WEB_TRADE_POLL_MS);
  });

  test("it reads the clock itself when it is not given one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    requestFastRefresh();
    expect(nextStatePollMs()).toBe(WEB_TRADE_BURST_POLL_MS);

    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z").getTime() + WEB_TRADE_BURST_MS + 1);
    expect(nextStatePollMs()).toBe(WEB_TRADE_POLL_MS);
  });
});

describe("sending an order", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { ok: true, ticket: "9001" } }));
    vi.stubGlobal("fetch", fetchMock);
  });

  test("it posts the order as JSON to the route of the action, with no caching", async () => {
    await sendWebTrade("open", { accountId: "a", symbol: "XAUUSD" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/terminal/trade/open");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ accountId: "a", symbol: "XAUUSD" });
  });

  test.each(["open", "modify", "close", "cancel", "close-bulk"] as const)("the %s route", async (action) => {
    await sendWebTrade(action, { accountId: "a" });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/terminal/trade/${action}`);
  });

  test("an answer without a time report comes back as it is", async () => {
    await expect(sendWebTrade("open", {})).resolves.toEqual({ ok: true, ticket: "9001" });
  });

  test("an answer with a time report gets the whole wait as the browser measured it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: { ok: true, ticket: "9001", timing: { queueMs: 120, runMs: 63, serverMs: 300, waitMs: 250 } } }),
    );

    const result = await sendWebTrade("open", {});

    expect(result.timing).toMatchObject({ queueMs: 120, runMs: 63, serverMs: 300, waitMs: 250 });
    expect(Number.isInteger(result.timing?.totalMs)).toBe(true);
    expect(result.timing?.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("partitions the browser request and names the edge and function without changing the order", async () => {
    vi.stubGlobal("window", { location: { href: "https://wsa.example/terminal" } });
    vi.stubGlobal("performance", {
      now: vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1220).mockReturnValueOnce(1250),
      getEntriesByName: vi.fn().mockReturnValue([{ startTime: 1000, requestStart: 1040, responseStart: 1220, responseEnd: 1230 }]),
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { ok: true, ticket: "9001", timing: { queueMs: 30, runMs: 80 } } }), {
        headers: { "content-type": "application/json", "x-vercel-id": "sin1::lhr1::request-id" },
      }),
    );

    const result = await sendWebTrade("open", { accountId: "a" });

    expect(result.timing).toMatchObject({
      totalMs: 250,
      browserToHeadersMs: 220,
      browserReadMs: 30,
      browserSetupMs: 40,
      browserFirstByteMs: 180,
      browserDownloadMs: 10,
      edgeRegion: "SIN1",
      functionRegion: "LHR1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a browser timing API failure cannot hide an order that the broker already answered", async () => {
    vi.stubGlobal("window", { location: { href: "https://wsa.example/terminal" } });
    vi.stubGlobal("performance", { now: () => 1000, getEntriesByName: () => { throw new Error("timing unavailable"); } });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: { ok: true, ticket: "9001", timing: { queueMs: 30, runMs: 80 } } }),
    );

    await expect(sendWebTrade("open", { accountId: "a" })).resolves.toMatchObject({ ok: true, ticket: "9001" });
  });

  test("the browser clock still reports fetch and response time when resource timing is missing", async () => {
    vi.stubGlobal("window", { location: { href: "https://wsa.example/terminal" } });
    vi.stubGlobal("performance", {
      now: vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1650).mockReturnValueOnce(1660),
      getEntriesByName: () => [],
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: { ok: true, ticket: "9001", timing: { queueMs: 30, runMs: 80 } } }),
    );

    const result = await sendWebTrade("close", { accountId: "a" });

    expect(result.timing).toMatchObject({ totalMs: 660, browserToHeadersMs: 650, browserReadMs: 10 });
  });

  test("a null time report stays null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { ok: true, ticket: "9001", timing: null } }));

    const result = await sendWebTrade("open", {});

    expect(result.timing).toBeNull();
  });

  test("a dropped connection is reported as uncertain for everything that places or closes - not for a level change", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    for (const action of ["open", "close", "cancel", "close-bulk"] as const) {
      const error = await sendWebTrade(action, {}).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(WebTradeRequestError);
      expect(error).toMatchObject({ code: "NETWORK_ERROR", uncertain: true, name: "WebTradeRequestError" });
    }
    const modify = await sendWebTrade("modify", {}).catch((reason: unknown) => reason);
    expect(modify).toMatchObject({ code: "NETWORK_ERROR", uncertain: false });
  });

  test("the server's reason is kept, and only the codes that may have reached the broker are uncertain", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: { code: "PROVIDER_ERROR", message: "Invalid stops" } }, 502));
    await expect(sendWebTrade("open", {})).rejects.toMatchObject({ message: "Invalid stops", code: "PROVIDER_ERROR", uncertain: false });

    for (const code of ["BROKER_ERROR", "BROKER_PROVIDER_TIMEOUT", "ORDER_UNCERTAIN", "WORKER_LOST", "NETWORK_ERROR"]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: { code, message: "x" } }, 504));
      await expect(sendWebTrade("open", {})).rejects.toMatchObject({ code, uncertain: true });
    }
  });

  test("an answer that is not JSON is uncertain only if the server said it was fine", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 200 }));
    await expect(sendWebTrade("open", {})).rejects.toMatchObject({ code: "BAD_RESPONSE", uncertain: true });

    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(sendWebTrade("open", {})).rejects.toMatchObject({ code: "BAD_RESPONSE", uncertain: false });
  });
});

describe("waking the order routes up", () => {
  test("a plain GET goes to each of the five routes", () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false }, 405));
    vi.stubGlobal("fetch", fetchMock);

    warmWebTradeRoutes();

    const urls = fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[0]).sort();
    expect(urls).toEqual([
      "/api/terminal/trade/cancel",
      "/api/terminal/trade/close",
      "/api/terminal/trade/close-bulk",
      "/api/terminal/trade/modify",
      "/api/terminal/trade/open",
    ]);
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.method).toBe("GET");
      expect(init.cache).toBe("no-store");
      expect(init.body).toBeUndefined();
    }
  });

  test("with an account every route also reads what an order on that account checks (the id is in the address, nothing else)", () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { warm: true } }));
    vi.stubGlobal("fetch", fetchMock);

    warmWebTradeRoutes("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");

    const calls = fetchMock.mock.calls.map((call) => call as unknown as [string, RequestInit]);
    expect(calls.map(([url]) => url).sort()).toEqual([
      "/api/terminal/trade/cancel?accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "/api/terminal/trade/close-bulk?accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "/api/terminal/trade/close?accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "/api/terminal/trade/modify?accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "/api/terminal/trade/open?accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("same-origin"); // as the signed-in person - that is what the route checks
      expect(init.body).toBeUndefined();
    }
  });

  test("only the routes asked for are woken, and the account id is encoded", () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { warm: true } }));
    vi.stubGlobal("fetch", fetchMock);

    warmWebTradeRoutes("a b&c", ["open", "close"]);

    const urls = fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[0]).sort();
    expect(urls).toEqual(["/api/terminal/trade/close?accountId=a%20b%26c", "/api/terminal/trade/open?accountId=a%20b%26c"]);
  });

  test("a failure is nobody's business: a rejected request or a fetch that throws changes nothing", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect(() => warmWebTradeRoutes()).not.toThrow();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("blocked");
      }),
    );
    expect(() => warmWebTradeRoutes()).not.toThrow();
  });

  test("without a fetch there is nothing to do", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => warmWebTradeRoutes()).not.toThrow();
  });
});

describe("the id of an order", () => {
  test("it is a valid request id and every call gives a new one", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));

    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(REQUEST_ID_PATTERN);
  });

  test("a browser without randomUUID still gets a valid, different id each time", () => {
    vi.stubGlobal("crypto", {});

    const first = newRequestId();
    const second = newRequestId();

    expect(first).toMatch(REQUEST_ID_PATTERN);
    expect(second).toMatch(REQUEST_ID_PATTERN);
    expect(first).not.toBe(second);
  });
});
