if (typeof window !== "undefined") {
  throw new Error("tradingAccountLifecycleService is server-only.");
}

import { ACCOUNT_INACTIVITY_DAYS, resolveAccountLifecycleStatus } from "@/lib/accounts/lifecycle";
import type { AccountStatus } from "@/lib/domain/types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Reconciles impossible/stale account states. The live worker calls this on a
 * bounded interval so an account cannot remain execution-eligible forever
 * after its broker stream stops producing synchronized snapshots.
 */
export async function expireStaleTradingAccounts(): Promise<number> {
  const supabase = createAdminClient();
  const { data: accounts, error } = await supabase
    .from("trading_accounts")
    .select("id, status, broker_server, broker_platform, last_synced_at")
    .in("status", ["CONNECTED", "RESTRICTED"])
    .limit(2_000);
  if (error) throw new Error(`Trading account lifecycle scan failed: ${error.message}`);
  if (!accounts?.length) return 0;

  const accountIds = accounts.map((account) => account.id);
  const { data: snapshots, error: snapshotError } = await supabase
    .from("latest_account_snapshots")
    .select("trading_account_id, captured_at")
    .in("trading_account_id", accountIds);
  if (snapshotError) {
    throw new Error(`Trading account lifecycle snapshots failed: ${snapshotError.message}`);
  }
  const snapshotByAccount = new Map(
    (snapshots ?? []).map((snapshot) => [snapshot.trading_account_id, snapshot.captured_at]),
  );

  let changed = 0;
  for (const account of accounts) {
    const resolved = resolveAccountLifecycleStatus({
      status: account.status as AccountStatus,
      lastSyncedAt: account.last_synced_at,
      snapshotCapturedAt: snapshotByAccount.get(account.id) ?? null,
      serverName: account.broker_server,
      platform: account.broker_platform,
    });
    if (resolved === account.status) continue;

    const syncError = resolved === "INACTIVE"
      ? `No successful broker activity for ${ACCOUNT_INACTIVITY_DAYS} days. Reconnect the account to resume live data and trading.`
      : resolved === "PENDING"
        ? "Broker connection details are incomplete. Complete account setup before connecting."
        : "Broker setup is incomplete. Run account sync to finish the connection.";
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
