/**
 * Trade gateway - the DIRECT LANE: the web server hands an order straight to the AWS worker.
 *
 * Through the database (the normal lane) an order pays for the distance to the database twice: the web
 * server writes the command (one round trip), the worker wakes up and, afterwards, writes the answer (a second
 * one) which the web server then has to read. On a database that is a few hundred milliseconds away that is
 * more than half of everything an order costs - the broker's own part is about 150-250 ms.
 *
 * The direct lane is what the copy-trading engine already does: the order reaches the worker that holds the broker
 * session over one HTTP request. The worker first reserves (user, request id) in the database, then sends it to
 * the broker and answers the request. The final result is written afterwards for the audit trail and retries.
 *
 *   web (Vercel)  --- POST /v1/trade, signed --->  worker (AWS)  --- reserve ---> database
 *                                                    `--- order ---> broker
 *                 <------- signed answer -------
 *                                                     `-- later: update trade_commands (DONE / FAILED)
 *
 * It is OFF unless both sides have `WSA_TRADE_DIRECT_SECRET` (and the web side `WSA_TRADE_DIRECT_URL`); it is only
 * used while the worker's heartbeat says it is listening, and any trouble reaching it falls back to the normal lane
 * ONLY when the request provably never arrived (see `directLaneClient.ts`). Nothing about gates changes: the web server
 * still checks the session, subscription, risk rules and ownership BEFORE it sends anything, the worker still checks
 * the owner of the account, and (user, clientRequestId) is still one order. Its durable reservation prevents a
 * repeated request from placing a second order even after a worker restart.
 *
 * Authentication: HMAC-SHA256 over `${timestamp}.${body}` with a shared secret (>= 32 characters), compared in
 * constant time, accepted within +-20 s of the worker's clock. The answer is signed the same way. No credentials
 * of any kind travel on this lane (the body is the order: symbol, side, volume, levels). The worker's port serves HTTPS
 * by itself (`directLaneTls.ts`: a key and a self-signed certificate that both ends work out from the same secret - nothing
 * to buy, install or copy), so the order is not readable on the way either. A proxy with a certificate of its own in front
 * of a plain port (`WSA_TRADE_DIRECT_TLS=off` on the worker, an https:// address on the web) works as well.
 *
 * Pure apart from `node:crypto`: no Next / React imports, shared by the web app and the AWS worker.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ORDER_COMMAND_KINDS, isTradeCommandKind, type StoredCommandError, type TradeCommandKind, type TradeCommandOutcome } from "./tradeCommands";

export const DIRECT_LANE_VERSION = 1;
export const DIRECT_PATH = "/v1/trade";
export const DIRECT_HEALTH_PATH = "/v1/health";
export const DIRECT_TIMESTAMP_HEADER = "x-wsa-ts";
export const DIRECT_SIGNATURE_HEADER = "x-wsa-sig";
/** Largest request body the worker reads (an order is a few hundred bytes). */
export const DIRECT_MAX_BODY_BYTES = 16 * 1024;
/** How far the sender's clock may be from the worker's. */
export const DIRECT_CLOCK_SKEW_MS = 20_000;
export const DIRECT_MIN_SECRET_LENGTH = 32;
/** How long an order may wait in the worker (behind another order on the same account) before it is NOT sent. */
export const DIRECT_ORDER_TTL_MS = 12_000;
const DIRECT_TTL_MIN_MS = 1_000;
const DIRECT_TTL_MAX_MS = 60_000;

/** The secret is usable: long enough that guessing it is out of the question. */
export function validDirectSecret(secret: string | undefined | null): secret is string {
  return typeof secret === "string" && secret.trim().length >= DIRECT_MIN_SECRET_LENGTH;
}

// ── signing ───────────────────────────────────────────────────────────────────

/** Hex HMAC-SHA256 of `${timestamp}.${body}`. */
export function signDirect(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
}

/** Constant-time comparison of a given signature with the right one. */
export function directSignatureMatches(secret: string, timestamp: string, body: string, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signDirect(secret, timestamp, body), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type DirectAuth = "ok" | "missing" | "bad_signature" | "stale";

/** Is this request from somebody who knows the secret, and sent just now? */
export function checkDirectAuth(
  secret: string,
  headers: { timestamp: string | null | undefined; signature: string | null | undefined },
  body: string,
  now: number,
): DirectAuth {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return "missing";
  if (!directSignatureMatches(secret, timestamp, body, signature)) return "bad_signature";
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > DIRECT_CLOCK_SKEW_MS) return "stale";
  return "ok";
}

