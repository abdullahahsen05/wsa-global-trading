import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import {
  DIRECT_CLOCK_SKEW_MS,
  DIRECT_LANE_VERSION,
  DIRECT_SIGNATURE_HEADER,
  DIRECT_TIMESTAMP_HEADER,
  checkDirectAuth,
  parseDirectReply,
  parseDirectRequest,
  signDirect,
  validDirectSecret,
  type DirectReply,
  type DirectRequest,
} from "@/lib/gateway/directLane";
import {
  DIRECT_DOWN_MS,
  directLaneConfig,
  directLaneDown,
  resetDirectLane,
  sendDirect,
  type DirectLaneConfig,
  type DirectTransport,
} from "@/lib/gateway/directLaneClient";
import { createSupabaseGatewayStore, type GatewayStore } from "@/lib/gateway/gatewayStore";
import { GatewayWorker } from "@/lib/gateway/gatewayWorker";
import { MemoryDb, memoryClient } from "./helpers/memoryDb";

// The direct lane: the web server hands an order to the AWS worker over one signed HTTP request. What must hold:
// only the right sender is believed, an order is placed ONCE however often the request is repeated, and the web side
// never mistakes "maybe it went through" for "it did not" (that would place a second order).

const SECRET = "direct-lane-secret-0123456789-abcdef";
const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

function request(overrides: Partial<DirectRequest> = {}): DirectRequest {
  return {
    v: DIRECT_LANE_VERSION,
    userId: USER,
    accountId: ACCOUNT,
    kind: "OPEN",
    payload: { symbol: "EURUSD.r", side: "BUY", volume: 0.1 },
    clientRequestId: "request-direct-1",
    ttlMs: 12_000,
    attempt: 1,
    ...overrides,
  };
}

describe("the protocol", () => {
  test("a request is believed only when it is signed with the secret, unaltered and fresh", () => {
    const body = JSON.stringify(request());
    const timestamp = "1000000";
    const signature = signDirect(SECRET, timestamp, body);
    const check = (over: { timestamp?: string | null; signature?: string | null; body?: string; secret?: string; now?: number } = {}) =>
      checkDirectAuth(
        over.secret ?? SECRET,
        { timestamp: over.timestamp === undefined ? timestamp : over.timestamp, signature: over.signature === undefined ? signature : over.signature },
        over.body ?? body,
        over.now ?? 1_000_000,
      );

    expect(check()).toBe("ok");
    expect(check({ body: `${body} ` })).toBe("bad_signature");
    expect(check({ secret: "another-secret-another-secret-123456" })).toBe("bad_signature");
    expect(check({ signature: "not-hex" })).toBe("bad_signature");
    expect(check({ timestamp: null })).toBe("missing");
    expect(check({ signature: null })).toBe("missing");
    expect(check({ now: 1_000_000 + DIRECT_CLOCK_SKEW_MS + 1 })).toBe("stale");
    expect(check({ now: 1_000_000 - DIRECT_CLOCK_SKEW_MS - 1 })).toBe("stale");
  });

  test("a secret shorter than 32 characters is not usable", () => {
    expect(validDirectSecret(SECRET)).toBe(true);
    expect(validDirectSecret("short")).toBe(false);
    expect(validDirectSecret(undefined)).toBe(false);
  });

  test("only orders may use the lane, every id is checked and the wait is bounded", () => {
    expect(parseDirectRequest(request())).toMatchObject({ ok: true, request: { kind: "OPEN", attempt: 1, ttlMs: 12_000 } });
    expect(parseDirectRequest(request({ kind: "STATE" }))).toMatchObject({ ok: false });
    expect(parseDirectRequest(request({ kind: "SYMBOLS" }))).toMatchObject({ ok: false });
    expect(parseDirectRequest({ ...request(), userId: "not-a-uuid" })).toMatchObject({ ok: false });
    expect(parseDirectRequest({ ...request(), clientRequestId: "x" })).toMatchObject({ ok: false });
    expect(parseDirectRequest({ ...request(), v: 99 })).toMatchObject({ ok: false });
    expect(parseDirectRequest(null)).toMatchObject({ ok: false });
    expect(parseDirectRequest({ ...request(), ttlMs: 10_000_000 })).toMatchObject({ ok: true, request: { ttlMs: 60_000 } });
    expect(parseDirectRequest({ ...request(), ttlMs: 1 })).toMatchObject({ ok: true, request: { ttlMs: 1_000 } });
  });

  test("an answer is accepted only for the request it names", () => {
    const wire = { v: DIRECT_LANE_VERSION, clientRequestId: "request-direct-1", reply: { ok: true, outcome: { ticket: "9001" } } };
    expect(parseDirectReply(wire, "request-direct-1")).toEqual({ ok: true, outcome: { ticket: "9001" } });
    expect(parseDirectReply(wire, "request-direct-2")).toBeNull();
    expect(parseDirectReply({ ...wire, v: 2 }, "request-direct-1")).toBeNull();
    expect(parseDirectReply({ ...wire, reply: { ok: false, error: { code: "X", message: "no" } } }, "request-direct-1")).toEqual({
      ok: false,
      error: { code: "X", message: "no", statusCode: 502 },
    });
  });
});

