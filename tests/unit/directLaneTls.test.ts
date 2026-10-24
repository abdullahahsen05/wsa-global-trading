import * as https from "node:https";
import { X509Certificate } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import {
  DIRECT_LANE_VERSION,
  describeDirectFailure,
  describeDirectHttp,
  directLaneMismatch,
  directLaneStatus,
  type DirectLaneStatusInput,
  type DirectRequest,
} from "@/lib/gateway/directLane";
import { directLaneDown, directLaneDownNote, resetDirectLane, sendDirect, warmDirectLane } from "@/lib/gateway/directLaneClient";
import { startDirectLaneServer, type DirectLaneServer } from "@/lib/gateway/directLaneServer";
import { certificateHasKey, deriveDirectLaneIdentity, directLaneServerTls } from "@/lib/gateway/directLaneTls";
import type { GatewayStore } from "@/lib/gateway/gatewayStore";
import { GatewayWorker } from "@/lib/gateway/gatewayWorker";

// The direct lane's transport security: a key and a self-signed certificate that the web server and the worker both work out
// from the shared secret. What must hold: the certificate is a real, valid X.509 certificate; a connection is accepted only
// when the other end has the key of THIS secret (whatever address it is reached under); and the status the panel shows says
// what is wrong when the address and the worker do not fit together.

const SECRET = "tls-lane-secret-0123456789-abcdefghijk";
const OTHER_SECRET = "another-secret-another-secret-123456";
const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

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

describe("the identity both ends work out from the secret", () => {
  test("the same secret always gives the same key and certificate, another secret an unrelated one", () => {
    const first = deriveDirectLaneIdentity(SECRET);
    const again = deriveDirectLaneIdentity(`  ${SECRET}\n`);
    expect(again.certPem).toBe(first.certPem);
    expect(again.keyPem).toBe(first.keyPem);
    expect(again.spki.equals(first.spki)).toBe(true);

    const other = deriveDirectLaneIdentity(OTHER_SECRET);
    expect(other.certPem).not.toBe(first.certPem);
    expect(other.spki.equals(first.spki)).toBe(false);
  });

  test("it is a real X.509 certificate: self-signed, valid for decades, carrying exactly the derived key", () => {
    const identity = deriveDirectLaneIdentity(SECRET);
    const cert = new X509Certificate(identity.certPem);

    expect(cert.subject).toContain("CN=wsa-direct-lane");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.ca).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkIssued(cert)).toBe(true);
    expect(cert.publicKey.export({ type: "spki", format: "der" }).equals(identity.spki)).toBe(true);
    expect(cert.publicKey.asymmetricKeyType).toBe("ed25519");
    expect(Date.parse(cert.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now() + 20 * 365 * 86_400_000);
    // the private key is a PKCS#8 PEM and never part of the certificate
    expect(identity.keyPem).toContain("BEGIN PRIVATE KEY");
    expect(identity.certPem).not.toContain("PRIVATE");
  });

  test("a certificate is recognised by its KEY: the right one yes, another secret's no, garbage no", () => {
    const mine = deriveDirectLaneIdentity(SECRET);
    const other = deriveDirectLaneIdentity(OTHER_SECRET);
    const raw = new X509Certificate(mine.certPem).raw;
    expect(certificateHasKey(raw, mine.spki)).toBe(true);
    expect(certificateHasKey(raw, other.spki)).toBe(false);
    expect(certificateHasKey(undefined, mine.spki)).toBe(false);
    expect(certificateHasKey(Buffer.from("not a certificate"), mine.spki)).toBe(false);
  });

  test("the worker's HTTPS settings carry that key and certificate, a TLS floor and a handshake time limit", () => {
    const tls = directLaneServerTls(SECRET);
    const identity = deriveDirectLaneIdentity(SECRET);
    expect(tls.key).toBe(identity.keyPem);
    expect(tls.cert).toBe(identity.certPem);
    expect(tls.minVersion).toBe("TLSv1.2");
    expect(tls.handshakeTimeout).toBeLessThanOrEqual(10_000);
  });
});