// ── the request and the reply ────────────────────────────────────────────────

/** An order (or a change) for one account. Only the commands that change something at the broker may use this lane. */
export interface DirectRequest {
  v: typeof DIRECT_LANE_VERSION;
  userId: string;
  accountId: string;
  kind: TradeCommandKind;
  /** the payload of the command; the worker parses it again, as it does for a stored command */
  payload: unknown;
  /** the idempotency key: (userId, clientRequestId) is one order for as long as the worker remembers it */
  clientRequestId: string;
  /** how long the order may wait in the worker before it is NOT sent (the worker's own clock is used) */
  ttlMs: number;
  /** 1 = first try; 2 = the same request again after a dropped connection (the worker then looks for an earlier answer) */
  attempt: 1 | 2;
}

/** What the worker answers. `repeated`: this was a request it had already answered; nothing new was sent. */
export type DirectReply =
  | { ok: true; outcome: TradeCommandOutcome; repeated?: boolean }
  | { ok: false; error: StoredCommandError; repeated?: boolean; notSent?: boolean };

/** The answer as it travels (it names the request it answers, so an answer can not be taken for another's). */
export interface DirectWireReply {
  v: typeof DIRECT_LANE_VERSION;
  clientRequestId: string;
  reply: DirectReply;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A request id the database would also accept (8-64 printable characters). */
export function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 64 && /^[\x21-\x7e]+$/.test(value);
}

/** Checks a request body the worker has received. Nothing in it is trusted beyond its shape. */
export function parseDirectRequest(raw: unknown): { ok: true; request: DirectRequest } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: "The request is not an object." };
  if (raw.v !== DIRECT_LANE_VERSION) return { ok: false, message: "Unknown protocol version." };
  if (typeof raw.userId !== "string" || !UUID.test(raw.userId)) return { ok: false, message: "userId is not valid." };
  if (typeof raw.accountId !== "string" || !UUID.test(raw.accountId)) return { ok: false, message: "accountId is not valid." };
  if (!isTradeCommandKind(raw.kind) || !ORDER_COMMAND_KINDS.has(raw.kind)) {
    return { ok: false, message: "This command can not use the direct lane." };
  }
  if (!validRequestId(raw.clientRequestId)) return { ok: false, message: "clientRequestId is not valid." };
  const ttl = typeof raw.ttlMs === "number" && Number.isFinite(raw.ttlMs) ? raw.ttlMs : DIRECT_ORDER_TTL_MS;
  return {
    ok: true,
    request: {
      v: DIRECT_LANE_VERSION,
      userId: raw.userId,
      accountId: raw.accountId,
      kind: raw.kind,
      payload: raw.payload ?? {},
      clientRequestId: raw.clientRequestId,
      ttlMs: Math.min(DIRECT_TTL_MAX_MS, Math.max(DIRECT_TTL_MIN_MS, Math.round(ttl))),
      attempt: raw.attempt === 2 ? 2 : 1,
    },
  };
}

// ── what the person looking at the panel is told ──────────────────────────────

export interface DirectLaneStatusInput {
  /** the web server has the address and the secret, and the lane is not switched off */
  configured: boolean;
  /** the address starts with https:// */
  secureUrl: boolean;
  /** every online worker's heartbeat says the direct lane is listening */
  workerListening: boolean;
  /** the worker's heartbeat says its port serves HTTPS (absent for a worker that does not report it) */
  workerTls: boolean | undefined;
  /** the lane failed a moment ago and is put aside for a while */
  down: boolean;
  downNote: string;
}

/** How an order travels: straight to the worker ("direct") or through the database ("database"), and why not direct when it was meant to be. */
export interface DirectLaneStatus {
  lane: "direct" | "database";
  /** null = nothing to say (the lane is simply not set up, or it works) */
  note: string | null;
}

/**
 * A mismatch that makes the lane useless before a single order is sent: the worker serves HTTPS on its port but the address
 * says http:// (plain HTTP to a TLS port is closed by the worker without a word). The other way round is NOT a mismatch -
 * a proxy with a certificate of its own in front of a plain worker is a normal set-up.
 */
