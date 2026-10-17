/**
 * Trade gateway - the web tier's side of the database.
 *
 * What the order panel's routes use to hand work to the AWS system: is anybody there
 * (heartbeat), write a command, wait for its answer, and - for the live picture of an
 * account - say "somebody is looking" and read what the worker published.
 *
 * Every function takes the database client, so tests can pass a fake one. Without
 * migration 060 the first call that meets a missing table throws
 * `GatewayNotInstalledError` and remembers it (gatewayDb.ts); the service then falls
 * back to the direct route. No Next / React imports.
 */

import type { BrokerSymbolInfo } from "@/lib/broker/BrokerAdapter";
import {
  COMMANDS_TABLE,
  gatewayKnownMissing,
  GatewayNotInstalledError,
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_TABLE,
  isMissingGatewayObject,
  markGatewayMissing,
  STATE_TABLE,
  SYMBOLS_TABLE,
  WATCH_MS,
  WATCH_RENEW_BELOW_MS,
  type AdminDb,
  type CommandRow,
  type CommandStatus,
} from "./gatewayDb";
import {
  MAX_WATCHED_SYMBOLS,
  type GatewayTradingState,
  type StoredCommandError,
  type TradeCommandKind,
  type TradeCommandOutcome,
} from "./tradeCommands";

// ── is anybody there? ────────────────────────────────────────────────────────

export type GatewayAvailability =
  | { state: "online"; workers: number; executionEnabled: boolean }
  /** the tables exist, but no worker has written a heartbeat lately */
  | { state: "offline" }
  /** migration 060 is not applied */
  | { state: "not_installed" };

const AVAILABILITY_TTL_MS = 2_000;
let availabilityCache: { at: number; value: GatewayAvailability; db: AdminDb } | null = null;

/** Test helper. */
export function resetGatewayAvailability(): void {
  availabilityCache = null;
}

/** Reads the heartbeat table (kept for two seconds, so a busy panel does not ask on every poll). */
export async function gatewayAvailability(db: AdminDb, now: number = Date.now()): Promise<GatewayAvailability> {
  if (gatewayKnownMissing(now)) return { state: "not_installed" };
  if (availabilityCache && availabilityCache.db === db && now - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.value;
  }
  const since = new Date(now - HEARTBEAT_FRESH_MS).toISOString();
  const { data, error } = await db.from(HEARTBEAT_TABLE).select("worker, info").gte("updated_at", since).limit(10);
  let value: GatewayAvailability;
  if (error) {
    if (isMissingGatewayObject(error)) {
      markGatewayMissing(now);
      return { state: "not_installed" };
    }
    // The database could not be asked: treat the gateway as not there for this moment.
    value = { state: "offline" };
  } else {
    const rows = (data ?? []) as Array<{ worker: string; info: { executionAvailable?: unknown } | null }>;
    value =
      rows.length === 0
        ? { state: "offline" }
        : {
            state: "online",
            workers: rows.length,
            // an older worker that does not report the switch is taken as enabled (it refuses to start otherwise)
            executionEnabled: rows.some((row) => row.info?.executionAvailable !== false),
          };
  }
  availabilityCache = { at: now, value, db };
  return value;
}

// ── commands ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  userId: string;
  accountId: string;
  kind: TradeCommandKind;
  payload: unknown;
  clientRequestId: string;
  /** how long the command may wait for a worker; after that it is never sent (default: the database's 90 s) */
  ttlMs?: number;
}

const RESULT_COLUMNS = "id, status, result, error_code, error_message, created_at, completed_at";

function isFinished(status: CommandStatus): boolean {
  return status === "DONE" || status === "FAILED" || status === "EXPIRED";
}

/**
 * Writes a command. The same (user, clientRequestId) is one command: a repeated request -
 * a double click, a retry after a dropped answer - gets the command that already exists
 * (`existing: true`) instead of a second one.
 */
