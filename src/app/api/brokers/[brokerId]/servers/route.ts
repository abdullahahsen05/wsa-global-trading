import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAuth } from "@/lib/auth/session";
import {
  getBrokerProvider,
  listBrokerServers,
  type BrokerPlatform,
} from "@/lib/services/brokerCatalogService";
import { getBrokerProviderId } from "@/lib/broker/provider";
import { searchApi2TradeServers } from "@/lib/services/api2TradeServerDiscoveryService";
import { searchKnownMetaApiServers } from "@/lib/services/metaApiServerDiscoveryService";

export async function GET(
  request: Request,
  context: { params: Promise<{ brokerId: string }> },
) {
  try {
    await requireAuth();
    const { brokerId } = await context.params;
    const url = new URL(request.url);
    const value = url.searchParams.get("platform")?.toUpperCase();
    if (value !== "MT4" && value !== "MT5") {
      return jsonFail("INVALID_PLATFORM", "Platform must be MT4 or MT5.", 400);
    }
    const provider = await getBrokerProvider(brokerId);
    if (!provider?.isActive) {
      return jsonFail("BROKER_NOT_FOUND", "Selected broker is not active.", 404);
    }
    const configured = await listBrokerServers({
        brokerProviderId: brokerId,
        platform: value as BrokerPlatform,
      });
    const searchQuery = (url.searchParams.get("query") ?? provider.displayName).trim().slice(0, 100);
    const activeBrokerProvider = getBrokerProviderId();
    const discovered = activeBrokerProvider === "api2trade"
      ? await searchApi2TradeServers({ query: searchQuery })
      : await searchKnownMetaApiServers({
        platform: value as BrokerPlatform,
        query: searchQuery,
      });
    const configuredNames = new Set(configured.map((server) => server.serverName.toLowerCase()));
    const liveServers = discovered.servers
      .filter((server) => !configuredNames.has(server.serverName.toLowerCase()))
      .map((server, index) => ({
        id: `${activeBrokerProvider}:${value}:${index}:${server.serverName}`,
        brokerProviderId: brokerId,
        platform: value as BrokerPlatform,
        serverName: server.serverName,
        brokerName: server.brokerName,
        source: activeBrokerProvider === "api2trade" ? "API2TRADE" as const : "METAAPI" as const,
        isActive: true,
        lastRefreshedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    return jsonOk({
      servers: [
        ...configured.map((server) => ({ ...server, brokerName: provider.displayName })),
        ...liveServers,
      ],
      source: liveServers.length > 0
        ? activeBrokerProvider === "api2trade" ? "ADMIN_AND_API2TRADE" : "ADMIN_AND_METAAPI"
        : "ADMIN_CONFIGURED",
      sourceLabel: liveServers.length > 0
        ? activeBrokerProvider === "api2trade"
          ? "Configured and API2Trade-discovered broker servers"
          : "Configured and MetaApi-known broker servers"
        : "Configured broker servers",
      discoveryAvailable: discovered.available,
      discoveryMessage: discovered.message,
      searchQuery,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("BROKER_SERVERS_UNAVAILABLE", "Broker servers are unavailable.", 503);
  }
}
