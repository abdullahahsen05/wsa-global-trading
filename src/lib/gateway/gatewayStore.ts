if (typeof window !== "undefined") {
  throw new Error("[wsa] gatewayStore is server-only.");
}

/**
 * Trade gateway - the worker's side of the database.
 *
 * `GatewayStore` is everything the AWS worker needs from the database, behind an
 * interface so the worker loop can be tested with an in-memory store. The Supabase
 * implementation uses the service role; every command it runs was written by the web
 * tier AFTER its own checks, and the worker re-checks the owner of the account anyway.
 */

import type { BrokerSymbolInfo } from "@/lib/broker/BrokerAdapter";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CLAIM_FUNCTION,
  CLAIM_WAIT_FUNCTION,
  COMMANDS_TABLE,
  GatewayNotInstalledError,
  HEARTBEAT_TABLE,
  isMissingGatewayObject,
  isMissingLongPoll,
  LongPollUnavailableError,
  STATE_TABLE,
  SYMBOLS_TABLE,
  type AdminDb,
  type CommandRow,
} from "./gatewayDb";
import type { GatewayTradingState, StoredCommandError, TradeCommandOutcome } from "./tradeCommands";

/** A command a worker has claimed (status RUNNING, `claimed_by` = the worker). */
export interface ClaimedCommand {
  id: string;
  userId: string;
  accountId: string;
  kind: string;
  payload: unknown;
  clientRequestId: string;
  /** ISO times */
  createdAt: string;
  expiresAt: string;
}

/**
 * The answer to a previously reserved DIRECT LANE (`directLane.ts`) order. Exactly one of `outcome` / `error` is set.
 */
export interface DirectRecord {
  id: string;
  userId: string;
  accountId: string;
  kind: string;
  payload: unknown;
  clientRequestId: string;
  /** ISO times: the request arrived / it would have expired / the worker began / it was answered */
  receivedAt: string;
  expiresAt: string;
  startedAt: string;
  completedAt: string;
  workerId: string;
  outcome?: TradeCommandOutcome;
  error?: StoredCommandError;
  /** The one demo-pilot audit the worker writes after the broker answer. */
  audit?: "AWS_DEMO_OPEN";
}

/** A durable claim made before a direct-lane order may reach the broker. */
export type DirectReservation = Omit<DirectRecord, "completedAt" | "outcome" | "error" | "audit">;

/** The command stored for a (user, request id): enough to answer a repeated request. */
export type StoredCommandRow = Pick<CommandRow, "status" | "result" | "error_code" | "error_message">;

export interface AccountOwner {
  userId: string;
  providerAccountId: string | null;
}

/** An account somebody is looking at right now. */
export interface WatchedAccount {
  accountId: string;
  userId: string;
  symbols: string[];
}

export interface SweepResult {
  expired: number;
  lost: number;
  purged: number;
}

export interface GatewayStore {
  /** Takes up to `limit` pending commands (several workers never get the same one). Throws `GatewayNotInstalledError`. */
  claim(worker: string, limit: number): Promise<ClaimedCommand[]>;
  /**
   * Like `claim`, but when nothing is pending it WAITS inside the database for up to `waitMs` and returns
   * the moment a command arrives (migration 062). Absent in a store that cannot do it. Throws
   * `LongPollUnavailableError` when the database has no such function (the caller then uses `claim`).
   */
  claimWait?(worker: string, limit: number, waitMs: number): Promise<ClaimedCommand[]>;
  /** Who owns the account (null = no such account). */
  owner(accountId: string): Promise<AccountOwner | null>;
  complete(id: string, outcome: TradeCommandOutcome): Promise<void>;
  fail(id: string, error: StoredCommandError): Promise<void>;
  /** Atomically reserve (user, request id) before broker execution. False means it already exists. */
  reserveDirect?(entry: DirectReservation): Promise<boolean>;
  /**
   * Direct lane (write-behind): finishes its pre-execution RUNNING reservation after the broker answers.
   * Absent = the lane does not execute an order.
   */
  recordDirect?(entry: DirectRecord): Promise<void>;
  /** Direct lane: the command stored for this (user, request id), or null. Used when a reservation conflicts. */
  findByRequest?(userId: string, clientRequestId: string): Promise<StoredCommandRow | null>;
  /** Housekeeping: expire what nobody picked up, fail what a dead worker left running, delete old rows. */
  sweep(now: Date): Promise<SweepResult>;
  watched(now: Date): Promise<WatchedAccount[]>;
  /** The live picture of an account (`state` null = keep the last one and record the error). */
  saveState(accountId: string, state: GatewayTradingState | null, error: string | null, now: Date): Promise<void>;
  saveSymbols(accountId: string, symbols: BrokerSymbolInfo[], now: Date): Promise<void>;
  heartbeat(worker: string, startedAt: Date, info: Record<string, unknown>, now: Date): Promise<void>;
  /** The worker stops: it is no longer there for the web. */
  retire(worker: string): Promise<void>;
}

