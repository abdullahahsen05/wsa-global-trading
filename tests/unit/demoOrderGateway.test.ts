import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../deploy/aws/demo-order-gateway/index";
import { sendDirect } from "@/lib/gateway/directLaneClient";
import { mintOrderPass } from "@/lib/services/webTradePass";

vi.mock("@/lib/gateway/directLaneClient", () => ({ sendDirect: vi.fn() }));

const user = "137e4868-6f58-437d-bc76-374acdc36d89";
const account = "3faac609-0b67-4b1c-96e5-3e397c19955a";
const order = { accountId: account, symbol: "XAUUSD", side: "BUY", volume: 0.01, orderKind: "MARKET", clientRequestId: "12345678-1234-1234-1234-123456789abc" };

function authEvent(riskReadAt: number | null = Date.now(), body: unknown = order) {
  const now = Date.now();
  const jwt = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: user, exp: Math.ceil(now / 1000) + 60 })).toString("base64url"),
    "test-signature",
  ].join(".");
  const pass = mintOrderPass({
    user: { id: user, role: "TRADER" }, accountId: account,
    tokenKey: createHash("sha256").update(jwt).digest("base64url"),
    tokenExpiresAtMs: now + 60_000, riskReadAt,
    aws: { direct: true, longPoll: true, dbMs: 30 },
  }, now);
  return {
    rawPath: "/demo/open", requestContext: { http: { method: "POST" } },
    headers: { authorization: `Bearer ${jwt}`, "x-wsa-pass": pass ?? "" },
    body: JSON.stringify(body),
  };
}

describe("demo AWS order gateway", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-with-32-characters";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.WSA_DEMO_ACCOUNT_ID = account;
    process.env.WSA_DEMO_USER_ID = user;
    process.env.WSA_TRADE_DIRECT_SECRET = "test-direct-secret-with-32-characters";
    process.env.WSA_TRADE_DIRECT_URL = "https://worker.example:8787";
    process.env.WSA_DEMO_ORDER_ENABLED = "true";
  });

  it("refuses non-order routes and non-allowlisted accounts before execution", async () => {
    const wrongRoute = await handler({ ...authEvent(), rawPath: "/demo/close" });
    expect(wrongRoute.statusCode).toBe(404);
    const wrongAccount = await handler(authEvent(Date.now(), { ...order, accountId: "00000000-0000-4000-8000-000000000001" }));
    expect(wrongAccount.statusCode).toBe(403);
    expect(sendDirect).not.toHaveBeenCalled();
  });

  it("requires a fresh risk-cleared, token-bound pass", async () => {
    const missingPass = await handler({ ...authEvent(), headers: { authorization: "Bearer x", "x-wsa-pass": "" } });
    expect(missingPass.statusCode).toBe(401);
    const staleRisk = await handler(authEvent(null));
    expect(staleRisk.statusCode).toBe(401);
    expect(sendDirect).not.toHaveBeenCalled();
  });

  it("limits the pilot to 0.01-lot market orders", async () => {
    const tooLarge = await handler(authEvent(Date.now(), { ...order, volume: 0.02 }));
    expect(tooLarge.statusCode).toBe(403);
    const pending = await handler(authEvent(Date.now(), { ...order, orderKind: "LIMIT", price: 100 }));
    expect(pending.statusCode).toBe(403);
    expect(sendDirect).not.toHaveBeenCalled();
  });

  it("returns a confirmed signed-worker result and audits one new order", async () => {
    vi.mocked(sendDirect).mockResolvedValue({
      kind: "answered", ms: 70,
      reply: { ok: true, outcome: { ticket: "123", timing: { queueMs: 20, runMs: 50, sendMs: 45 } } },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler(authEvent());
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.data.ticket).toBe("123");
    expect(body.data.timing.awsBrowserPilot).toBe(true);
    expect(sendDirect).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("never falls back to another route after an uncertain send", async () => {
    vi.mocked(sendDirect).mockResolvedValue({ kind: "uncertain", reason: "lost reply" });
    const response = await handler(authEvent());
    expect(response.statusCode).toBe(504);
    expect(JSON.parse(response.body).error.notSent).toBeUndefined();
    expect(sendDirect).toHaveBeenCalledTimes(2);
  });
});
