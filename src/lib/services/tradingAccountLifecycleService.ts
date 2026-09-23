if (typeof window !== "undefined") {
  throw new Error("tradingAccountLifecycleService is server-only.");
}

import { ACCOUNT_INACTIVITY_DAYS, resolveAccountLifecycleStatus } from "@/lib/accounts/lifecycle";
import type { AccountStatus } from "@/lib/domain/types";
import { createAdminClient } from "@/lib/supabase/admin";

const ACCOUNT_SCAN_PAGE_SIZE = 1_000;
const SNAPSHOT_LOOKUP_BATCH_SIZE = 500;

type LifecycleAccountRow = {
  id: string;
  status: string;
  broker_server: string | null;
  broker_platform: string | null;
  provider_account_id: string | null;
  last_synced_at: string | null;
};

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function loadLiveLifecycleAccounts(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<LifecycleAccountRow[]> {
  const accounts: LifecycleAccountRow[] = [];
  for (let from = 0; ; from += ACCOUNT_SCAN_PAGE_SIZE) {
    const to = from + ACCOUNT_SCAN_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("trading_accounts")
      .select("id, status, broker_server, broker_platform, provider_account_id, last_synced_at")
      .in("status", ["CONNECTED", "RESTRICTED"])
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`Trading account lifecycle scan failed: ${error.message}`);
    accounts.push(...((data ?? []) as LifecycleAccountRow[]));
    if (!data || data.length < ACCOUNT_SCAN_PAGE_SIZE) break;
  }
  return accounts;
}

/**
 * Reconciles impossible/stale account states. The live worker calls this on a
 * bounded interval so an account cannot remain execution-eligible forever
 * after its broker stream stops producing synchronized snapshots.
 */
export async function expireStaleTradingAccounts(): Promise<number> {
  const supabase = createAdminClient();
  const accounts = await loadLiveLifecycleAccounts(supabase);
  if (!accounts.length) return 0;

  const accountIds = accounts.map((account) => account.id);
  const snapshotByAccount = new Map<string, string | null>();
  for (const batch of chunk(accountIds, SNAPSHOT_LOOKUP_BATCH_SIZE)) {
    const { data: snapshots, error: snapshotError } = await supabase
      .from("latest_account_snapshots")
      .select("trading_account_id, captured_at")
      .in("trading_account_id", batch);
    if (snapshotError) {
      throw new Error(`Trading account lifecycle snapshots failed: ${snapshotError.message}`);
    }
    for (const snapshot of snapshots ?? []) {
      snapshotByAccount.set(snapshot.trading_account_id, snapshot.captured_at);
    }
  }

  let changed = 0;
  for (const account of accounts) {
    const resolved = resolveAccountLifecycleStatus({
      status: account.status as AccountStatus,
      lastSyncedAt: account.last_synced_at,
      snapshotCapturedAt: snapshotByAccount.get(account.id) ?? null,
      serverName: account.broker_server,
      platform: account.broker_platform,
      providerAccountId: account.provider_account_id,
    });
    if (resolved === account.status) continue;

    const syncError = resolved === "INACTIVE"
      ? `No successful broker activity for ${ACCOUNT_INACTIVITY_DAYS} days. Reconnect the account to resume live data and trading.`
      : resolved === "PENDING"
        ? "Broker connection details are incomplete. Complete account setup before connecting."
        : "Broker connection is provisioning. Run account sync to finish the first live-data refresh.";
    const { error: updateError } = await supabase
      .from("trading_accounts")
      .update({ status: resolved, sync_error: syncError })
      .eq("id", account.id)
      .in("status", ["CONNECTED", "RESTRICTED"]);
    if (updateError) {
      throw new Error(`Trading account ${account.id} lifecycle update failed: ${updateError.message}`);
    }
    changed += 1;
  }
  return changed;
}
