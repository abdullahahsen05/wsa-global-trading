import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth, assertCanAccessAccount, AuthError } from "@/lib/auth/session";
import {
  getDecryptedCredentials,
  BrokerCredentialError,
} from "@/lib/services/brokerCredentialService";
import {
  api2TradeUsesDashboardAccounts,
  brokerProviderConfigured,
  createBrokerAdapter,
  getBrokerProviderId,
  getBrokerProviderLabel,
} from "@/lib/broker/provider";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";

async function writeBrokerOpLog(
  accountId: string,
  userId: string,
  status: "SUCCESS" | "FAILED",
  errorCode: string | null,
  errorMessage: string | null,
) {
  const supabase = createAdminClient();
  await supabase.from("broker_operation_logs").insert({
    account_id: accountId,
    user_id: userId,
    operation: "VERIFY_CONNECTION",
    provider: getBrokerProviderId(),
    status,
    error_code: errorCode,
    error_message: errorMessage ? errorMessage.slice(0, 300) : null,
  });
}

function sanitizeProviderError(msg: string): string {
  // Strip anything that looks like credentials from provider error messages
  return msg
    .replace(/password[^,\s]*/gi, "[redacted]")
    .replace(/login[^,\s]*/gi, "[redacted]")
    .slice(0, 300);
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await context.params;
    const user = await requireAuth();

    if (user.role === "PARTNER") {
      return jsonFail("FORBIDDEN", "Partners cannot verify broker connections.", 403);
    }

    await assertCanAccessAccount(accountId);

    const providerLabel = getBrokerProviderLabel();
    const providerId = getBrokerProviderId();
    const usesDashboardUuidMode =
      providerId === "api2trade" && api2TradeUsesDashboardAccounts();

    if (!brokerProviderConfigured()) {
      return jsonFail(
        "BROKER_PROVIDER_NOT_CONFIGURED",
        `${providerLabel} is not configured. Set the active broker provider environment variables to enable broker connectivity.`,
        503,
      );
    }

    const supabase = createAdminClient();
    const { data: account } = await supabase
      .from("trading_accounts")
      .select("provider_account_id, broker_server, broker_platform")
      .eq("id", accountId)
      .maybeSingle();

    const checkedAt = new Date().toISOString();

    const creds = await getDecryptedCredentials(accountId);

    if (!usesDashboardUuidMode && !creds) {
      return jsonFail(
        "BROKER_CREDENTIALS_NOT_FOUND",
        "No broker credentials stored for this account. Store credentials first.",
        404,
      );
    }

    // Provider verification requires a provider_account_id (set during first sync).
    // If the account hasn't been synced yet, direct the user to sync first.
    if (!account?.provider_account_id) {
      await writeBrokerOpLog(
        accountId,
        user.id,
        "FAILED",
        "BROKER_ACCOUNT_NOT_CONNECTED",
        `Account has not been synced yet. No ${providerLabel} account ID stored.`,
      );

      return jsonOk({
        connected: false,
        provider: providerId,
        accountId,
        checkedAt,
        needsSync: true,
        message:
          usesDashboardUuidMode
            ? `No API2Trade account UUID is linked yet. Add the MT account in API2Trade first, then enter its UUID here.`
            : `Account has not been synced yet. Run 'Sync Account' first to establish the ${providerLabel} connection.`,
      });
    }

    const adapter = createBrokerAdapter();
    const health = await adapter.verifyConnection(accountId);

    await writeBrokerOpLog(
      accountId,
      user.id,
      health.ok ? "SUCCESS" : "FAILED",
      health.ok ? null : "BROKER_PROVIDER_ERROR",
      health.ok ? null : sanitizeProviderError(health.message),
    );

    void writeAuditLog({
      actorUserId: user.id,
      action: "BROKER_CONNECTION_VERIFIED",
      entityType: "trading_account",
      entityId: accountId,
      metadata: { ok: health.ok, provider: health.provider },
    });

    return jsonOk({
      connected: health.ok,
      provider: health.provider,
      accountId,
      checkedAt,
      needsSync: false,
      message: health.ok ? null : sanitizeProviderError(health.message),
    });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof BrokerCredentialError) return jsonFail(err.code, err.message, err.statusCode);
    // Never surface raw provider errors
    const msg = err instanceof Error ? err.message : "Verification failed.";
    return jsonFail("BROKER_PROVIDER_ERROR", sanitizeProviderError(msg), 502);
  }
}
