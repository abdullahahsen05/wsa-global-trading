if (typeof window !== "undefined") {
  throw new Error("[wsa] webTradePass is server-only.");
}

/**
 * The ORDER PASS: what makes the first order after a quiet moment as fast as the tenth.
 *
 * Every WSA Trade order route is its own serverless function with its own memory. Whatever the sign-in check, the
 * account lookup, the subscription check and the risk verdict kept in memory is only kept in the instance that did the
 * check - an order that lands on another (or a cold) instance pays for all of it from scratch: half a second to a second
 * on a database that is a few hundred milliseconds away.
 *
 * The state poll (once a second, from the open panel) already does exactly those checks. It now also hands the panel a
 * small SIGNED note of it - the pass - and the panel sends it back with the order (`x-wsa-pass`):
 *
 *   { user, role, account, token, until, riskUntil?, aws: { ... } }   signed with HMAC-SHA256
 *
 * The order route verifies the signature (microseconds, no network) and, if the pass is for THIS session token and THIS
 * account and has not run out, takes the sign-in, the subscription, the account and the route as already checked. Nothing
 * is relaxed beyond "a few seconds old":
 *
 *  - the pass lives `ORDER_PASS_LIFE_MS` (8 s) and never longer than the session token itself - the same exposure as the
 *    sign-in hold that WSA Trade already has (a suspension or a role change reaches an order up to a few seconds later);
 *  - it is bound to the SHA-256 of the session token: another session, a stolen pass without the cookie, or a pass for
 *    another account is worth nothing;
 *  - the "risk rules do not block new orders" part is trusted for only `ORDER_PASS_RISK_LIFE_MS` (3 s); an OPEN after
 *    that asks the risk service itself. Closing and modifying are never blocked by risk;
 *  - it is only ever minted for a verified, subscribed (or admin) caller of an account that is theirs and reachable, so
 *    a refusal is never turned into a pass, and nothing a pass says can be used to read data;
 *  - the AWS worker still checks that the account belongs to the user before it runs anything.
 *
 * The key comes from `WSA_ORDER_PASS_SECRET` or, failing that, the server's Supabase service key (a derived key, the
 * secret itself never leaves the server). With neither, no pass is minted or accepted and every order is checked the
 * long way - nothing breaks.
 *
 * Nothing in a pass is a credential. This file reads no environment value other than the key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseUserRole, type UserRole } from "@/lib/auth/rbac";
import { currentTokenFacts, requireTrader, type SessionUser } from "@/lib/auth/session";
import { WEB_TRADE_PASS_HEADER } from "@/lib/trade/webTrade";

/** Who is ordering: all an order needs to know about the person (the pass carries it, a full sign-in is not needed). */
export type OrderUser = Pick<SessionUser, "id" | "role">;

/** How long the sign-in, subscription, account and route are taken as checked. */
export const ORDER_PASS_LIFE_MS = 8_000;
/** How long "no risk rule blocks new orders" is taken as checked. */
export const ORDER_PASS_RISK_LIFE_MS = 3_000;
const PASS_VERSION = 1;
const MAX_PASS_CHARS = 2_048;

/** What the AWS system reported about itself when the pass was made (it goes into the order's time report). */
export interface OrderPassAws {
  /** the worker's own round trip to the database, ms */
  dbMs?: number;
  /** how late its event loop ran, ms */
  loopMs?: number;
  /** it waits for commands inside the database (migration 062) */
  longPoll: boolean;
  /** its direct lane is listening */
  direct: boolean;
}

export interface OrderPassClaims {
  v: typeof PASS_VERSION;
  user: string;
  role: UserRole;
  account: string;
  /** key of the session token the pass was made for (`currentTokenFacts().key`) */
  token: string;
  /** the sign-in, the subscription, the account and the route are taken as checked until then (epoch ms) */
  until: number;
  /** "no risk rule blocks new orders" is taken as checked until then (epoch ms); absent = ask */
  riskUntil?: number;
  aws: OrderPassAws;
}

function passKey(): Buffer | null {
  const secret = process.env.WSA_ORDER_PASS_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret || secret.length < 16) return null;
  return createHmac("sha256", secret).update("wsa-order-pass-v1").digest();
}

