if (typeof window !== "undefined") {
  throw new Error("[aurix] metaTraderTerminalService is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto/brokerCrypto";
import type { AccountStatus } from "@/lib/domain/types";
import {
  maskLogin,
  normalizePlatform,
  resolveTerminalPlatform,
  sanitizeLogin,
  sanitizeServer,
  type MetaTraderLaunchTarget,
  type MetaTraderPlatform,
  type MetaTraderTerminalAccount,
  type TerminalAccountUnavailableReason,
} from "@/lib/terminal/metatrader";

export type {
  MetaTraderLaunchTarget,
  MetaTraderTerminalAccount,
  TerminalAccountUnavailableReason,
} from "@/lib/terminal/metatrader";

// ─────────────────────────────────────────────────────────────────────────────
// MetaTrader web terminal: which of the caller's accounts can be opened.
//
// The MT login / server of a platform account live only inside
// broker_credentials.encrypted_reference (AES-256-GCM, with the password). This
// service decrypts that payload on the server, keeps the PASSWORD out of every
// result and returns just what the web terminal's sign-in form can be pre-filled
// with. Rules:
//  - always filtered by the caller's own user id (admins included): the terminal
//    shows the caller's accounts, never someone else's;
//  - the list only carries a masked login; the full login is returned by
//    `resolveMetaTraderLaunch`, one account at a time, when the user opens it;
//  - nothing secret is logged or placed in an error message.
// ─────────────────────────────────────────────────────────────────────────────

export type MetaTraderTerminalErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "CREDENTIALS_MISSING"
  | "CREDENTIALS_UNREADABLE"
  | "ENCRYPTION_UNAVAILABLE"
  | "CREDENTIALS_INCOMPLETE";

export class MetaTraderTerminalError extends Error {
  constructor(
    public readonly code: MetaTraderTerminalErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "MetaTraderTerminalError";
  }
}

interface AccountRow {
  id: string;
  account_name: string | null;
  broker_name: string | null;
  broker_server: string | null;
  broker_platform: string | null;
  currency: string | null;
  status: string | null;
}

interface Identity {
  login: string | null;
  server: string | null;
  platform: MetaTraderPlatform | null;
}

const ACCOUNT_COLUMNS = "id, account_name, broker_name, broker_server, broker_platform, currency, status";

class DecryptError extends Error {
  constructor(public readonly encryptionUnavailable: boolean) {
    super(encryptionUnavailable ? "Encryption is not configured." : "Credentials could not be read.");
  }
}

/** Login / server / platform out of the encrypted payload. The password is dropped here. */
function readIdentity(encryptedReference: string): Identity {
  let parsed: { login?: unknown; server?: unknown; platform?: unknown };
  try {
    parsed = JSON.parse(decryptSecret(encryptedReference)) as typeof parsed;
  } catch (error) {
    // Neither the ciphertext nor any plaintext may end up in the message.
    throw new DecryptError(error instanceof Error && error.message.includes("ENCRYPTION_KEY"));
  }
  return {
    login: sanitizeLogin(parsed.login),
    server: sanitizeServer(parsed.server),
    platform: normalizePlatform(parsed.platform),
  };
}

function statusOf(value: string | null): AccountStatus {
  switch (value) {
    case "PENDING":
    case "CONNECTED":
    case "SYNCING":
    case "DISCONNECTED":
    case "RESTRICTED":
    case "INACTIVE":
      return value;
    default:
      return "PENDING";
  }
}

function toTerminalAccount(
  row: AccountRow,
  identity: Identity | null,
  reason: TerminalAccountUnavailableReason | null,
): MetaTraderTerminalAccount {
  const server = identity?.server ?? sanitizeServer(row.broker_server);
  // The platform saved with the account decides; a server name that announces MT4 / MT5 fills the gap.
  const platform = resolveTerminalPlatform(identity?.platform ?? row.broker_platform, server);
  const base: MetaTraderTerminalAccount = {
    accountId: row.id,
    accountName: row.account_name?.trim() || "Trading account",
    brokerName: row.broker_name?.trim() || "WSA GLOBAL",
    platform,
    server,
    loginMasked: identity?.login ? maskLogin(identity.login) : null,
    currency: row.currency?.trim() || "USD",
    status: statusOf(row.status),
    canLaunch: false,
    unavailableReason: reason,
  };
  if (reason) return base;
  if (!identity?.login || !platform) return { ...base, unavailableReason: "INCOMPLETE" as const };
  return { ...base, canLaunch: true };
}

const STATUS_ORDER: Record<AccountStatus, number> = {
  CONNECTED: 0,
  SYNCING: 1,
  RESTRICTED: 2,
  PENDING: 3,
  INACTIVE: 4,
  DISCONNECTED: 5,
};

/** The caller's own accounts, with a masked login, for the web terminal's account picker. */
export async function listMetaTraderTerminalAccounts(userId: string): Promise<MetaTraderTerminalAccount[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("trading_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to list terminal accounts: ${error.message}`);

  const rows = (data ?? []) as AccountRow[];
  if (rows.length === 0) return [];

  const { data: credentials, error: credentialError } = await db
    .from("broker_credentials")
    .select("trading_account_id, encrypted_reference")
    .in(
      "trading_account_id",
      rows.map((row) => row.id),
    );
  if (credentialError) throw new Error(`Failed to read account logins: ${credentialError.message}`);

  const encrypted = new Map<string, string>();
  for (const credential of (credentials ?? []) as Array<{ trading_account_id: string; encrypted_reference: string }>) {
    encrypted.set(credential.trading_account_id, credential.encrypted_reference);
  }

  const accounts = rows.map((row) => {
    const reference = encrypted.get(row.id);
    if (!reference) return toTerminalAccount(row, null, "NO_CREDENTIALS");
    try {
      return toTerminalAccount(row, readIdentity(reference), null);
    } catch (error) {
      const unavailable = error instanceof DecryptError && error.encryptionUnavailable;
      return toTerminalAccount(row, null, unavailable ? "ENCRYPTION_UNAVAILABLE" : "UNREADABLE");
    }
  });

  // stable sort: live accounts first, newest first inside a group
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => STATUS_ORDER[left.account.status] - STATUS_ORDER[right.account.status] || left.index - right.index)
    .map((entry) => entry.account);
}

/**
 * What the web terminal needs to pre-fill its sign-in form for ONE of the
 * caller's accounts: login, server, platform. Never the password.
 */
export async function resolveMetaTraderLaunch(userId: string, accountId: string): Promise<MetaTraderLaunchTarget> {
  const db = createAdminClient();
  const { data: account, error } = await db
    .from("trading_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read the account: ${error.message}`);
  // someone else's account looks exactly like a missing one
  if (!account) throw new MetaTraderTerminalError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
  const row = account as AccountRow;

  const { data: credential, error: credentialError } = await db
    .from("broker_credentials")
    .select("encrypted_reference")
    .eq("trading_account_id", accountId)
    .maybeSingle();
  if (credentialError) throw new Error(`Failed to read the account login: ${credentialError.message}`);
  if (!credential) {
    throw new MetaTraderTerminalError(
      "CREDENTIALS_MISSING",
      "No MetaTrader login is stored for this account yet. Connect it on the Accounts page first.",
      409,
    );
  }

  let identity: Identity;
  try {
    identity = readIdentity((credential as { encrypted_reference: string }).encrypted_reference);
  } catch (decryptError) {
    if (decryptError instanceof DecryptError && decryptError.encryptionUnavailable) {
      throw new MetaTraderTerminalError(
        "ENCRYPTION_UNAVAILABLE",
        "Encryption is not configured on this server.",
        503,
      );
    }
    throw new MetaTraderTerminalError(
      "CREDENTIALS_UNREADABLE",
      "The stored login could not be read. Re-enter it on the Accounts page.",
      500,
    );
  }

  const server = identity.server ?? sanitizeServer(row.broker_server);
  const platform = resolveTerminalPlatform(identity.platform ?? row.broker_platform, server);
  if (!identity.login || !platform) {
    throw new MetaTraderTerminalError(
      "CREDENTIALS_INCOMPLETE",
      "The stored login is incomplete. Re-enter it on the Accounts page.",
      422,
    );
  }

  return {
    accountId: row.id,
    accountName: row.account_name?.trim() || "Trading account",
    brokerName: row.broker_name?.trim() || "WSA GLOBAL",
    platform,
    server,
    login: identity.login,
  };
}