export async function enqueueCommand(
  db: AdminDb,
  input: EnqueueInput,
  now: number = Date.now(),
): Promise<{ row: CommandRow; existing: boolean }> {
  const insert: Record<string, unknown> = {
    user_id: input.userId,
    account_id: input.accountId,
    kind: input.kind,
    payload: input.payload,
    client_request_id: input.clientRequestId,
  };
  if (input.ttlMs !== undefined) insert.expires_at = new Date(now + input.ttlMs).toISOString();

  const { data, error } = await db.from(COMMANDS_TABLE).insert(insert).select(RESULT_COLUMNS).single();
  if (!error && data) return { row: data as CommandRow, existing: false };
  if (isMissingGatewayObject(error)) {
    markGatewayMissing(now);
    throw new GatewayNotInstalledError();
  }
  if (error?.code === "23505") {
    const earlier = await db
      .from(COMMANDS_TABLE)
      .select(RESULT_COLUMNS)
      .eq("user_id", input.userId)
      .eq("client_request_id", input.clientRequestId)
      .maybeSingle();
    if (earlier.data) return { row: earlier.data as CommandRow, existing: true };
  }
  throw new Error(`[trade-gateway] could not queue the command: ${error?.message ?? "unknown error"}`);
}

/** How long to wait before the 1st, 2nd ... look at a command; the last value repeats. */
export const POLL_DELAYS_MS = [100, 70, 70, 90, 110, 140, 180, 240, 300];

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The finished command (DONE / FAILED / EXPIRED), or null when it was not finished within `timeoutMs`. */
export async function waitForCommand(
  db: AdminDb,
  id: string,
  timeoutMs: number,
  deps: WaitDeps = {},
): Promise<CommandRow | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? pause;
  const deadline = now() + timeoutMs;
  for (let look = 0; ; look += 1) {
    const wanted = POLL_DELAYS_MS[Math.min(look, POLL_DELAYS_MS.length - 1)];
    await sleep(Math.max(0, Math.min(wanted, deadline - now())));
    const { data, error } = await db.from(COMMANDS_TABLE).select(RESULT_COLUMNS).eq("id", id).maybeSingle();
    if (error) {
      if (isMissingGatewayObject(error)) {
        markGatewayMissing(now());
        throw new GatewayNotInstalledError();
      }
      // a failed look is not an answer - the next one may work
    } else if (data && isFinished((data as CommandRow).status)) {
      return data as CommandRow;
    }
    if (now() >= deadline) return null;
  }
}

/**
 * The caller stops waiting. A command nobody has picked up yet is closed so it can never
 * run later (the person was told it did not go through): "CANCELLED". One a worker already
 * took is "RUNNING" (it may be executing right now - the person must check the positions),
 * and "FINISHED" means it completed just now.
 */
export async function abandonCommand(db: AdminDb, id: string, now: number = Date.now()): Promise<"CANCELLED" | "RUNNING" | "FINISHED"> {
  const closed = await db
    .from(COMMANDS_TABLE)
    .update({
      status: "EXPIRED",
      result: { statusCode: 504 },
      error_code: "NOT_SENT",
      error_message: "The trading system did not pick this up in time, so it was NOT sent to the broker.",
      completed_at: new Date(now).toISOString(),
    })
    .eq("id", id)
    .eq("status", "PENDING")
    .select("id");
  if (!closed.error && closed.data && closed.data.length > 0) return "CANCELLED";
  const current = await db.from(COMMANDS_TABLE).select("status").eq("id", id).maybeSingle();
  const status = (current.data as { status?: CommandStatus } | null)?.status;
  return status === "RUNNING" || status === "PENDING" ? "RUNNING" : "FINISHED";
}

export type CommandAnswer =
  | { ok: true; outcome: TradeCommandOutcome }
  | { ok: false; error: StoredCommandError };

/** A finished command row as an answer. */
export function commandAnswer(row: Pick<CommandRow, "status" | "result" | "error_code" | "error_message">): CommandAnswer {
  if (row.status === "DONE") {
    const outcome = row.result && typeof row.result === "object" ? (row.result as TradeCommandOutcome) : {};
    return { ok: true, outcome };
  }
  const statusCode = (row.result as { statusCode?: unknown } | null)?.statusCode;
  return {
    ok: false,
    error: {
      code: row.error_code ?? (row.status === "EXPIRED" ? "NOT_SENT" : "COMMAND_FAILED"),
      message: row.error_message ?? "The command did not go through.",
      statusCode: typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : 502,
    },
  };
}

// ── the live picture of an account ───────────────────────────────────────────

