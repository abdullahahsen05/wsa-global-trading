import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth, AuthError } from "@/lib/auth/session";
import { AnalyticsAccessError, getBrokerPerformanceChart } from "@/lib/services/analyticsService";
import { analyticsSummaryQuerySchema } from "@/lib/validation/schemas";

/**
 * Dashboard-only broker chart feed. The API2Trade call stays server-side and
 * each requested account is re-authorized against the current user session.
 */
export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const parsed = analyticsSummaryQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) return jsonFail("INVALID_QUERY", parsed.error.message, 400);

    return jsonOk(
      await getBrokerPerformanceChart(parsed.data.accountId, user.id, user.role, parsed.data.period),
    );
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof AnalyticsAccessError) return jsonFail("FORBIDDEN", err.message, 403);
    throw err;
  }
}
