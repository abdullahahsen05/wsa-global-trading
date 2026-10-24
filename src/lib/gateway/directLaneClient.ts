if (typeof window !== "undefined") {
  throw new Error("[wsa] directLaneClient is server-only.");
}

/**
 * Trade gateway - the web server's side of the DIRECT LANE (see `directLane.ts` for the idea and the protocol).
 *
 * `sendDirect` hands one order to the AWS worker over one HTTP request and returns what the worker said. It never
 * guesses: its answer is one of three things the caller can act on without any doubt.
 *
 *   answered   the worker ran the order and said how it went (the signature on the answer is checked, and the answer
 *              names the request it belongs to). A refusal from the worker is an answer too.
 *   not_sent   the request provably never reached the worker's code (no connection could be made, the secret or the
 *              clock is wrong, a proxy in front refused it, the worker was too busy). Nothing exists at the broker -
 *              the caller may use the normal lane (the database) for the very same order.
 *   uncertain  the request may have reached the worker (the connection dropped after it was written, no answer in
 *              time, an answer that could not be verified). The order may exist at the broker. The caller must NOT
 *              use another lane for it: it asks again with `attempt: 2` (the worker then looks for its own earlier
 *              answer in the database) and, failing that, reads the database without writing anything.
 *
 * The connection is kept open between orders (keep-alive, a dedicated agent) and `warmDirectLane` renews it while
 * somebody is looking at the panel, so the first order after a quiet moment does not start with a TCP + TLS handshake.
 * Plain `node:http(s)` - no extra package - and a dedicated agent: nothing here touches the global fetch pool.
 *
 * Nothing in this file reads or returns a credential. No Next / React imports.
 */

import * as http from "node:http";
import * as https from "node:https";
import {
  DIRECT_HEALTH_PATH,
  DIRECT_LANE_VERSION,
  DIRECT_PATH,
  DIRECT_SIGNATURE_HEADER,
  DIRECT_TIMESTAMP_HEADER,
  describeDirectFailure,
  describeDirectHttp,
  directSignatureMatches,
  parseDirectReply,
  signDirect,
  validDirectSecret,
  type DirectReply,
  type DirectRequest,
} from "./directLane";
import { directLaneClientTls } from "./directLaneTls";

/** A connection that is not open after this long is given up on (the order is then sent the normal way). */
export const DIRECT_CONNECT_TIMEOUT_MS = 2_000;
/** After a failure the lane is not tried for new orders for this long ... */
export const DIRECT_DOWN_MS = 15_000;
/** ... and for this long after the worker refused the request itself (wrong secret / clock, wrong address). */
export const DIRECT_MISCONFIGURED_DOWN_MS = 60_000;
/** The warm-up asks the worker at most this often (per server instance). */
export const DIRECT_PING_EVERY_MS = 3_000;
const DIRECT_PING_DEADLINE_MS = 2_500;
const MAX_ANSWER_BYTES = 256 * 1024;

export interface DirectLaneConfig {
  /** origin + path prefix, no trailing slash: `https://trade.example.com` */
  base: string;
  secret: string;
}

let configMemo: { urlText: string; secret: string; config: DirectLaneConfig | null } | null = null;

/**
 * The lane's address and secret from the environment, or null while it is not set up (then orders use the database).
 * `WSA_TRADE_DIRECT=false` switches it off without removing the settings.
 */
export function directLaneConfig(env: NodeJS.ProcessEnv = process.env): DirectLaneConfig | null {
  if (env.WSA_TRADE_DIRECT?.trim().toLowerCase() === "false") return null;
  const urlText = env.WSA_TRADE_DIRECT_URL?.trim() ?? "";
  const secret = env.WSA_TRADE_DIRECT_SECRET?.trim() ?? "";
  if (!urlText || !validDirectSecret(secret)) return null;
  if (configMemo && configMemo.urlText === urlText && configMemo.secret === secret) return configMemo.config;
  let config: DirectLaneConfig | null = null;
  try {
    const parsed = new URL(urlText);
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname && !parsed.username && !parsed.password) {
      config = { base: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, secret };
    }
  } catch {
    config = null;
  }
  configMemo = { urlText, secret, config };
  return config;
}