export interface WatchRow {
  state: GatewayTradingState | null;
  /** ISO time the worker published `state` */
  stateAt: string | null;
  /** why the worker could not read the account at its last try */
  error: string | null;
  /** ISO time of that try */
  errorAt: string | null;
  watchUntil: string | null;
  watchSymbols: string[];
}

/** The picture the worker published for one of the user's accounts (null = nobody has watched it yet). */
export async function readAccountWatch(db: AdminDb, accountId: string, userId: string): Promise<WatchRow | null> {
  const { data, error } = await db
    .from(STATE_TABLE)
    .select("state, state_at, error, error_at, watch_until, watch_symbols")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingGatewayObject(error)) {
      markGatewayMissing();
      throw new GatewayNotInstalledError();
    }
    throw new Error(`[trade-gateway] could not read the account picture: ${error.message}`);
  }
  if (!data) return null;
  const row = data as {
    state: GatewayTradingState | null;
    state_at: string | null;
    error: string | null;
    error_at: string | null;
    watch_until: string | null;
    watch_symbols: unknown;
  };
  return {
    state: row.state && typeof row.state === "object" ? row.state : null,
    stateAt: row.state_at,
    error: row.error,
    errorAt: row.error_at,
    watchUntil: row.watch_until,
    watchSymbols: Array.isArray(row.watch_symbols)
      ? row.watch_symbols.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

/**
 * The symbols whose price the worker reads: the one on screen first, then the most recent
 * others, at most `MAX_WATCHED_SYMBOLS`. A watch that had lapsed starts again from the one symbol.
 */
export function mergeWatchSymbols(symbol: string | null, current: readonly string[], stillWatched: boolean): string[] {
  const merged: string[] = [];
  if (symbol) merged.push(symbol);
  if (stillWatched) {
    for (const entry of current) {
      if (merged.length >= MAX_WATCHED_SYMBOLS) break;
      if (!merged.includes(entry)) merged.push(entry);
    }
  }
  return merged.slice(0, MAX_WATCHED_SYMBOLS);
}

/**
 * Says "somebody is looking at this account": the worker refreshes the picture while
 * `watch_until` is in the future. Written only when the watch is about to lapse or the
 * symbol changed, so a panel that polls every two seconds writes about every twenty.
 */
export async function keepWatching(
  db: AdminDb,
  input: { accountId: string; userId: string; symbol: string | null; current: WatchRow | null },
  now: number = Date.now(),
): Promise<void> {
  const until = input.current?.watchUntil ? Date.parse(input.current.watchUntil) : 0;
  const stillWatched = Number.isFinite(until) && until > now;
  const currentSymbols = input.current?.watchSymbols ?? [];
  const symbols = mergeWatchSymbols(input.symbol, currentSymbols, stillWatched);
  // Not "same list": a symbol that is already in the list needs no write while the watch is long enough.
  const covered = input.symbol === null || currentSymbols.includes(input.symbol);
  if (stillWatched && until - now > WATCH_RENEW_BELOW_MS && covered) return;

  const iso = new Date(now).toISOString();
  const { error } = await db.from(STATE_TABLE).upsert(
    {
      account_id: input.accountId,
      user_id: input.userId,
      watch_until: new Date(now + WATCH_MS).toISOString(),
      watch_symbols: stillWatched && covered ? currentSymbols : symbols,
      updated_at: iso,
    },
    { onConflict: "account_id" },
  );
  if (error) {
    if (isMissingGatewayObject(error)) {
      markGatewayMissing(now);
      throw new GatewayNotInstalledError();
    }
    throw new Error(`[trade-gateway] could not register the watch: ${error.message}`);
  }
}

/** The symbols the worker stored for an account (null = never read). */
export async function readStoredSymbols(
  db: AdminDb,
  accountId: string,
): Promise<{ symbols: BrokerSymbolInfo[]; updatedAt: string } | null> {
  const { data, error } = await db
    .from(SYMBOLS_TABLE)
    .select("symbols, updated_at")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    if (isMissingGatewayObject(error)) {
      markGatewayMissing();
      throw new GatewayNotInstalledError();
    }
    throw new Error(`[trade-gateway] could not read the symbols: ${error.message}`);
  }
  if (!data) return null;
  const row = data as { symbols: unknown; updated_at: string };
  return {
    symbols: Array.isArray(row.symbols) ? (row.symbols as BrokerSymbolInfo[]) : [],
    updatedAt: row.updated_at,
  };
}
