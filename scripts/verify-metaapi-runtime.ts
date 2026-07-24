import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";

loadEnvConfig(process.cwd());

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function shortId(value: string | null): string | null {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

async function main() {
  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: accounts, error: accountError } = await supabase
    .from("trading_accounts")
    .select("id, account_name, status, provider_account_id, last_synced_at, sync_error")
    .not("provider_account_id", "is", null)
    .limit(100);
  if (accountError) throw new Error(accountError.message);

  const { data: jobs, error: jobError } = await supabase
    .from("background_jobs")
    .select("type, status, attempts, last_error_code, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (jobError) throw new Error(jobError.message);

  const jobCounts = new Map<string, number>();
  for (const job of jobs ?? []) {
    const key = `${job.type}:${job.status}`;
    jobCounts.set(key, (jobCounts.get(key) ?? 0) + 1);
  }

  const MetaApi = (await import("metaapi.cloud-sdk/node")).default;
  const api = new MetaApi(requiredEnv("METAAPI_TOKEN"));
  const providerAccounts: Array<Record<string, unknown>> = [];
  try {
    for (const account of accounts ?? []) {
      try {
        const provider = await api.metatraderAccountApi.getAccount(
          account.provider_account_id,
        );
        providerAccounts.push({
          account: account.account_name,
          accountId: shortId(account.id),
          providerId: shortId(provider.id),
          state: provider.state,
          connectionStatus: provider.connectionStatus,
        });
      } catch (error) {
        providerAccounts.push({
          account: account.account_name,
          accountId: shortId(account.id),
          providerId: shortId(account.provider_account_id),
          error: error instanceof Error ? error.name : "Provider request failed",
        });
      }
    }
  } finally {
    api.close();
  }

  const tradeCounts = await Promise.all((accounts ?? []).map(async (account) => {
    const [open, closed] = await Promise.all([
      supabase
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("trading_account_id", account.id)
        .eq("status", "OPEN"),
      supabase
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("trading_account_id", account.id)
        .eq("status", "CLOSED"),
    ]);
    if (open.error) throw new Error(open.error.message);
    if (closed.error) throw new Error(closed.error.message);
    return {
      account: account.account_name,
      open: open.count ?? 0,
      closed: closed.count ?? 0,
    };
  }));

  console.log(JSON.stringify({
    accounts: (accounts ?? []).map((account) => ({
      account: account.account_name,
      accountId: shortId(account.id),
      status: account.status,
      providerId: shortId(account.provider_account_id),
      lastSyncedAt: account.last_synced_at,
      hasSyncError: Boolean(account.sync_error),
    })),
    providerAccounts,
    tradeCounts,
    jobCounts: Object.fromEntries(jobCounts),
    pendingOrFailedJobs: (jobs ?? [])
      .filter((job) => job.status === "PENDING" || job.status === "FAILED")
      .slice(0, 30)
      .map((job) => ({
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        errorCode: job.last_error_code,
        updatedAt: job.updated_at,
      })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runtime verification failed.");
  process.exitCode = 1;
});