// ── the transport (replaceable in tests) ──────────────────────────────────────

export interface DirectTransportRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
  /** the whole exchange must be over by then */
  deadlineMs: number;
  /** a connection that is not open by then is given up on */
  connectTimeoutMs: number;
  /** the shared secret: over https:// the worker's certificate is the one this secret gives it (see `directLaneTls.ts`) */
  tlsSecret?: string;
}

export type DirectTransportResult =
  | { kind: "response"; status: number; headers: Record<string, string | undefined>; body: string }
  /** `connected`: the connection to the worker had been made - the request may have been written */
  | { kind: "failed"; connected: boolean; reason: string };

export type DirectTransport = (request: DirectTransportRequest) => Promise<DirectTransportResult>;

let httpAgent: http.Agent | null = null;
let httpsAgent: { secret: string; agent: https.Agent } | null = null;

/**
 * Connections are reused (most recently used first - the least likely to have gone stale) and never shared with anything else.
 * Over https:// the agent trusts the certificate the shared secret gives the worker (and the public authorities, for a proxy
 * with a certificate of its own); a connection to anything else is refused before the order is written.
 */
function agentFor(protocol: string, secret: string | undefined): http.Agent {
  const options = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 32, maxFreeSockets: 8, scheduling: "lifo" as const };
  if (protocol === "https:") {
    const key = secret?.trim() ?? "";
    if (!httpsAgent || httpsAgent.secret !== key) {
      httpsAgent?.agent.destroy();
      httpsAgent = { secret: key, agent: new https.Agent(key ? { ...options, ...directLaneClientTls(key) } : options) };
    }
    return httpsAgent.agent;
  }
  httpAgent ??= new http.Agent(options);
  return httpAgent;
}

const nodeTransport: DirectTransport = (request) =>
  new Promise<DirectTransportResult>((resolve) => {
    let done = false;
    let connected = false;
    const timers: { connect?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout> } = {};
    const finish = (result: DirectTransportResult) => {
      if (done) return;
      done = true;
      if (timers.connect) clearTimeout(timers.connect);
      if (timers.deadline) clearTimeout(timers.deadline);
      resolve(result);
    };

    const secure = request.url.protocol === "https:";
    const open = secure ? https.request : http.request;
    const outgoing = open(
      request.url,
      { method: request.method, headers: request.headers, agent: agentFor(request.url.protocol, request.tlsSecret) },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) {
            outgoing.destroy();
            finish({ kind: "failed", connected: true, reason: "the answer is too large" });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish({
            kind: "response",
            status: response.statusCode ?? 0,
            headers: {
              [DIRECT_TIMESTAMP_HEADER]: firstHeader(response.headers[DIRECT_TIMESTAMP_HEADER]),
              [DIRECT_SIGNATURE_HEADER]: firstHeader(response.headers[DIRECT_SIGNATURE_HEADER]),
            },
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error) => finish({ kind: "failed", connected: true, reason: error.message }));
        response.on("close", () => {
          if (!response.complete) finish({ kind: "failed", connected: true, reason: "the connection closed during the answer" });
        });
      },
    );

    outgoing.on("socket", (socket) => {
      // A socket from the pool is open already. A new one has to connect (and, for https, shake hands) in time.
      if (!socket.connecting) {
        connected = true;
        return;
      }
      timers.connect = setTimeout(() => {
        outgoing.destroy(new Error("the connection could not be opened in time"));
      }, request.connectTimeoutMs);
      socket.once(secure ? "secureConnect" : "connect", () => {
        connected = true;
        if (timers.connect) clearTimeout(timers.connect);
        timers.connect = undefined;
      });
    });
    outgoing.on("error", (error) => finish({ kind: "failed", connected, reason: error.message }));
    outgoing.setNoDelay(true);
    timers.deadline = setTimeout(() => {
      finish({ kind: "failed", connected, reason: "no answer in time" });
      outgoing.destroy();
    }, request.deadlineMs);
    outgoing.end(request.body ?? undefined);
  });

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ── is the lane worth trying? ─────────────────────────────────────────────────

