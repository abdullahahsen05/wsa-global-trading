import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, assertCanAccessAccount, requireAuth } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBrokerProviderId } from "@/lib/broker/provider";
import { searchApi2TradeServers } from "@/lib/services/api2TradeServerDiscoveryService";
import { searchKnownMetaApiServers } from "@/lib/services/metaApiServerDiscoveryService";

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const url = new URL(request.url);
    const platform = url.searchParams.get("platform")?.toUpperCase();
    const query = (url.searchParams.get("query") ?? "").trim();
    const accountId = url.searchParams.get("accountId")?.trim() || null;

    if (platform !== "MT4" && platform !== "MT5") {
      return jsonFail("INVALID_PLATFORM", "Platform must be MT4 or MT5.", 400);
    }

    let seedAccountId: string | null = null;
    const supabase = createAdminClient();

    if (accountId) {
      await assertCanAccessAccount(accountId);
      const { data } = await supabase
        .from("trading_accounts")
        .select("provider_account_id")
        .eq("id", accountId)
        .maybeSingle();
      seedAccountId = (data?.provider_account_id as string | null) ?? null;
    }

    if (!seedAccountId) {
      let seedQuery = supabase
        .from("trading_accounts")
        .select("provider_account_id")
        .not("provider_account_id", "is", null)
        .eq("provider", "api2trade")
        .order("last_synced_at", { ascending: false, nullsFirst: false })
        .limit(1);

      if (user.role === "TRADER") {
        seedQuery = seedQuery.eq("user_id", user.id);
      }

      const { data } = await seedQuery.maybeSingle();
      seedAccountId = (data?.provider_account_id as string | null) ?? null;
    }

    const discovered = getBrokerProviderId() === "api2trade"
      ? await searchApi2TradeServers({ query, seedAccountId })
      : await searchKnownMetaApiServers({ platform, query });

    return jsonOk({
      servers: discovered.servers.map((server, index) => ({
        id: `${platform}:${index}:${server.serverName}`,
        serverName: server.serverName,
        brokerName: server.brokerName,
        source: getBrokerProviderId() === "api2trade" ? "API2TRADE" as const : "METAAPI" as const,
      })),
      discoveryAvailable: discovered.available,
      discoveryMessage: discovered.message,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("BROKER_SERVER_SEARCH_UNAVAILABLE", "Broker server search is unavailable.", 503);
  }
}
