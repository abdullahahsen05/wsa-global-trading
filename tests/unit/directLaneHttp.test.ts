import * as http from "node:http";
import * as net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DIRECT_HEALTH_PATH,
  DIRECT_LANE_VERSION,
  DIRECT_PATH,
  DIRECT_SIGNATURE_HEADER,
  DIRECT_TIMESTAMP_HEADER,
  signDirect,
  type DirectRequest,
} from "@/lib/gateway/directLane";
import { directLaneDown, resetDirectLane, sendDirect, warmDirectLane } from "@/lib/gateway/directLaneClient";
import { startDirectLaneServer, type DirectLaneServer } from "@/lib/gateway/directLaneServer";

// The direct lane over a REAL socket: the client's real transport talking to the worker's real HTTP server on the loopback
// interface (an ephemeral port, no broker, no database). It is what the unit tests with a fake transport can not show.

const SECRET = "wire-test-secret-0123456789-abcdefghij";
const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

let server: DirectLaneServer;
const ran: DirectRequest[] = [];

function order(id: string): DirectRequest {
  return {
    v: DIRECT_LANE_VERSION,
    userId: USER,
    accountId: ACCOUNT,
    kind: "OPEN",
    payload: { symbol: "EURUSD", side: "BUY", volume: 0.1 },
    clientRequestId: id,
    ttlMs: 12_000,
    attempt: 1,
  };
}

/** A plain HTTP call that does not go through the client: what a stranger (or a wrong secret) would send. */
function raw(method: string, path: string, headers: Record<string, string> = {}, body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  server = await startDirectLaneServer({
    secret: SECRET,
    port: 0,
    host: "127.0.0.1",
    log: () => undefined,
    warn: () => undefined,
    run: async (request) => {
      ran.push(request);
      return { ok: true, outcome: { ticket: "9001" } };
    },
  });
});

afterAll(async () => {
  resetDirectLane();
  await server.close();
});

beforeEach(() => {
  resetDirectLane();
  ran.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the direct lane over a real connection", () => {
  const lane = () => ({ base: `http://127.0.0.1:${server.port}`, secret: SECRET });

  test("an order is run once by the worker and its signed answer is accepted - also on the connection that is reused", async () => {
    const first = await sendDirect(lane(), order("wire-request-1"), { deadlineMs: 5_000 });
    expect(first).toMatchObject({ kind: "answered", reply: { ok: true, outcome: { ticket: "9001" } } });
    const second = await sendDirect(lane(), order("wire-request-2"), { deadlineMs: 5_000 });
    expect(second.kind).toBe("answered");
    expect(ran.map((request) => request.clientRequestId)).toEqual(["wire-request-1", "wire-request-2"]);
    expect(directLaneDown()).toBe(false);
  });

  test("a sender that does not know the secret gets nothing run - and the client treats it as 'not sent'", async () => {
    const result = await sendDirect({ ...lane(), secret: "another-secret-another-secret-123456" }, order("wire-request-3"), { deadlineMs: 5_000 });
    expect(result.kind).toBe("not_sent");
    expect(ran).toHaveLength(0);
    expect(directLaneDown()).toBe(true);
  });

  test("strangers see nothing: unsigned calls are refused, other paths are empty 404s", async () => {
    expect((await raw("POST", DIRECT_PATH, { "content-type": "application/json" }, JSON.stringify(order("wire-request-4")))).status).toBe(401);
    expect((await raw("GET", DIRECT_HEALTH_PATH)).status).toBe(401);
    const unknown = await raw("GET", "/");
    expect(unknown).toEqual({ status: 404, text: "" });
    expect(ran).toHaveLength(0);

    // a request signed for a different body is refused too
    const timestamp = String(Date.now());
    const forged = await raw(
      "POST",
      DIRECT_PATH,
      { [DIRECT_TIMESTAMP_HEADER]: timestamp, [DIRECT_SIGNATURE_HEADER]: signDirect(SECRET, timestamp, "{}") },
      JSON.stringify(order("wire-request-5")),
    );
    expect(forged.status).toBe(401);
    expect(ran).toHaveLength(0);
  });

  test("the signed health check ends a 'down' memory", async () => {
    await sendDirect({ ...lane(), secret: "another-secret-another-secret-123456" }, order("wire-request-6"), { deadlineMs: 5_000 });
    expect(directLaneDown()).toBe(true);
    await warmDirectLane(lane());
    expect(directLaneDown()).toBe(false);
  });

  test("nobody listening is 'not sent': the normal lane may take the order", async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const result = await sendDirect({ base: `http://127.0.0.1:${free}`, secret: SECRET }, order("wire-request-7"), { deadlineMs: 5_000 });
    expect(result.kind).toBe("not_sent");
    expect(directLaneDown()).toBe(true);
  });
});