let downUntil = 0;
let downNote = "";
let downLoggedAt = 0;
let lastPingAt = 0;
let pinging: Promise<void> | null = null;

/** Test helper. */
export function resetDirectLane(): void {
  downUntil = 0;
  downNote = "";
  downLoggedAt = 0;
  lastPingAt = 0;
  pinging = null;
  configMemo = null;
  httpAgent?.destroy();
  httpsAgent?.agent.destroy();
  httpAgent = null;
  httpsAgent = null;
}

/** The lane did not work a moment ago: new orders go the normal way until this passes (a successful warm-up ends it sooner). */
export function directLaneDown(now: number = Date.now()): boolean {
  return now < downUntil;
}

function markDown(now: number, forMs: number, note: string): void {
  downUntil = Math.max(downUntil, now + forMs);
  downNote = note;
  // said once in a while, not for every order
  if (now - downLoggedAt > 30_000) {
    downLoggedAt = now;
    console.warn(`[web-trade] the direct lane to the AWS worker is not used for ${Math.round(forMs / 1000)} s: ${note}`);
  }
}

/** Why the lane was last put aside (for the log and for tests). */
export function directLaneDownNote(): string {
  return downNote;
}

// ── sending ───────────────────────────────────────────────────────────────────

export type DirectSend =
  | { kind: "answered"; reply: DirectReply; ms: number }
  | { kind: "not_sent"; reason: string }
  | { kind: "uncertain"; reason: string };

export interface DirectSendOptions {
  /** the answer must be here by then, else the result is "uncertain" */
  deadlineMs: number;
  now?: () => number;
  transport?: DirectTransport;
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function urlOf(config: DirectLaneConfig, path: string): URL {
  return new URL(`${config.base}${path}`);
}

/**
 * Sends one order to the worker. Never throws and never writes anywhere: the caller decides what the three possible
 * results mean for it (see the top of this file). Also keeps the "lane is down" memory up to date.
 */
export async function sendDirect(
  config: DirectLaneConfig,
  request: DirectRequest,
  options: DirectSendOptions,
): Promise<DirectSend> {
  const now = options.now ?? Date.now;
  const transport = options.transport ?? nodeTransport;
  const body = JSON.stringify(request);
  const timestamp = String(now());
  const startedAt = now();
  const deadlineMs = Math.max(200, options.deadlineMs);

  let result: DirectTransportResult;
  try {
    result = await transport({
      url: urlOf(config, DIRECT_PATH),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        accept: "application/json",
        [DIRECT_TIMESTAMP_HEADER]: timestamp,
        [DIRECT_SIGNATURE_HEADER]: signDirect(config.secret, timestamp, body),
      },
      body,
      deadlineMs,
      connectTimeoutMs: Math.min(DIRECT_CONNECT_TIMEOUT_MS, deadlineMs),
      tlsSecret: config.secret,
    });
  } catch (error) {
    // (the transport does not throw; if it ever does the request may have gone out)
    return { kind: "uncertain", reason: error instanceof Error ? error.message : "the request failed" };
  }
  const ms = Math.max(0, now() - startedAt);

  if (result.kind === "failed") {
    // (a secure connection that was refused never got as far as writing the order: `connected` is only true once it is open)
    markDown(now(), DIRECT_DOWN_MS, describeDirectFailure(result.reason));
    return result.connected ? { kind: "uncertain", reason: result.reason } : { kind: "not_sent", reason: result.reason };
  }

  const { status } = result;
  if (status === 200) {
    const echoed = result.headers[DIRECT_TIMESTAMP_HEADER];
    const signature = result.headers[DIRECT_SIGNATURE_HEADER];
    // the answer carries the request's own timestamp, so an old answer can not be passed off as this one
    if (echoed === timestamp && directSignatureMatches(config.secret, timestamp, result.body, signature)) {
      const reply = parseDirectReply(readJson(result.body), request.clientRequestId);
      if (reply) return { kind: "answered", reply, ms };
    }
    markDown(now(), DIRECT_MISCONFIGURED_DOWN_MS, "an answer arrived that could not be verified");
    return { kind: "uncertain", reason: "the answer could not be verified" };
  }

