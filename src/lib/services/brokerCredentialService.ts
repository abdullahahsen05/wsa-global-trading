if (typeof window !== "undefined") {
  throw new Error("[aurix] brokerCredentialService is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto/brokerCrypto";

// ─────────────────────────────────────────────────────────────────────────────
// Broker Credential Service (server-only).
//
// Stores MT4/MT5 login/password/server encrypted (AES-256-GCM) in
// broker_credentials.encrypted_reference and decrypts them only for server-side
// broker code. Decrypted secrets are NEVER returned to the frontend, logged, or
// placed in error messages / AI context / copy logs.
// ─────────────────────────────────────────────────────────────────────────────

export interface BrokerCredentialPayload {
  login: string;
  password: string;
  server: string;
  platform?: "mt4" | "mt5";
  provider: string;
  brokerName?: string;
}

export const BROKER_CRED_ERROR = {
  NOT_FOUND: "BROKER_CREDENTIALS_NOT_FOUND",
  DECRYPT_FAILED: "BROKER_CREDENTIALS_DECRYPT_FAILED",
  ACCOUNT_NOT_FOUND: "BROKER_ACCOUNT_NOT_FOUND",
  ACCOUNT_NOT_CONNECTED: "BROKER_ACCOUNT_NOT_CONNECTED",
  PROVIDER_NOT_CONFIGURED: "BROKER_PROVIDER_NOT_CONFIGURED",
} as const;

export type BrokerCredentialErrorCode =
  (typeof BROKER_CRED_ERROR)[keyof typeof BROKER_CRED_ERROR];

export class BrokerCredentialError extends Error {
  constructor(
    public readonly code: BrokerCredentialErrorCode,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "BrokerCredentialError";
  }
}

interface StoredSecret {
  login: string;
  password: string;
  server: string;
  platform?: "mt4" | "mt5";
}

/**
 * Decrypt stored broker credentials for an account. Returns null when no
 * credentials are stored (callers like brokerSyncService treat null as
 * "not connected yet"). Throws BrokerCredentialError on decryption failure.
 */
export async function getDecryptedCredentials(
  accountId: string,
): Promise<BrokerCredentialPayload | null> {
  const supabase = createAdminClient();

  const { data: cred } = await supabase
    .from("broker_credentials")
    .select("provider, encrypted_reference")
    .eq("trading_account_id", accountId)
    .maybeSingle();

  if (!cred) return null;

  let secret: StoredSecret;
  try {
    secret = JSON.parse(decryptSecret(cred.encrypted_reference as string)) as StoredSecret;
  } catch {
    // Never include the ciphertext, key, or any partial plaintext in the error.
    throw new BrokerCredentialError(
      BROKER_CRED_ERROR.DECRYPT_FAILED,
      "Failed to decrypt broker credentials.",
      500,
    );
  }

  const { data: account } = await supabase
    .from("trading_accounts")
    .select("broker_name")
    .eq("id", accountId)
    .maybeSingle();

  return {
    login: secret.login,
    password: secret.password,
    server: secret.server,
    platform: secret.platform,
    provider: (cred.provider as string) ?? "api2trade",
    brokerName: (account?.broker_name as string) ?? undefined,
  };
}

/**
 * Strict variant for paths that require credentials to exist (e.g. first sync).
 * Throws BROKER_CREDENTIALS_NOT_FOUND instead of returning null.
 */
export async function requireDecryptedCredentials(
  accountId: string,
): Promise<BrokerCredentialPayload> {
  const creds = await getDecryptedCredentials(accountId);
  if (!creds) {
    throw new BrokerCredentialError(
      BROKER_CRED_ERROR.NOT_FOUND,
      "No broker credentials stored for this account.",
      404,
    );
  }
  return creds;
}

/**
 * Encrypt and store broker credentials for an account (server-only).
 * The plaintext never leaves this function.
 */
export async function storeBrokerCredentials(
  accountId: string,
  payload: BrokerCredentialPayload,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: account } = await supabase
    .from("trading_accounts")
    .select("id")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) {
    throw new BrokerCredentialError(BROKER_CRED_ERROR.ACCOUNT_NOT_FOUND, "Trading account not found.", 404);
  }

  const encrypted = encryptSecret(
    JSON.stringify({
      login: payload.login,
      password: payload.password,
      server: payload.server,
      platform: payload.platform ?? "mt5",
    } satisfies StoredSecret),
  );

  const { error } = await supabase
    .from("broker_credentials")
    .upsert(
      {
        trading_account_id: accountId,
        provider: payload.provider,
        encrypted_reference: encrypted,
      },
      { onConflict: "trading_account_id" },
    );
  if (error) throw new Error(`Failed to store broker credentials: ${error.message}`);
}

/** Returns the stored API2Trade account id for an account, if any. */
export async function getProviderAccountId(accountId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("trading_accounts")
    .select("provider_account_id")
    .eq("id", accountId)
    .maybeSingle();
  return (data?.provider_account_id as string) ?? null;
}
