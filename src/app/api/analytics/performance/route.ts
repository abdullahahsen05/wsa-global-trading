import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth, AuthError } from "@/lib/auth/session";
import { AnalyticsAccessError } from "@/lib/services/analyticsService";
import { getPerformanceSeries } from "@/lib/services/performanceService";
import { performanceQuerySchema } from "@/lib/validation/schemas";

/**
 * GET /api/analytics/performance?accountId=<uuid|ALL>&range=1D|1W|1M|3M|6M|1Y|ALL
 *
 * One payload for every account chart: sampled balance/equity history (with
 * margin when it is recorded), the closed-trade ledger and its statistics.
 * Access is scoped to the caller's own accounts (admins see every account).
 */
export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const parsed = performanceQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) return jsonFail("INVALID_QUERY", parsed.error.message, 400);

    const series = await getPerformanceSeries({
      accountId: parsed.data.accountId,
      userId: user.id,
      role: user.role,
      range: parsed.data.range,
    });
    return jsonOk(series, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof AnalyticsAccessError) return jsonFail("FORBIDDEN", err.message, 403);
    console.error("[PERFORMANCE_SERIES_ERROR]", err instanceof Error ? err.message : err);
    return jsonFail(
      "PERFORMANCE_UNAVAILABLE",
      "Account performance history could not be loaded. Try again in a moment.",
      500,
    );
  }
}
