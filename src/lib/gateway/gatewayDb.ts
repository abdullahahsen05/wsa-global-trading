/**
 * Trade gateway - shared database vocabulary (migration 060, OPTIONAL).
 *
 * The four tables, the shape of a stored command, and the one place that remembers
 * "the migration is not applied here": the first call that meets a missing table
 * marks the gateway as not installed for ten minutes, so the order panel falls back
 * to the direct route (or says it is read-only) without asking the database again on
 * every click. Shared by the web app and the AWS worker (no Next / React imports).
 */

import type { createAdminClient } from "@/lib/supabase/admin";

export type AdminDb = ReturnType<typeof createAdminClient>;

export const COMMANDS_TABLE = "trade_commands";
export const STATE_TABLE = "terminal_account_state";
export const SYMBOLS_TABLE = "terminal_account_symbols";
export const HEARTBEAT_TABLE = "gateway_heartbeat";
export const CLAIM_FUNCTION = "claim_trade_commands";

export type CommandStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "EXPIRED";

/** A row of `trade_commands` as the database returns it. */
export interface CommandRow {
  id: string;
  user_id: string;
  account_id: string;
  kind: string;
  payload: unknown;
  client_request_id: string;
  status: CommandStatus;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
}

/** How long a panel keeps an account "watched" after its last poll, and when a poll renews it. */
export const WATCH_MS = 45_000;
export const WATCH_RENEW_BELOW_MS = 25_000;
/** A worker that has not written its heartbeat for this long is gone. */
export const HEARTBEAT_FRESH_MS = 20_000;

/** The migration (tables or the claim function) is not applied on this database. */
export class GatewayNotInstalledError extends Error {
  constructor() {
    super("The trade gateway tables are not installed (migration 060).");
    this.name = "GatewayNotInstalledError";
  }
}

export function isMissingGatewayObject(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  // 42P01 / PGRST205: table missing; 42883 / PGRST202: function missing
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "42883" || error.code === "PGRST202") {
    return true;
  }
  return /could not find the (table|function)|relation .* does not exist|function .* does not exist/i.test(
    error.message ?? "",
  );
}

const RECHECK_MS = 10 * 60_000;
let notInstalledUntil = 0;

/** True while the gateway is known to be missing on this database (asked again after ten minutes). */
export function gatewayKnownMissing(now: number = Date.now()): boolean {
  return now < notInstalledUntil;
}

export function markGatewayMissing(now: number = Date.now()): void {
  notInstalledUntil = now + RECHECK_MS;
}

/** Test helper: forget what was learned about the database. */
export function resetGatewayState(): void {
  notInstalledUntil = 0;
}