describe("the lane over a real HTTPS connection", () => {
  let secure: DirectLaneServer;
  let plain: DirectLaneServer;
  const ran: DirectRequest[] = [];
  const run = async (request: DirectRequest) => {
    ran.push(request);
    return { ok: true as const, outcome: { ticket: "9001" } };
  };

  beforeAll(async () => {
    secure = await startDirectLaneServer({ secret: SECRET, port: 0, host: "127.0.0.1", tls: true, log: () => undefined, warn: () => undefined, run });
    plain = await startDirectLaneServer({ secret: SECRET, port: 0, host: "127.0.0.1", log: () => undefined, warn: () => undefined, run });
  });

  afterAll(async () => {
    resetDirectLane();
    await Promise.all([secure.close(), plain.close()]);
  });

  beforeEach(() => {
    resetDirectLane();
    ran.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  const secureLane = (secret = SECRET) => ({ base: `https://127.0.0.1:${secure.port}`, secret });

  test("the servers say whether they serve HTTPS (the heartbeat passes it on)", () => {
    expect(secure.tls).toBe(true);
    expect(plain.tls).toBe(false);
  });

  test("an order is run once and its signed answer accepted over HTTPS - also on the connection that is reused", async () => {
    // (the certificate has no address in it at all: the key is what is checked, not the name 127.0.0.1)
    const first = await sendDirect(secureLane(), order("tls-request-1"), { deadlineMs: 5_000 });
    expect(first).toMatchObject({ kind: "answered", reply: { ok: true, outcome: { ticket: "9001" } } });
    const second = await sendDirect(secureLane(), order("tls-request-2"), { deadlineMs: 5_000 });
    expect(second.kind).toBe("answered");
    expect(ran.map((request) => request.clientRequestId)).toEqual(["tls-request-1", "tls-request-2"]);
    expect(directLaneDown()).toBe(false);
  });

  test("a web server with another secret does not trust the worker: nothing is written, nothing runs, and it is told why", async () => {
    const result = await sendDirect(secureLane(OTHER_SECRET), order("tls-request-3"), { deadlineMs: 5_000 });
    expect(result.kind).toBe("not_sent");
    expect(ran).toHaveLength(0);
    expect(directLaneDown()).toBe(true);
    expect(directLaneDownNote()).toContain("WSA_TRADE_DIRECT_SECRET");
  });

  test("an ordinary HTTPS client (no key) can not talk to the port either", async () => {
    const failure = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const req = https.request({ host: "127.0.0.1", port: secure.port, path: "/v1/health", agent: false }, () => resolve(new Error("answered") as NodeJS.ErrnoException));
      req.on("error", resolve);
      req.end();
    });
    expect(failure.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|CERT/);
    expect(ran).toHaveLength(0);
  });

  test("the signed health check works over HTTPS and ends a 'down' memory", async () => {
    await sendDirect(secureLane(OTHER_SECRET), order("tls-request-4"), { deadlineMs: 5_000 });
    expect(directLaneDown()).toBe(true);
    await warmDirectLane(secureLane());
    expect(directLaneDown()).toBe(false);
  });

  test("https:// to a worker that serves plain HTTP is 'not sent', with a note that says the two are mixed up", async () => {
    const result = await sendDirect({ base: `https://127.0.0.1:${plain.port}`, secret: SECRET }, order("tls-request-5"), { deadlineMs: 5_000 });
    expect(result.kind).toBe("not_sent");
    expect(ran).toHaveLength(0);
    expect(directLaneDownNote()).toContain("https://");
  });

  test("http:// to a worker that serves HTTPS runs nothing (the worker's TLS layer closes the connection)", async () => {
    const result = await sendDirect({ base: `http://127.0.0.1:${secure.port}`, secret: SECRET }, order("tls-request-6"), { deadlineMs: 3_000 });
    expect(result.kind).not.toBe("answered");
    expect(ran).toHaveLength(0);
  });
});

