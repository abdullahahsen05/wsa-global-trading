import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth, assertCanAccessAccount, AuthError } from "@/lib/auth/session";
import { syncTradingAccount } from "@/lib/services/brokerSyncService";
import { getDecryptedCredentials } from "@/lib/services/brokerCredentialService";
import { brokerProviderConfigured, getBrokerProviderLabel } from "@/lib/broker/provider";

export async function POST(
  _req: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await context.params;
    const user = await requireAuth();

    if (user.role === "PARTNER") {
      return jsonFail("FORBIDDEN", "Partners cannot sync broker accounts.", 403);
    }

    await assertCanAccessAccount(accountId);

    // Guard: credentials must be stored before sync can run
    const creds = await getDecryptedCredentials(accountId);
    if (!creds) {
      return jsonFail(
        "BROKER_CREDENTIALS_NOT_FOUND",
        "No broker credentials stored for this account. Store credentials first.",
        404,
      );
    }

    const providerLabel = getBrokerProviderLabel();
    if (!brokerProviderConfigured()) {
      return jsonFail(
        "BROKER_PROVIDER_NOT_CONFIGURED",
        `${providerLabel} is not configured. Set the active broker provider environment variables to enable broker sync.`,
        503,
      );
    }

    const result = await syncTradingAccount(accountId, user.id);

    if (result.status === "DISCONNECTED") {
      return jsonFail("BROKER_SYNC_FAILED", result.error ?? "Sync failed.", 502);
    }

    if (result.status === "PENDING") {
      // MetaAPI deploy/connect timed out — still in progress
      return jsonOk({
        accountId: result.accountId,
        status: "SYNCING",
        snapshotStored: false,
        tradesUpserted: 0,
        message:
          result.pendingMessage ??
          `${providerLabel} is still connecting or synchronizing. Status checks can continue safely.`,
      }, { status: 202 });
    }

    return jsonOk({
      accountId: result.accountId,
      status: "CONNECTED",
      snapshotStored: result.snapshotInserted,
      tradesUpserted: result.tradesUpserted,
      lastSyncedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    const msg = err instanceof Error ? err.message : "Sync failed.";
    return jsonFail("BROKER_SYNC_FAILED", msg.slice(0, 300), 502);
  }
}