describe("the web server's side", () => {
  const config: DirectLaneConfig = { base: "https://trade.example.com", secret: SECRET };
  const NOW = 5_000_000;
  const now = () => NOW;

  beforeEach(() => {
    resetDirectLane();
    vi.spyOn(console, "warn").mockImplementation(() => undefined); // (the client says once in a while that it put the lane aside)
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A worker that answers like the real one: the request's own timestamp echoed, the body signed. */
  function answering(reply: DirectReply, clientRequestId = "request-direct-1"): DirectTransport {
    return async (req) => {
      const body = JSON.stringify({ v: DIRECT_LANE_VERSION, clientRequestId, reply });
      const timestamp = req.headers[DIRECT_TIMESTAMP_HEADER];
      return {
        kind: "response",
        status: 200,
        headers: { [DIRECT_TIMESTAMP_HEADER]: timestamp, [DIRECT_SIGNATURE_HEADER]: signDirect(SECRET, timestamp, body) },
        body,
      };
    };
  }

  test("a verified answer is handed back as it is", async () => {
    const result = await sendDirect(config, request(), {
      deadlineMs: 5_000,
      now,
      transport: answering({ ok: true, outcome: { ticket: "9001" } }),
    });
    expect(result).toMatchObject({ kind: "answered", reply: { ok: true, outcome: { ticket: "9001" } } });
    expect(directLaneDown(NOW)).toBe(false);
  });

  test("the request that leaves is signed and carries the order", async () => {
    const seen: Array<{ headers: Record<string, string>; body: string | null }> = [];
    const transport: DirectTransport = async (req) => {
      seen.push({ headers: req.headers, body: req.body });
      return answering({ ok: true, outcome: {} })(req);
    };
    await sendDirect(config, request(), { deadlineMs: 5_000, now, transport });
    const [sent] = seen;
    expect(sent.body && JSON.parse(sent.body)).toMatchObject({ userId: USER, accountId: ACCOUNT, kind: "OPEN", clientRequestId: "request-direct-1" });
    expect(checkDirectAuth(SECRET, { timestamp: sent.headers[DIRECT_TIMESTAMP_HEADER], signature: sent.headers[DIRECT_SIGNATURE_HEADER] }, sent.body ?? "", NOW)).toBe("ok");
  });

  test("no connection means nothing was sent: the normal lane may take the order, and the lane rests for a while", async () => {
    const transport: DirectTransport = async () => ({ kind: "failed", connected: false, reason: "connect ECONNREFUSED" });
    const result = await sendDirect(config, request(), { deadlineMs: 5_000, now, transport });
    expect(result.kind).toBe("not_sent");
    expect(directLaneDown(NOW + 1)).toBe(true);
    expect(directLaneDown(NOW + DIRECT_DOWN_MS + 1)).toBe(false);
  });

  test("a connection that dropped after the request was written is uncertain - never 'not sent'", async () => {
    const transport: DirectTransport = async () => ({ kind: "failed", connected: true, reason: "socket hang up" });
    expect((await sendDirect(config, request(), { deadlineMs: 5_000, now, transport })).kind).toBe("uncertain");
  });

  test("a proxy's 502 may hide an order that ran; the worker's own 'busy' did not run one; a refusal did not either", async () => {
    const respond = (status: number, body: unknown): DirectTransport => async () => ({ kind: "response", status, headers: {}, body: JSON.stringify(body) });
    expect((await sendDirect(config, request(), { deadlineMs: 5_000, now, transport: respond(502, {}) })).kind).toBe("uncertain");
    expect((await sendDirect(config, request(), { deadlineMs: 5_000, now, transport: respond(503, { notSent: true, code: "BUSY" }) })).kind).toBe("not_sent");
    expect((await sendDirect(config, request(), { deadlineMs: 5_000, now, transport: respond(401, { code: "BAD_SIGNATURE" }) })).kind).toBe("not_sent");
  });

  test("an answer that is not signed with the secret is not believed", async () => {
    const transport: DirectTransport = async (req) => ({
      kind: "response",
      status: 200,
      headers: { [DIRECT_TIMESTAMP_HEADER]: req.headers[DIRECT_TIMESTAMP_HEADER], [DIRECT_SIGNATURE_HEADER]: "0".repeat(64) },
      body: JSON.stringify({ v: DIRECT_LANE_VERSION, clientRequestId: "request-direct-1", reply: { ok: true, outcome: {} } }),
    });
    expect((await sendDirect(config, request(), { deadlineMs: 5_000, now, transport })).kind).toBe("uncertain");
  });

  test("the lane is off until it is fully set up, and can be switched off without removing the settings", () => {
    const envOf = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
    const env = { WSA_TRADE_DIRECT_URL: "https://trade.example.com/", WSA_TRADE_DIRECT_SECRET: SECRET };
    expect(directLaneConfig(envOf(env))).toEqual({ base: "https://trade.example.com", secret: SECRET });
    expect(directLaneConfig(envOf({ ...env, WSA_TRADE_DIRECT: "false" }))).toBeNull();
    expect(directLaneConfig(envOf({ ...env, WSA_TRADE_DIRECT_SECRET: "short" }))).toBeNull();
    expect(directLaneConfig(envOf({ WSA_TRADE_DIRECT_SECRET: SECRET }))).toBeNull();
    expect(directLaneConfig(envOf({ ...env, WSA_TRADE_DIRECT_URL: "https://user:pw@trade.example.com" }))).toBeNull();
  });
});

describe("the durable direct-lane reservation", () => {
  test("the database unique key admits one request, and a later answer updates its reserved row", async () => {
    const db = new MemoryDb();
    db.unique.trade_commands = [["user_id", "client_request_id"]];
    const store = createSupabaseGatewayStore(memoryClient(db));
    const reservation = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      userId: USER,
      accountId: ACCOUNT,
      kind: "OPEN",
      payload: { symbol: "EURUSD.r", side: "BUY", volume: 0.1 },
      clientRequestId: "request-direct-1",
      receivedAt: "2026-10-24T12:00:00.000Z",
      expiresAt: "2026-10-24T12:00:12.000Z",
      startedAt: "2026-10-24T12:00:00.001Z",
      workerId: "worker-1",
    };
    expect(await store.reserveDirect?.(reservation)).toBe(true);
    expect(await store.reserveDirect?.({ ...reservation, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).toBe(false);
    expect(await store.findByRequest?.(USER, reservation.clientRequestId)).toMatchObject({ status: "RUNNING" });

    await store.recordDirect?.({ ...reservation, completedAt: "2026-10-24T12:00:00.500Z", outcome: { ticket: "9001" } });
    expect(await store.findByRequest?.(USER, reservation.clientRequestId)).toMatchObject({ status: "DONE", result: { ticket: "9001" } });
    expect(db.tables.trade_commands).toHaveLength(1);
  });
});

describe("the worker's side", () => {
  const clock = { t: Date.parse("2026-10-24T12:00:00.000Z") };

  function rig(storeExtra: Record<string, unknown> = {}, adapterExtra: Record<string, unknown> = {}) {
    const store = {
      claim: vi.fn(async () => []),
      owner: vi.fn(async () => ({ userId: USER, providerAccountId: "provider-1" })),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      sweep: vi.fn(async () => ({ expired: 0, lost: 0, purged: 0 })),
      watched: vi.fn(async () => []),
      saveState: vi.fn(async () => undefined),
      saveSymbols: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => undefined),
      retire: vi.fn(async () => undefined),
      recordDirect: vi.fn(async (entry: unknown) => {
        void entry;
      }),
      reserveDirect: vi.fn(async () => true),
      findByRequest: vi.fn(async (userId: string, clientRequestId: string): Promise<unknown> => {
        void userId;
        void clientRequestId;
        return null;
      }),
      ...storeExtra,
    };
    const adapter = {
      executionAvailable: vi.fn(() => true),
      fetchTradingState: vi.fn(async () => ({})),
      fetchQuote: vi.fn(async () => ({})),
      fetchSymbolList: vi.fn(async () => []),
      openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "9001", brokerOrderId: "9000" })),
      closeTrade: vi.fn(async () => ({ ok: true })),
      modifyTrade: vi.fn(async () => ({ ok: true })),
      cancelOrder: vi.fn(async () => ({ ok: true })),
      ...adapterExtra,
    };
    const warn = vi.fn();
    const worker = new GatewayWorker({
      store: store as unknown as GatewayStore,
      adapter: adapter as unknown as BrokerAdapter,
      workerId: "worker-1",
      log: vi.fn(),
      warn,
      now: () => clock.t,
      stateRefreshMs: 1_000,
    });
    return { store, adapter, worker, warn };
  }

  beforeEach(() => {
    clock.t = Date.parse("2026-10-24T12:00:00.000Z");
  });

  test("the order is reserved before it reaches the broker, then answered and recorded", async () => {
    const { store, adapter, worker } = rig();
    const reply = await worker.runDirect(request());
    expect(reply).toMatchObject({ ok: true, outcome: { ticket: "9001" } });
    expect(reply).not.toHaveProperty("repeated");
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
    expect(store.reserveDirect).toHaveBeenCalledTimes(1);
    expect(store.reserveDirect.mock.invocationCallOrder[0]).toBeLessThan(adapter.openTrade.mock.invocationCallOrder[0]);

    await worker.idle();
    expect(store.recordDirect).toHaveBeenCalledTimes(1);
    expect(store.recordDirect.mock.calls[0][0]).toMatchObject({
      userId: USER,
      accountId: ACCOUNT,
      kind: "OPEN",
      clientRequestId: "request-direct-1",
      outcome: { ticket: "9001" },
    });
    expect(store.complete).not.toHaveBeenCalled();
  });

  test("the same request again - after the answer or while it is still with the broker - never places a second order", async () => {
    let release!: (value: { ok: true; brokerPositionId: string; brokerOrderId: string }) => void;
    const brokerAnswer = new Promise<{ ok: true; brokerPositionId: string; brokerOrderId: string }>((resolve) => {
      release = resolve;
    });
    const { adapter, worker } = rig({}, { openTrade: vi.fn(() => brokerAnswer) });

    const first = worker.runDirect(request());
    await new Promise((resolve) => setTimeout(resolve, 15));
    const duringOrder = worker.runDirect(request({ attempt: 2 }));
    release({ ok: true, brokerPositionId: "9001", brokerOrderId: "9000" });
    const [a, b] = await Promise.all([first, duringOrder]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true, repeated: true, outcome: { ticket: "9001" } });

    clock.t += 5_000;
    expect(await worker.runDirect(request({ attempt: 2 }), clock.t)).toMatchObject({ ok: true, repeated: true });
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
  });

  test("a second try the worker has never seen first looks in the database before it sends anything", async () => {
    const stored = { status: "DONE", result: { ticket: "7001" }, error_code: null, error_message: null };
    const { store, adapter, worker } = rig({ reserveDirect: vi.fn(async () => false), findByRequest: vi.fn(async () => stored) });
    expect(await worker.runDirect(request({ attempt: 2 }))).toMatchObject({ ok: true, repeated: true, outcome: { ticket: "7001" } });
    expect(store.findByRequest).toHaveBeenCalledWith(USER, "request-direct-1");
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("when the first try may still be running, or the database cannot say, the answer is 'uncertain' and nothing is sent", async () => {
    const running = rig({ reserveDirect: vi.fn(async () => false), findByRequest: vi.fn(async () => ({ status: "RUNNING", result: null, error_code: null, error_message: null })) });
    expect(await running.worker.runDirect(request({ attempt: 2 }))).toMatchObject({ ok: false, error: { code: "ORDER_UNCERTAIN" } });
    expect(running.adapter.openTrade).not.toHaveBeenCalled();

    const broken = rig({ reserveDirect: vi.fn(async () => false), findByRequest: vi.fn(async () => { throw new Error("database down"); }) });
    expect(await broken.worker.runDirect(request({ attempt: 2 }))).toMatchObject({ ok: false, error: { code: "ORDER_UNCERTAIN" } });
    expect(broken.adapter.openTrade).not.toHaveBeenCalled();
    expect(broken.warn).toHaveBeenCalled();
  });

  test("after a worker restart, even a repeated attempt numbered 1 cannot place the order again", async () => {
    const first = rig();
    await first.worker.runDirect(request());
    const prior = { status: "RUNNING", result: null, error_code: null, error_message: null };
    const restarted = rig({ reserveDirect: vi.fn(async () => false), findByRequest: vi.fn(async () => prior) });
    expect(await restarted.worker.runDirect(request())).toMatchObject({ ok: false, error: { code: "ORDER_UNCERTAIN" } });
    expect(restarted.store.findByRequest).toHaveBeenCalledWith(USER, "request-direct-1");
    expect(restarted.adapter.openTrade).not.toHaveBeenCalled();
  });

  test("a database outage before reservation prevents broker execution", async () => {
    const broken = rig({ reserveDirect: vi.fn(async () => { throw new Error("database down"); }) });
    expect(await broken.worker.runDirect(request())).toMatchObject({ ok: false, error: { code: "ORDER_UNCERTAIN" } });
    expect(broken.adapter.openTrade).not.toHaveBeenCalled();
  });

  test("an account that is not the person's is refused and never reaches the broker", async () => {
    const { adapter, worker } = rig({ owner: vi.fn(async () => ({ userId: "ffffffff-ffff-4fff-8fff-ffffffffffff", providerAccountId: "p" })) });
    expect(await worker.runDirect(request())).toMatchObject({ ok: false });
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("a store that cannot record does not change the answer", async () => {
    const { worker, warn } = rig({ recordDirect: vi.fn(async () => { throw new Error("write failed"); }) });
    expect(await worker.runDirect(request())).toMatchObject({ ok: true, outcome: { ticket: "9001" } });
    await worker.idle();
    expect(warn).toHaveBeenCalled();
  });
});
