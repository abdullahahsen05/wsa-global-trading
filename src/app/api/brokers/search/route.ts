import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAuth } from "@/lib/auth/session";
import { searchApi2TradeBrokers, type BrokerPlatform } from "@/lib/services/api2TradeBrokerDiscoveryService";

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const url = new URL(request.url);
    const platformParam = url.searchParams.get("platform")?.toUpperCase();
    const query = url.searchParams.get("query") ?? "";

    if (platformParam && platformParam !== "MT4" && platformParam !== "MT5") {
      return jsonFail("INVALID_PLATFORM", "Platform must be MT4 or MT5.", 400);
    }

    const result = await searchApi2TradeBrokers({
      query,
      platform: platformParam as BrokerPlatform | undefined,
      userId: user.id,
      role: user.role,
    });

    return jsonOk({
      ...result,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("BROKER_SEARCH_UNAVAILABLE", "Broker search is unavailable.", 503);
  }
}