function signature(key: Buffer, body: string): Buffer {
  return createHmac("sha256", key).update(body).digest();
}

export interface OrderPassInput {
  user: OrderUser;
  accountId: string;
  /** `currentTokenFacts().key` of the request that was just verified */
  tokenKey: string;
  /** the session token's own expiry (epoch ms), if it has one: the pass never outlives it */
  tokenExpiresAtMs: number | null;
  /** when the risk verdict ("not blocked") was READ - not when the pass is made; null = the verdict is not "clear" */
  riskReadAt: number | null;
  aws: OrderPassAws;
}

/** Signs a pass, or returns null when there is no key or the session ends too soon to be worth one. */
export function mintOrderPass(input: OrderPassInput, now: number = Date.now()): string | null {
  const key = passKey();
  if (!key) return null;
  const until = Math.min(now + ORDER_PASS_LIFE_MS, input.tokenExpiresAtMs ?? Number.POSITIVE_INFINITY);
  if (until - now < 1_000) return null;
  const claims: OrderPassClaims = {
    v: PASS_VERSION,
    user: input.user.id,
    role: input.user.role,
    account: input.accountId,
    token: input.tokenKey,
    until,
    ...(input.riskReadAt !== null ? { riskUntil: Math.min(until, input.riskReadAt + ORDER_PASS_RISK_LIFE_MS) } : {}),
    aws: input.aws,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${signature(key, body).toString("base64url")}`;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The claims of a pass if (and only if) its signature is right, it has not run out and it was made for this session
 * token. Anything else - no header, a damaged or foreign pass - is null.
 */
export function readOrderPass(
  value: string | null | undefined,
  expect: { tokenKey: string },
  now: number = Date.now(),
): OrderPassClaims | null {
  if (!value || value.length > MAX_PASS_CHARS) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return null;
  const key = passKey();
  if (!key) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = signature(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  const role = parseUserRole(raw.role);
  const aws = raw.aws as Record<string, unknown> | null | undefined;
  if (
    raw.v !== PASS_VERSION ||
    !role ||
    typeof raw.user !== "string" ||
    typeof raw.account !== "string" ||
    typeof raw.token !== "string" ||
    typeof raw.until !== "number" ||
    !Number.isFinite(raw.until) ||
    !aws ||
    typeof aws !== "object"
  ) {
    return null;
  }
  if (raw.token !== expect.tokenKey || raw.until <= now) return null;
  const dbMs = finiteOrUndefined(aws.dbMs);
  const loopMs = finiteOrUndefined(aws.loopMs);
  return {
    v: PASS_VERSION,
    user: raw.user,
    role,
    account: raw.account,
    token: raw.token,
    until: raw.until,
    ...(typeof raw.riskUntil === "number" && Number.isFinite(raw.riskUntil) ? { riskUntil: raw.riskUntil } : {}),
    aws: {
      ...(dbMs !== undefined ? { dbMs } : {}),
      ...(loopMs !== undefined ? { loopMs } : {}),
      longPoll: aws.longPoll === true,
      direct: aws.direct === true,
    },
  };
}

/** Who is ordering, and the pass that vouches for them (null = the long way was taken). */
export interface OrderSignIn {
  user: OrderUser;
  pass: OrderPassClaims | null;
  /** `Date.now()` when the sign-in was settled */
  at: number;
}

/**
 * The sign-in of an order route. With a valid pass for this very session token it is read from the pass - no network at
 * all; otherwise it is the cheap cached check (`requireTrader({ cached: true })`), exactly as before.
 */
export async function signInForOrder(request: Request): Promise<OrderSignIn> {
  const facts = await currentTokenFacts();
  if (facts) {
    const pass = readOrderPass(request.headers.get(WEB_TRADE_PASS_HEADER), { tokenKey: facts.key });
    // (the token's own claim and the pass must name the same person)
    if (pass && facts.sub === pass.user) {
      return { user: { id: pass.user, role: pass.role }, pass, at: Date.now() };
    }
  }
  const user = await requireTrader({ cached: true });
  return { user, pass: null, at: Date.now() };
}
