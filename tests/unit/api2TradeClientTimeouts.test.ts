import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api2TradeClient, requestTimeoutMs, resetSymbolEndpointMemory } from "@/lib/broker/api2TradeClient";

const TIMEOUT_ENV = [
  "API2TRADE_REQUEST_TIMEOUT_MS",
  "API2TRADE_POLL_TIMEOUT_MS",
  "API2TRADE_ORDER_TIMEOUT_MS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of TIMEOUT_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  resetSymbolEndpointMemory();
});

afterEach(() => {
  for (const name of TIMEOUT_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  resetSymbolEndpointMemory();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface FakeAnswer {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function answer(body: string, status = 200): FakeAnswer {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function basicClient(): Api2TradeClient {
  return new Api2TradeClient({
    authMode: "basic",
    baseUrl: "https://mt5.mt4api.dev",
    username: "user",
    password: "pass",
  });
}

function apiKeyClient(): Api2TradeClient {
  return new Api2TradeClient({ authMode: "apikey", baseUrl: "https://mt5.mt4api.dev", apiKey: "key" });
}

/** The path of a fetch call, without the host and the query string. */
function endpointOfCall(call: unknown[]): string {
  return new URL(String(call[0])).pathname.replace(/^\/+/, "");
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

describe("requestTimeoutMs", () => {
  it("gives every kind of call its own default limit", () => {
    expect(requestTimeoutMs("OrderSendSafe")).toBe(20_000);
    expect(requestTimeoutMs("OrderSend")).toBe(20_000);
    expect(requestTimeoutMs("OrderCloseSafe")).toBe(20_000);
    expect(requestTimeoutMs("OrderModifySafe")).toBe(20_000);
    expect(requestTimeoutMs("OrderDelete")).toBe(20_000);
    expect(requestTimeoutMs("OrderDeleteSafe")).toBe(20_000);
    expect(requestTimeoutMs("OpenedOrders")).toBe(5_000);
    expect(requestTimeoutMs("AccountSummary")).toBe(12_000);
    expect(requestTimeoutMs("ClosedOrders")).toBe(12_000);
    expect(requestTimeoutMs("OrderHistory")).toBe(12_000);
    expect(requestTimeoutMs("ConnectEx")).toBe(12_000);
  });

  it("only the exact poll endpoint gets the short poll limit", () => {
    expect(requestTimeoutMs("OpenedOrders")).toBe(5_000);
    expect(requestTimeoutMs("OpenedOrdersHistory")).toBe(12_000);
  });

  it("reads the limits from the environment", () => {
    process.env.API2TRADE_ORDER_TIMEOUT_MS = "30000";
    process.env.API2TRADE_POLL_TIMEOUT_MS = "2000";
    process.env.API2TRADE_REQUEST_TIMEOUT_MS = "8000";

    expect(requestTimeoutMs("OrderSendSafe")).toBe(30_000);
    expect(requestTimeoutMs("OpenedOrders")).toBe(2_000);
    expect(requestTimeoutMs("AccountSummary")).toBe(8_000);
  });

  it("keeps a value that is too small or too large inside the allowed range", () => {
    process.env.API2TRADE_ORDER_TIMEOUT_MS = "100";
    process.env.API2TRADE_POLL_TIMEOUT_MS = "1";
    process.env.API2TRADE_REQUEST_TIMEOUT_MS = "5";
    expect(requestTimeoutMs("OrderSendSafe")).toBe(3_000);
    expect(requestTimeoutMs("OpenedOrders")).toBe(500);
    expect(requestTimeoutMs("AccountSummary")).toBe(1_000);

    process.env.API2TRADE_ORDER_TIMEOUT_MS = "999999999";
    process.env.API2TRADE_POLL_TIMEOUT_MS = "999999999";
    process.env.API2TRADE_REQUEST_TIMEOUT_MS = "999999999";
    expect(requestTimeoutMs("OrderSendSafe")).toBe(120_000);
    expect(requestTimeoutMs("OpenedOrders")).toBe(60_000);
    expect(requestTimeoutMs("AccountSummary")).toBe(120_000);
  });

  it("falls back to the default when the value is not a number", () => {
    process.env.API2TRADE_ORDER_TIMEOUT_MS = "soon";
    process.env.API2TRADE_POLL_TIMEOUT_MS = "";
    process.env.API2TRADE_REQUEST_TIMEOUT_MS = "  ";
    expect(requestTimeoutMs("OrderSendSafe")).toBe(20_000);
    expect(requestTimeoutMs("OpenedOrders")).toBe(5_000);
    expect(requestTimeoutMs("AccountSummary")).toBe(12_000);
  });
});

describe("a request to the broker service has a time limit", () => {
  it("hands an abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer("[]"));
    vi.stubGlobal("fetch", fetchMock);

    await basicClient().openedOrders("token");

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it.each([
    ["TimeoutError", "The operation was aborted due to timeout"],
    ["AbortError", "This operation was aborted"],
  ])("turns a %s into a short, readable message", async (name, text) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException(text, name)));

    await expect(basicClient().accountSummary("token")).rejects.toThrow(
      "Broker service did not answer AccountSummary within 12s.",
    );
  });

  it("a body that never arrives counts as a timeout too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => {
          throw timeoutError();
        },
      }),
    );

    await expect(basicClient().accountSummary("token")).rejects.toThrow("did not answer AccountSummary");
  });

  it("names the limit that applies to the call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError()));
    await expect(basicClient().openedOrders("token")).rejects.toThrow("OpenedOrders within 5s.");

    process.env.API2TRADE_POLL_TIMEOUT_MS = "9000";
    await expect(basicClient().openedOrders("token")).rejects.toThrow("OpenedOrders within 9s.");
  });

  it("other network errors are passed on unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(basicClient().accountSummary("token")).rejects.toThrow("fetch failed");
  });

  it("gives up for real when the broker service stays silent", async () => {
    process.env.API2TRADE_POLL_TIMEOUT_MS = "500";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const started = Date.now();
    await expect(basicClient().openedOrders("token")).rejects.toThrow("Broker service did not answer OpenedOrders");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each([
    {
      name: "orderSend",
      call: (client: Api2TradeClient) =>
        client.orderSend({ accountId: "t", symbol: "EURUSD", operation: "Buy", volume: 0.01 }),
    },
    { name: "orderClose", call: (client: Api2TradeClient) => client.orderClose({ accountId: "t", ticket: "42" }) },
    {
      name: "orderModify",
      call: (client: Api2TradeClient) => client.orderModify({ accountId: "t", ticket: "42", stopLoss: 1.1 }),
    },
  ])("$name gets the longer order limit and is sent only once when it times out", async ({ call }) => {
    const fetchMock = vi.fn().mockRejectedValue(timeoutError());
    vi.stubGlobal("fetch", fetchMock);

    await expect(call(basicClient())).rejects.toThrow("within 20s.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an order that timed out is not repeated on the fallback endpoint (API-key mode)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(timeoutError());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiKeyClient().orderSend({ accountId: "t", symbol: "EURUSD", operation: "Sell", volume: 0.01 }),
    ).rejects.toThrow("did not answer OrderSend within 20s.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("openedOrdersChecked", () => {
  it("returns the list of open orders", async () => {
    const orders = [{ ticket: 1, symbol: "EURUSD" }, { ticket: 2, symbol: "XAUUSD" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(JSON.stringify(orders))));

    await expect(basicClient().openedOrdersChecked("token")).resolves.toEqual(orders);
  });

  it("an empty list is an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer("[]")));

    await expect(basicClient().openedOrdersChecked("token")).resolves.toEqual([]);
  });

  it.each([
    ["an empty body", ""],
    ["a body of blanks", "   \n"],
    ["a null", "null"],
  ])("%s means nothing is open", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(body)));

    await expect(basicClient().openedOrdersChecked("token")).resolves.toEqual([]);
  });

  it.each([
    ["a text", "not connected"],
    ["an object", JSON.stringify({ balance: 1000 })],
    ["a number", "42"],
  ])("%s is an error, never an empty list", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(body)));

    await expect(basicClient().openedOrdersChecked("token")).rejects.toThrow(
      "Broker service returned an unexpected answer for the open positions.",
    );
  });

  it("an error answer of the broker service is still an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer("Service unavailable", 503)));

    await expect(basicClient().openedOrdersChecked("token")).rejects.toThrow("request failed (503)");
  });

  it("the plain openedOrders stays tolerant (other callers rely on it)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer("not connected")));

    await expect(basicClient().openedOrders("token")).resolves.toEqual([]);
  });
});

