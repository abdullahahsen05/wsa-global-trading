import { createAdminClient } from "@/lib/supabase/admin";
import {
  storeBrokerCredentials,
  type BrokerCredentialPayload,
} from "@/lib/services/brokerCredentialService";
import { syncTradingAccount } from "@/lib/services/brokerSyncService";
import {
  api2TradeUsesDashboardAccounts,
  getBrokerProviderId,
  getBrokerProviderLabel,
} from "@/lib/broker/provider";

export interface BrokerConnectionResult {
  accountId: string;
  credentialsStored: boolean;
  connected: boolean;
  status: "CONNECTED" | "DISCONNECTED" | "PENDING";
  snapshotStored: boolean;
  tradesUpserted: number;
  message: string;
}

/**
 * Single server-side account connection path used by trader and admin UIs.
 * Storing credentials and establishing the MetaApi account are deliberately
 * separate result facts so callers never present storage as a broker connection.
 */
export async function connectBrokerAccount(params: {
  accountId: string;
  actorUserId: string;
  credentials: BrokerCredentialPayload;
  brokerProviderId?: string;
  providerAccountId?: string;
  connectNow?: boolean;
}): Promise<BrokerConnectionResult> {
  const providerLabel = getBrokerProviderLabel();
  const providerId = getBrokerProviderId();
  const usesDashboardUuidMode =
    providerId === "api2trade"
    && api2TradeUsesDashboardAccounts()
    && Boolean(params.providerAccountId);

  if (!usesDashboardUuidMode) {
    await storeBrokerCredentials(params.accountId, params.credentials);
  }

  const platform = (params.credentials.platform ?? "mt5").toUpperCase();
  const supabase = createAdminClient();
  const metadata: Record<string, string> = {
    broker_platform: platform,
  };
  if (params.credentials.server?.trim()) {
    metadata.broker_server = params.credentials.server.trim();
  }
  if (params.brokerProviderId) {
    metadata.broker_provider_id = params.brokerProviderId;
  }
  if (params.credentials.brokerName?.trim()) {
    metadata.broker_name = params.credentials.brokerName.trim();
  }
  if (usesDashboardUuidMode && params.providerAccountId) {
    metadata.provider_account_id = params.providerAccountId;
    metadata.provider = providerId;
  }

  const { error: metadataError } = await supabase
    .from("trading_accounts")
    .update(metadata)
    .eq("id", params.accountId);
  if (metadataError) {
    throw new Error(`Failed to store broker account metadata: ${metadataError.message}`);
  }

  if (params.connectNow === false) {
    return {
      accountId: params.accountId,
      credentialsStored: !usesDashboardUuidMode,
      connected: false,
      status: "PENDING",
      snapshotStored: false,
      tradesUpserted: 0,
      message: usesDashboardUuidMode
        ? "API2Trade account UUID stored. Broker sync has not been started."
        : "Credentials stored. Broker connection has not been started.",
    };
  }

  const sync = await syncTradingAccount(params.accountId, params.actorUserId);
  return {
    accountId: params.accountId,
    credentialsStored: !usesDashboardUuidMode,
    connected: sync.status === "CONNECTED",
    status: sync.status,
    snapshotStored: sync.snapshotInserted,
    tradesUpserted: sync.tradesUpserted,
    message:
      sync.status === "CONNECTED"
        ? "Broker account connected and synchronized."
        : sync.pendingMessage ?? sync.error ??
          (sync.status === "PENDING"
            ? `${providerLabel} is still connecting this account. Check status again shortly.`
            : "Broker connection failed."),
  };
}