/** A command that was claimed but not finished within this time belongs to a worker that died. */
export const LOST_AFTER_MS = 120_000;
/** Finished commands are kept for this long (the panel's activity list, support). */
export const KEEP_COMMANDS_MS = 3 * 24 * 3600_000;
/** An account nobody has looked at for this long loses its stored picture. */
export const KEEP_STATE_MS = 24 * 3600_000;

const WORKER_LOST_MESSAGE =
  "The trading system restarted while this was running. Check the open positions before sending it again.";
const NOT_SENT_MESSAGE = "The trading system did not pick this up in time, so it was NOT sent to the broker.";

function failOnError(error: { code?: string; message?: string } | null, what: string): void {
  if (!error) return;
  if (isMissingGatewayObject(error)) throw new GatewayNotInstalledError();
  throw new Error(`[trade-gateway] could not ${what}: ${error.message ?? "unknown error"}`);
}

function toClaimed(row: CommandRow): ClaimedCommand {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    kind: row.kind,
    payload: row.payload,
    clientRequestId: row.client_request_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createSupabaseGatewayStore(db: AdminDb = createAdminClient()): GatewayStore {
  return {
    async claim(worker, limit) {
      const { data, error } = await db.rpc(CLAIM_FUNCTION, { p_worker: worker, p_limit: limit });
      failOnError(error, "claim commands");
      return ((data ?? []) as CommandRow[]).map(toClaimed);
    },

    async claimWait(worker, limit, waitMs) {
      const { data, error } = await db.rpc(CLAIM_WAIT_FUNCTION, { p_worker: worker, p_limit: limit, p_wait_ms: waitMs });
      if (error) {
        // only the wait function is missing (062 not applied): the gateway itself is fine
        if (isMissingLongPoll(error)) throw new LongPollUnavailableError("migration 062 is not applied");
        failOnError(error, "claim commands");
      }
      return ((data ?? []) as CommandRow[]).map(toClaimed);
    },

    async owner(accountId) {
      const { data, error } = await db
        .from("trading_accounts")
        .select("user_id, provider_account_id")
        .eq("id", accountId)
        .maybeSingle();
      if (error) throw new Error(`[trade-gateway] could not read the account: ${error.message}`);
      if (!data) return null;
      const row = data as { user_id: string; provider_account_id: string | null };
      return { userId: row.user_id, providerAccountId: row.provider_account_id };
    },

    async complete(id, outcome) {
      const { error } = await db
        .from(COMMANDS_TABLE)
        .update({ status: "DONE", result: outcome, completed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "RUNNING");
      failOnError(error, "store the result of a command");
    },

    async fail(id, error) {
      const { error: dbError } = await db
        .from(COMMANDS_TABLE)
        .update({
          status: "FAILED",
          result: { statusCode: error.statusCode },
          error_code: error.code,
          error_message: error.message.slice(0, 500),
          completed_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "RUNNING");
      failOnError(dbError, "store the failure of a command");
    },

    async reserveDirect(entry) {
      const { error } = await db.from(COMMANDS_TABLE).insert({
        id: entry.id,
        user_id: entry.userId,
        account_id: entry.accountId,
        kind: entry.kind,
        payload: entry.payload ?? {},
        client_request_id: entry.clientRequestId,
        status: "RUNNING",
        created_at: entry.receivedAt,
        expires_at: entry.expiresAt,
        claimed_at: entry.startedAt,
        claimed_by: entry.workerId,
      });
      if (error?.code === "23505") return false;
      failOnError(error, "reserve a direct command");
      return true;
    },

    async recordDirect(entry) {
      const failed = entry.error !== undefined;
      const { error } = await db.from(COMMANDS_TABLE)
        .update({
          status: failed ? "FAILED" : "DONE",
          result: entry.error ? { statusCode: entry.error.statusCode } : (entry.outcome ?? {}),
          error_code: entry.error ? entry.error.code : null,
          error_message: entry.error ? entry.error.message.slice(0, 500) : null,
          completed_at: entry.completedAt,
        })
        .eq("id", entry.id)
        .eq("status", "RUNNING");
      failOnError(error, "record a direct command");
      if (entry.audit === "AWS_DEMO_OPEN" && !failed && entry.kind === "OPEN") {
        const payload = entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
          ? entry.payload as Record<string, unknown>
          : {};
        // The command id is also the audit id: a retry after an ambiguous DB answer
        // cannot create a second log entry. This runs in the worker's tracked,
        // retrying write-behind task rather than delaying the broker reply.
        const { error: auditError } = await db.from("audit_logs").insert({
          id: entry.id,
          actor_user_id: entry.userId,
          action: "WEB_TRADE_ORDER_OPENED",
          entity_type: "trading_account",
          entity_id: entry.accountId,
          metadata: {
            symbol: payload.symbol ?? null,
            side: payload.side ?? null,
            volume: payload.volume ?? null,
            orderKind: payload.orderKind ?? "MARKET",
            price: payload.price ?? null,
            stopLoss: payload.stopLoss ?? null,
            takeProfit: payload.takeProfit ?? null,
            ticket: entry.outcome?.ticket ?? null,
            route: "aws-demo-direct",
            clientRequestId: entry.clientRequestId,
          },
        });
        if (auditError?.code !== "23505") failOnError(auditError, "audit a direct demo order");
      }
    },

    async findByRequest(userId, clientRequestId) {
      const { data, error } = await db
        .from(COMMANDS_TABLE)
        .select("status, result, error_code, error_message")
        .eq("user_id", userId)
        .eq("client_request_id", clientRequestId)
        .maybeSingle();
      failOnError(error, "look up a command");
      return (data as StoredCommandRow | null) ?? null;
    },

    async sweep(now) {
      const iso = now.toISOString();
      const expired = await db
        .from(COMMANDS_TABLE)
        .update({
          status: "EXPIRED",
          result: { statusCode: 504 },
          error_code: "NOT_SENT",
          error_message: NOT_SENT_MESSAGE,
          completed_at: iso,
        })
        .eq("status", "PENDING")
        .lt("expires_at", iso)
        .select("id");
      failOnError(expired.error, "expire commands");

      const lost = await db
        .from(COMMANDS_TABLE)
        .update({
          status: "FAILED",
          result: { statusCode: 504 },
          error_code: "WORKER_LOST",
          error_message: WORKER_LOST_MESSAGE,
          completed_at: iso,
        })
        .eq("status", "RUNNING")
        .lt("claimed_at", new Date(now.getTime() - LOST_AFTER_MS).toISOString())
        .select("id");
      failOnError(lost.error, "close commands of a lost worker");

      const purged = await db
        .from(COMMANDS_TABLE)
        .delete()
        .in("status", ["DONE", "FAILED", "EXPIRED"])
        .lt("completed_at", new Date(now.getTime() - KEEP_COMMANDS_MS).toISOString())
        .select("id");
      failOnError(purged.error, "delete old commands");

      const states = await db
        .from(STATE_TABLE)
        .delete()
        .lt("watch_until", new Date(now.getTime() - KEEP_STATE_MS).toISOString())
        .select("account_id");
      failOnError(states.error, "delete old account pictures");

      // a worker that crashed leaves its heartbeat row behind (the id contains the process number)
      const beats = await db
        .from(HEARTBEAT_TABLE)
        .delete()
        .lt("updated_at", new Date(now.getTime() - KEEP_STATE_MS).toISOString())
        .select("worker");
      failOnError(beats.error, "delete old heartbeats");

      return {
        expired: expired.data?.length ?? 0,
        lost: lost.data?.length ?? 0,
        purged: (purged.data?.length ?? 0) + (states.data?.length ?? 0) + (beats.data?.length ?? 0),
      };
    },

    async watched(now) {
      const { data, error } = await db
        .from(STATE_TABLE)
        .select("account_id, user_id, watch_symbols")
        .gt("watch_until", now.toISOString())
        .limit(200);
      failOnError(error, "list the watched accounts");
      return ((data ?? []) as Array<{ account_id: string; user_id: string; watch_symbols: unknown }>).map((row) => ({
        accountId: row.account_id,
        userId: row.user_id,
        symbols: Array.isArray(row.watch_symbols)
          ? row.watch_symbols.filter((entry): entry is string => typeof entry === "string")
          : [],
      }));
    },

    async saveState(accountId, state, error, now) {
      const iso = now.toISOString();
      const patch = state
        ? { state, state_at: iso, error: null, error_at: null, updated_at: iso }
        : { error: error ? error.slice(0, 500) : "The account could not be read.", error_at: iso, updated_at: iso };
      const { error: dbError } = await db.from(STATE_TABLE).update(patch).eq("account_id", accountId);
      failOnError(dbError, "store the picture of an account");
    },

    async saveSymbols(accountId, symbols, now) {
      const { error } = await db
        .from(SYMBOLS_TABLE)
        .upsert({ account_id: accountId, symbols, updated_at: now.toISOString() }, { onConflict: "account_id" });
      failOnError(error, "store the symbols of an account");
    },

    async heartbeat(worker, startedAt, info, now) {
      const { error } = await db.from(HEARTBEAT_TABLE).upsert(
        {
          worker,
          role: "trade-gateway",
          started_at: startedAt.toISOString(),
          updated_at: now.toISOString(),
          info,
        },
        { onConflict: "worker" },
      );
      failOnError(error, "write the heartbeat");
    },

    async retire(worker) {
      const { error } = await db.from(HEARTBEAT_TABLE).delete().eq("worker", worker);
      failOnError(error, "remove the heartbeat");
    },
  };
}