describe("symbolSpecifications", () => {
  const EURUSD = { symbol: "EURUSD", contractSize: 100_000, digits: 5 };

  /** A fake bridge: the endpoints in `handlers` answer, every other path says 404. */
  function bridge(handlers: Record<string, () => FakeAnswer>) {
    const fetchMock = vi.fn(async (url: URL) => {
      const handler = handlers[endpointOfCall([url])];
      return handler ? handler() : answer("Not Found", 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const calledEndpoints = (fetchMock: { mock: { calls: unknown[][] } }) => fetchMock.mock.calls.map(endpointOfCall);

  it("tries the endpoints in turn until one answers", async () => {
    const fetchMock = bridge({ SymbolSpecification: () => answer(JSON.stringify(EURUSD)) });

    await expect(basicClient().symbolSpecifications("token", "EURUSD")).resolves.toEqual(EURUSD);
    expect(calledEndpoints(fetchMock)).toEqual(["SymbolInfo", "SymbolParams", "SymbolSpecification"]);
  });

  it("goes straight to the endpoint that answered last time", async () => {
    const fetchMock = bridge({ SymbolSpecification: () => answer(JSON.stringify(EURUSD)) });
    const client = basicClient();

    await client.symbolSpecifications("token", "EURUSD");
    fetchMock.mockClear();
    await client.symbolSpecifications("token", "EURUSD");

    expect(calledEndpoints(fetchMock)).toEqual(["SymbolSpecification"]);
  });

  it("skips the endpoints that said there is no such path for ten minutes, then tries them again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    const fetchMock = bridge({ SymbolSpecification: () => answer(JSON.stringify(EURUSD)) });
    const client = basicClient();

    await client.symbolSpecifications("token", "EURUSD");
    expect(calledEndpoints(fetchMock)).toEqual(["SymbolInfo", "SymbolParams", "SymbolSpecification"]);

    // from now on only SymbolParams answers - but it was reported as missing a moment ago
    fetchMock.mockImplementation(async (url: URL) =>
      endpointOfCall([url]) === "SymbolParams" ? answer(JSON.stringify(EURUSD)) : answer("Internal error", 500),
    );

    vi.setSystemTime(new Date("2026-10-12T12:05:00Z"));
    fetchMock.mockClear();
    await expect(client.symbolSpecifications("token", "EURUSD")).resolves.toBeNull();
    expect(calledEndpoints(fetchMock)).toEqual(["SymbolSpecification", "GetSymbolInfo", "MarketInfo"]);

    vi.setSystemTime(new Date("2026-10-12T12:10:01Z"));
    fetchMock.mockClear();
    await expect(client.symbolSpecifications("token", "EURUSD")).resolves.toEqual(EURUSD);
    expect(calledEndpoints(fetchMock)).toEqual(["SymbolSpecification", "SymbolInfo", "SymbolParams"]);
  });

  it("an endpoint is only demoted for 404 / 405 / 501, not for another kind of failure", async () => {
    let paramsWorks = true;
    const fetchMock = bridge({
      SymbolInfo: () => answer("Internal error", 500),
      SymbolParams: () => (paramsWorks ? answer(JSON.stringify(EURUSD)) : answer("Internal error", 500)),
    });
    const client = basicClient();

    await client.symbolSpecifications("token", "EURUSD");
    expect(calledEndpoints(fetchMock)).toEqual(["SymbolInfo", "SymbolParams"]);

    paramsWorks = false;
    fetchMock.mockClear();
    await client.symbolSpecifications("token", "EURUSD");
    // SymbolInfo answered 500 once - that is no proof it does not exist, so it is next in line
    expect(calledEndpoints(fetchMock)).toEqual([
      "SymbolParams",
      "SymbolInfo",
      "SymbolSpecification",
      "GetSymbolInfo",
      "MarketInfo",
    ]);
  });

  it.each([404, 405, 501])("HTTP %i counts as 'no such endpoint'", async (status) => {
    let knownWorks = true;
    const fetchMock = vi.fn(async (url: URL) => {
      const endpoint = endpointOfCall([url]);
      if (endpoint === "SymbolInfo") return answer("nope", status);
      if (endpoint === "SymbolParams") return knownWorks ? answer(JSON.stringify(EURUSD)) : answer("Internal error", 500);
      return answer("Internal error", 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = basicClient();

    await client.symbolSpecifications("token", "EURUSD");
    knownWorks = false;
    fetchMock.mockClear();
    await client.symbolSpecifications("token", "EURUSD");

    expect(calledEndpoints(fetchMock)).toEqual(["SymbolParams", "SymbolSpecification", "GetSymbolInfo", "MarketInfo"]);
  });

  it("returns null when no endpoint exists", async () => {
    const fetchMock = bridge({});

    await expect(basicClient().symbolSpecifications("token", "EURUSD")).resolves.toBeNull();
    expect(calledEndpoints(fetchMock)).toEqual([
      "SymbolInfo",
      "SymbolParams",
      "SymbolSpecification",
      "GetSymbolInfo",
      "MarketInfo",
    ]);
  });

  it("picks the right symbol out of a list, whatever the case", async () => {
    const list = [{ symbol: "GBPUSD", digits: 5 }, { name: "eurusd", digits: 5, contractSize: 100_000 }];
    bridge({ SymbolInfo: () => answer(JSON.stringify(list)) });

    await expect(basicClient().symbolSpecifications("token", "EURUSD")).resolves.toEqual(list[1]);
  });

  it("a list without the symbol is null, and the endpoint is still remembered", async () => {
    const fetchMock = bridge({ SymbolInfo: () => answer(JSON.stringify([{ symbol: "GBPUSD" }])) });
    const client = basicClient();

    await expect(client.symbolSpecifications("token", "EURUSD")).resolves.toBeNull();
    fetchMock.mockClear();
    await expect(client.symbolSpecifications("token", "EURUSD")).resolves.toBeNull();
    expect(calledEndpoints(fetchMock)).toEqual(["SymbolInfo"]);
  });

  it("resetSymbolEndpointMemory starts the walk from the top again", async () => {
    const fetchMock = bridge({ SymbolSpecification: () => answer(JSON.stringify(EURUSD)) });
    const client = basicClient();
    await client.symbolSpecifications("token", "EURUSD");

    resetSymbolEndpointMemory();
    fetchMock.mockClear();
    await client.symbolSpecifications("token", "EURUSD");

    expect(calledEndpoints(fetchMock)).toEqual(["SymbolInfo", "SymbolParams", "SymbolSpecification"]);
  });
});

describe("pending orders, cancelling them and the symbol list", () => {
  /** A fake bridge: the endpoints in `handlers` answer, every other path says 404. */
  function bridge(handlers: Record<string, (url: URL) => FakeAnswer>) {
    const fetchMock = vi.fn(async (url: URL) => {
      const handler = handlers[endpointOfCall([url])];
      return handler ? handler(url) : answer("Not Found", 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const calledEndpoints = (fetchMock: { mock: { calls: unknown[][] } }) => fetchMock.mock.calls.map(endpointOfCall);
  const queryOf = (fetchMock: { mock: { calls: unknown[][] } }, index = 0) => new URL(String(fetchMock.mock.calls[index][0])).searchParams;

  it("sends a pending order with MetaTrader's operation code and the price it waits for", async () => {
    const fetchMock = bridge({ OrderSendSafe: () => answer(JSON.stringify({ ticket: 77 })) });
    const client = basicClient();

    await client.orderSend({ accountId: "t", symbol: "EURUSD.r", operation: "BuyLimit", volume: 0.1, price: 1.08, stopLoss: 1.07, takeProfit: 1.1 });
    await client.orderSend({ accountId: "t", symbol: "EURUSD.r", operation: "SellLimit", volume: 0.1, price: 1.12 });
    await client.orderSend({ accountId: "t", symbol: "EURUSD.r", operation: "BuyStop", volume: 0.1, price: 1.13 });
    await client.orderSend({ accountId: "t", symbol: "EURUSD.r", operation: "SellStop", volume: 0.1, price: 1.07 });

    expect([0, 1, 2, 3].map((index) => queryOf(fetchMock, index).get("operation"))).toEqual(["2", "3", "4", "5"]);
    expect(queryOf(fetchMock, 0).get("price")).toBe("1.08");
    expect(queryOf(fetchMock, 0).get("symbol")).toBe("EURUSD.r");
    expect(queryOf(fetchMock, 0).get("stoploss")).toBe("1.07");
  });

  it("a market order carries no price", async () => {
    const fetchMock = bridge({ OrderSendSafe: () => answer(JSON.stringify({ ticket: 1 })) });

    await basicClient().orderSend({ accountId: "t", symbol: "EURUSD", operation: "Sell", volume: 0.1 });

    expect(queryOf(fetchMock).get("operation")).toBe("1");
    expect(queryOf(fetchMock).has("price")).toBe(false);
  });

  it("modifying a pending order can move its price", async () => {
    const fetchMock = bridge({ OrderModifySafe: () => answer(JSON.stringify({ ticket: 5 })) });

    await basicClient().orderModify({ accountId: "t", ticket: "5", price: 1.085, stopLoss: 1.07, takeProfit: 0 });

    const query = queryOf(fetchMock);
    expect(query.get("price")).toBe("1.085");
    expect(query.get("stoploss")).toBe("1.07");
    // 0 removes a level - it must reach the bridge
    expect(query.get("takeprofit")).toBe("0");
  });

  it("deletes a pending order with the first delete call the bridge has, and remembers it", async () => {
    const fetchMock = bridge({ OrderDeleteSafe: () => answer(JSON.stringify({ ticket: 9 })) });
    const client = basicClient();

    await expect(client.orderCancel({ accountId: "t", ticket: "9" })).resolves.toMatchObject({ ticket: 9 });
    expect(calledEndpoints(fetchMock)).toEqual(["OrderDelete", "OrderDeleteSafe"]);
    expect(queryOf(fetchMock, 1).get("ticket")).toBe("9");

    fetchMock.mockClear();
    await client.orderCancel({ accountId: "t", ticket: "10" });
    expect(calledEndpoints(fetchMock)).toEqual(["OrderDeleteSafe"]);
  });

  it("falls back to closing the order when the bridge has no delete call at all", async () => {
    const fetchMock = bridge({ OrderCloseSafe: () => answer(JSON.stringify({ ticket: 9 })) });

    await basicClient().orderCancel({ accountId: "t", ticket: "9" });

    expect(calledEndpoints(fetchMock)).toEqual(["OrderDelete", "OrderDeleteSafe", "OrderCloseSafe"]);
  });

  it("a refusal from the broker is the answer - the next endpoint is not tried", async () => {
    const fetchMock = bridge({
      OrderDelete: () => answer("ERR_INVALID_TICKET", 400),
      OrderDeleteSafe: () => answer(JSON.stringify({ ticket: 9 })),
    });

    await expect(basicClient().orderCancel({ accountId: "t", ticket: "9" })).rejects.toThrow("400");
    expect(calledEndpoints(fetchMock)).toEqual(["OrderDelete"]);
  });

  it("reads the symbol list, whatever shape it comes in", async () => {
    bridge({ SymbolList: () => answer(JSON.stringify(["EURUSD.r", "XAUUSDm", "GOLD"])) });
    await expect(basicClient().symbolList("t")).resolves.toEqual([
      { name: "EURUSD.r", description: null, path: null, digits: null },
      { name: "XAUUSDm", description: null, path: null, digits: null },
      { name: "GOLD", description: null, path: null, digits: null },
    ]);
  });

  it("walks the symbol list endpoints, remembers the one that answered, and throws when none does", async () => {
    const fetchMock = bridge({ Symbols: () => answer(JSON.stringify([{ symbol: "US30.cash", description: "Dow Jones", digits: 1 }])) });
    const client = basicClient();

    await expect(client.symbolList("t")).resolves.toEqual([
      { name: "US30.cash", description: "Dow Jones", path: null, digits: 1 },
    ]);
    expect(calledEndpoints(fetchMock)).toEqual(["SymbolList", "Symbols"]);

    fetchMock.mockClear();
    await client.symbolList("t");
    expect(calledEndpoints(fetchMock)).toEqual(["Symbols"]);

    resetSymbolEndpointMemory();
    bridge({});
    await expect(client.symbolList("t")).rejects.toThrow("404");
  });

  it("an answer without any symbol is an empty list, not an error", async () => {
    bridge({ SymbolList: () => answer("[]") });
    await expect(basicClient().symbolList("t")).resolves.toEqual([]);
  });
});