export function directLaneMismatch(secureUrl: boolean, workerTls: boolean | undefined): string | null {
  if (workerTls === true && !secureUrl) {
    return "The trading system serves HTTPS on its direct port, but WSA_TRADE_DIRECT_URL starts with http:// - change it to https://.";
  }
  return null;
}

export function directLaneStatus(input: DirectLaneStatusInput): DirectLaneStatus {
  if (!input.configured) return { lane: "database", note: null };
  if (!input.workerListening) {
    return {
      lane: "database",
      note: "The trading system on AWS is not listening on its direct port yet: set WSA_TRADE_DIRECT_SECRET on AWS (SSM) and restart the copy worker.",
    };
  }
  const mismatch = directLaneMismatch(input.secureUrl, input.workerTls);
  if (mismatch) return { lane: "database", note: mismatch };
  if (input.down) return { lane: "database", note: `Paused for a moment: ${input.downNote || "the last try did not work"}` };
  return { lane: "direct", note: null };
}

/** An HTTP refusal (the worker's own, or a proxy's) in words that say what to check. */
export function describeDirectHttp(status: number, code: string | undefined): string {
  const base = `HTTP ${status}${code ? ` ${code}` : ""}`;
  if (status === 401) {
    return code === "DIRECT_AUTH_STALE"
      ? `The clocks of the web server and of AWS differ by more than ${DIRECT_CLOCK_SKEW_MS / 1000} s: check the time on the AWS machine (${base})`
      : `The trading system refused the signature: WSA_TRADE_DIRECT_SECRET must be exactly the same on the web server and on AWS (${base})`;
  }
  if (status === 404) {
    return `Nothing at this address answers as the trading system: check the host, the port and the path of WSA_TRADE_DIRECT_URL (${base})`;
  }
  return base;
}

/** A transport error in words that say what to check (the raw text stays at the end for whoever reads the log). */
export function describeDirectFailure(reason: string): string {
  const text = reason.trim() || "unknown error";
  let hint: string | null = null;
  if (/ECONNREFUSED/i.test(text)) {
    hint = "Nothing listens there: check WSA_TRADE_DIRECT_PORT and that the copy worker runs the new code";
  } else if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|could not be opened in time/i.test(text)) {
    hint = "The address cannot be reached: open the port in the AWS security group (inbound TCP, WSA_TRADE_DIRECT_PORT) and check the IP address";
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    hint = "The host name does not resolve: check WSA_TRADE_DIRECT_URL";
  } else if (/wrong version number|packet length too long|http request/i.test(text)) {
    hint = "HTTP and HTTPS are mixed up: the address must start with https:// when the worker serves HTTPS (the default) and with http:// when it runs with WSA_TRADE_DIRECT_TLS=off";
  } else if (/self[- ]signed|unable to verify|certificate|CERT_|ERR_TLS|ssl|tls|handshake|alert/i.test(text)) {
    hint = "The secure connection was refused: WSA_TRADE_DIRECT_SECRET must be exactly the same on the web server and on AWS";
  } else if (/ECONNRESET|socket hang up|closed/i.test(text)) {
    hint = "The other side closed the connection: check http:// against https:// and the port";
  }
  return hint ? `${hint} (${text})` : text;
}

/** The answer read back from the wire; null = it is not an answer to this request. */
export function parseDirectReply(raw: unknown, clientRequestId: string): DirectReply | null {
  if (!isRecord(raw) || raw.v !== DIRECT_LANE_VERSION || raw.clientRequestId !== clientRequestId) return null;
  const reply = raw.reply;
  if (!isRecord(reply)) return null;
  if (reply.ok === true && isRecord(reply.outcome)) {
    return { ok: true, outcome: reply.outcome as TradeCommandOutcome, ...(reply.repeated === true ? { repeated: true } : {}) };
  }
  const error = reply.error;
  if (reply.ok === false && isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        statusCode: typeof error.statusCode === "number" ? error.statusCode : 502,
      },
      ...(reply.repeated === true ? { repeated: true } : {}),
      ...(reply.notSent === true ? { notSent: true } : {}),
    };
  }
  return null;
}