describe("the heartbeat tells the web server whether the port serves HTTPS", () => {
  function rig() {
    const store = { heartbeat: vi.fn(async () => undefined) as unknown as ReturnType<typeof vi.fn> };
    const adapter = { executionAvailable: vi.fn(() => true) };
    const worker = new GatewayWorker({
      store: store as unknown as GatewayStore,
      adapter: adapter as unknown as BrokerAdapter,
      workerId: "worker-1",
      log: vi.fn(),
      warn: vi.fn(),
      now: () => Date.parse("2026-10-24T12:00:00.000Z"),
    });
    return { store, worker };
  }
  const infoOf = (store: { heartbeat: { mock: { calls: unknown[][] } } }) => store.heartbeat.mock.calls[0][2];

  test("listening over HTTPS, listening over plain HTTP, and not listening", async () => {
    const secure = rig();
    secure.worker.setDirectLane(true, true);
    await secure.worker.heartbeatOnce();
    expect(infoOf(secure.store)).toMatchObject({ direct: true, directTls: true });

    const plain = rig();
    plain.worker.setDirectLane(true);
    await plain.worker.heartbeatOnce();
    expect(infoOf(plain.store)).toMatchObject({ direct: true, directTls: false });

    const off = rig();
    off.worker.setDirectLane(false, true);
    await off.worker.heartbeatOnce();
    expect(infoOf(off.store)).toMatchObject({ direct: false, directTls: false });
  });
});

describe("what the panel's lane chip says", () => {
  const working: DirectLaneStatusInput = {
    configured: true,
    secureUrl: true,
    workerListening: true,
    workerTls: true,
    down: false,
    downNote: "",
  };

  test("direct while everything fits and works", () => {
    expect(directLaneStatus(working)).toEqual({ lane: "direct", note: null });
    // a proxy with a certificate of its own in front of a plain worker is a normal set-up
    expect(directLaneStatus({ ...working, workerTls: false })).toEqual({ lane: "direct", note: null });
    // a worker that does not report its port is not second-guessed
    expect(directLaneStatus({ ...working, workerTls: undefined })).toEqual({ lane: "direct", note: null });
  });

  test("not set up: the usual way, with nothing to say", () => {
    expect(directLaneStatus({ ...working, configured: false })).toEqual({ lane: "database", note: null });
  });

  test("meant to be used but not working: the usual way, and why", () => {
    expect(directLaneStatus({ ...working, workerListening: false })).toMatchObject({
      lane: "database",
      note: expect.stringContaining("WSA_TRADE_DIRECT_SECRET"),
    });
    expect(directLaneStatus({ ...working, secureUrl: false })).toMatchObject({
      lane: "database",
      note: expect.stringContaining("https://"),
    });
    expect(directLaneStatus({ ...working, down: true, downNote: "Nothing listens there" })).toEqual({
      lane: "database",
      note: "Paused for a moment: Nothing listens there",
    });
  });

  test("only the worker serving HTTPS behind an http:// address is a mismatch", () => {
    expect(directLaneMismatch(false, true)).toContain("https://");
    expect(directLaneMismatch(true, true)).toBeNull();
    expect(directLaneMismatch(true, false)).toBeNull();
    expect(directLaneMismatch(false, false)).toBeNull();
    expect(directLaneMismatch(false, undefined)).toBeNull();
  });
});

describe("failures in words", () => {
  test("a transport error says what to check, and keeps the original text", () => {
    expect(describeDirectFailure("connect ECONNREFUSED 10.0.0.5:8787")).toMatch(/^Nothing listens there.*ECONNREFUSED/);
    expect(describeDirectFailure("the connection could not be opened in time")).toContain("security group");
    expect(describeDirectFailure("getaddrinfo ENOTFOUND trade.example.com")).toContain("host name");
    expect(describeDirectFailure("error:0A00010B:SSL routines::wrong version number")).toContain("https://");
    expect(describeDirectFailure("self-signed certificate")).toContain("WSA_TRADE_DIRECT_SECRET");
    expect(describeDirectFailure("socket hang up")).toContain("closed the connection");
    expect(describeDirectFailure("something unexpected")).toBe("something unexpected");
    expect(describeDirectFailure("  ")).toBe("unknown error");
  });

  test("an HTTP refusal says what to check", () => {
    expect(describeDirectHttp(401, "DIRECT_AUTH_BAD_SIGNATURE")).toContain("exactly the same");
    expect(describeDirectHttp(401, "DIRECT_AUTH_STALE")).toContain("clocks");
    expect(describeDirectHttp(404, undefined)).toContain("WSA_TRADE_DIRECT_URL");
    expect(describeDirectHttp(503, "DIRECT_BUSY")).toBe("HTTP 503 DIRECT_BUSY");
  });
});
