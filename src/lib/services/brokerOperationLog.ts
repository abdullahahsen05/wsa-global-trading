if (typeof window !== "undefined") {
  throw new Error("[aurix] brokerOperationLog is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";

// ─────────────────────────────────────────────────────────────────────────────
// Broker operation logging (server-only). Records traceable, SECRET-FREE
// diagnostics for every broker call. Never pass passwords, tokens, or decrypted
// credential payloads in safeMetadata. Never throws — logging must not break ops.
// ─────────────────────────────────────────────────────────────────────────────

export type BrokerOperation =
  | "VERIFY_CONNECTION"
  | "FETCH_SNAPSHOT"
  | "FETCH_OPEN_TRADES"
  | "FETCH_HISTORY"
  | "OPEN_TRADE"
  | "CLOSE_TRADE"
  | "MODIFY_TRADE"
  | "SYNC_ACCOUNT"
  | "MONITOR_MASTER"
  | "DEACTIVATE_ACCOUNT"
  | "REACTIVATE_ACCOUNT";

export async function logBrokerOperation(params: {
  accountId: string | null;
  userId?: string | null;
  operation: BrokerOperation;
  status: "SUCCESS" | "FAILED";
  provider?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  safeMetadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase.from("broker_operation_logs").insert({
      account_id: params.accountId,
      user_id: params.userId ?? null,
      operation: params.operation,
      provider: params.provider ?? "api2trade",
      status: params.status,
      error_code: params.errorCode ?? null,
      error_message: params.errorMessage ? params.errorMessage.slice(0, 500) : null,
      safe_metadata: params.safeMetadata ?? null,
    });
  } catch (err) {
    console.error("[brokerOperationLog] failed to write:", err);
  }
}
