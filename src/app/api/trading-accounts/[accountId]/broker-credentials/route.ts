import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth, assertCanAccessAccount, AuthError } from "@/lib/auth/session";
import {
  BrokerCredentialError,
} from "@/lib/services/brokerCredentialService";
import { connectBrokerAccount } from "@/lib/services/brokerConnectionService";
import { getBrokerProviderId } from "@/lib/broker/provider";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";
import { brokerConnectionSchema } from "@/lib/validation/schemas";
import { resolveBrokerSelection } from "@/lib/services/brokerCatalogService";
import { resolveAccountLifecycleStatus } from "@/lib/accounts/lifecycle";
import type { AccountStatus } from "@/lib/domain/types";

// GET — safe credential status (never returns password or encrypted payload)
export async function GET(
  _req: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await context.params;
    const user = await requireAuth();

    if (user.role === "PARTNER") {
      return jsonFail("FORBIDDEN", "Partners cannot access broker credentials.", 403);
    }

    await assertCanAccessAccount(accountId);

    const supabase = createAdminClient();

    const [credRow, accountRow, snapshotRow] = await Promise.all([
      supabase
        .from("broker_credentials")
        .select("provider, created_at, updated_at")
        .eq("trading_account_id", accountId)
        .maybeSingle(),
      supabase
        .from("trading_accounts")
        .select("provider_account_id, last_synced_at, sync_error, status, broker_name, broker_server, broker_platform, broker_provider_id")
        .eq("id", accountId)
        .maybeSingle(),
      supabase
        .from("latest_account_snapshots")
        .select("captured_at")
        .eq("trading_account_id", accountId)
        .maybeSingle(),
    ]);
    const accountStatus = accountRow.data
      ? resolveAccountLifecycleStatus({
          status: accountRow.data.status as AccountStatus,
          lastSyncedAt: accountRow.data.last_synced_at,
          snapshotCapturedAt: snapshotRow.data?.captured_at ?? null,
          serverName: accountRow.data.broker_server,
          platform: accountRow.data.broker_platform,
        })
      : null;

    return jsonOk({
      accountId,
      credentialsStored: !!credRow.data,
      provider: credRow.data?.provider ?? null,
      providerAccountId: accountRow.data?.provider_account_id ?? null,
      lastSyncedAt: accountRow.data?.last_synced_at ?? null,
      syncError: accountRow.data?.sync_error ?? null,
      status: accountStatus,
      brokerName: accountRow.data?.broker_name ?? "WSA GLOBAL",
      brokerProviderId: accountRow.data?.broker_provider_id ?? null,
      serverName: accountRow.data?.broker_server ?? null,
      platform: accountRow.data?.broker_platform ?? null,
    });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}

// POST — encrypt and store broker credentials
export async function POST(
  req: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await context.params;
    const user = await requireAuth();

    if (user.role === "PARTNER") {
      return jsonFail("FORBIDDEN", "Partners cannot store broker credentials.", 403);
    }

    await assertCanAccessAccount(accountId);

    const body = await req.json().catch(() => null);
    const parsed = brokerConnectionSchema.safeParse(body);
    if (!parsed.success) {
      return jsonFail(
        "VALIDATION_ERROR",
        parsed.error.issues.map((i) => i.message).join(", "),
        400,
      );
    }

    const {
      platform,
      login,
      password,
      server,
      brokerProviderId,
      brokerName,
      useCustomBrokerServer,
      connectNow,
    } = parsed.data;
    let resolvedBrokerName = brokerName;
    if (brokerProviderId) {
      try {
        const brokerSelection = await resolveBrokerSelection({
          brokerProviderId,
          platform,
          serverName: server,
          allowUnlistedServer: useCustomBrokerServer,
        });
        resolvedBrokerName = brokerSelection.displayName;
      } catch (selectionError) {
        return jsonFail(
          "BROKER_SELECTION_INVALID",
          selectionError instanceof Error ? selectionError.message : "Selected broker server is invalid.",
          400,
        );
      }
    }

    const result = await connectBrokerAccount({
      accountId,
      actorUserId: user.id,
      brokerProviderId,
      connectNow,
      credentials: {
        login,
        password,
        server,
        platform: platform.toLowerCase() as "mt4" | "mt5",
        provider: getBrokerProviderId(),
        brokerName: resolvedBrokerName,
      },
    });

    void writeAuditLog({
      actorUserId: user.id,
      action: "BROKER_CREDENTIALS_STORED",
      entityType: "trading_account",
      entityId: accountId,
      // Never log login, password, or encrypted payload
      metadata: {
        platform,
        server: "[stored]",
        selectionSource: useCustomBrokerServer ? "CUSTOM" : "CATALOG",
      },
    });

    return jsonOk(result);
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof BrokerCredentialError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof Error && err.message.includes("ENCRYPTION_KEY")) {
      return jsonFail(
        "BROKER_CREDENTIAL_STORE_FAILED",
        "Encryption is not configured on this server. Set ENCRYPTION_KEY.",
        503,
      );
    }
    throw err;
  }
}