  // The worker never answers 3xx / 4xx once it has started an order, so such an answer (or a proxy's own refusal) means
  // nothing was run. A 5xx is ours only when it says so (busy); any other 5xx - a proxy's 502 / 504 - may hide an order that ran.
  if (status >= 300 && status < 500) {
    const code = (readJson(result.body) as { code?: unknown } | null)?.code;
    const reason = `HTTP ${status}${typeof code === "string" ? ` ${code}` : ""}`;
    markDown(
      now(),
      status === 408 || status === 429 ? DIRECT_DOWN_MS : DIRECT_MISCONFIGURED_DOWN_MS,
      describeDirectHttp(status, typeof code === "string" ? code : undefined),
    );
    return { kind: "not_sent", reason };
  }
  if (status >= 500) {
    const parsed = readJson(result.body) as { notSent?: unknown; code?: unknown } | null;
    if (parsed && parsed.notSent === true) {
      const reason = `HTTP ${status}${typeof parsed.code === "string" ? ` ${parsed.code}` : ""}`;
      markDown(now(), DIRECT_DOWN_MS, reason);
      return { kind: "not_sent", reason };
    }
    markDown(now(), DIRECT_DOWN_MS, `HTTP ${status}`);
    return { kind: "uncertain", reason: `HTTP ${status}` };
  }
  return { kind: "uncertain", reason: `HTTP ${status}` };
}

// ── keeping the connection warm ───────────────────────────────────────────────

/**
 * Asks the worker "are you there?" (a signed GET, answered at once) - at most every few seconds per server instance. It keeps
 * the connection open for the next order, finds out early that the lane is down (so no order loses time on a dead lane) and
 * ends the "down" memory the moment the lane works again. Never throws, never waits longer than a couple of seconds.
 */
export function warmDirectLane(
  config: DirectLaneConfig,
  options: { now?: () => number; transport?: DirectTransport } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const at = now();
  if (pinging) return pinging;
  if (at - lastPingAt < DIRECT_PING_EVERY_MS) return Promise.resolve();
  lastPingAt = at;
  const transport = options.transport ?? nodeTransport;
  const timestamp = String(at);
  const run = (async () => {
    try {
      const result = await transport({
        url: urlOf(config, DIRECT_HEALTH_PATH),
        method: "GET",
        headers: {
          accept: "application/json",
          [DIRECT_TIMESTAMP_HEADER]: timestamp,
          [DIRECT_SIGNATURE_HEADER]: signDirect(config.secret, timestamp, ""),
        },
        body: null,
        deadlineMs: DIRECT_PING_DEADLINE_MS,
        connectTimeoutMs: DIRECT_CONNECT_TIMEOUT_MS,
        tlsSecret: config.secret,
      });
      if (result.kind === "failed") {
        markDown(now(), DIRECT_DOWN_MS, describeDirectFailure(result.reason));
        return;
      }
      if (result.status === 200) {
        const parsed = readJson(result.body) as { v?: unknown; ok?: unknown } | null;
        const echoed = result.headers[DIRECT_TIMESTAMP_HEADER];
        if (
          echoed === timestamp &&
          directSignatureMatches(config.secret, timestamp, result.body, result.headers[DIRECT_SIGNATURE_HEADER]) &&
          parsed?.v === DIRECT_LANE_VERSION &&
          parsed.ok === true
        ) {
          downUntil = 0;
          downNote = "";
          return;
        }
        markDown(now(), DIRECT_MISCONFIGURED_DOWN_MS, "the worker's answer could not be verified");
        return;
      }
      const code = (readJson(result.body) as { code?: unknown } | null)?.code;
      markDown(
        now(),
        result.status === 401 || result.status === 404 ? DIRECT_MISCONFIGURED_DOWN_MS : DIRECT_DOWN_MS,
        describeDirectHttp(result.status, typeof code === "string" ? code : undefined),
      );
    } catch {
      // a warm-up is a courtesy
    }
  })().finally(() => {
    pinging = null;
  });
  pinging = run;
  return run;
}
