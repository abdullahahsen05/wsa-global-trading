import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader, AuthError } from "@/lib/auth/session";
import { listPublishedEvents } from "@/lib/services/economicCalendarService";

// GET /api/economic-calendar — readable by any authenticated active user.
export async function GET(request: Request) {
  try {
    await requireTrader();
    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const limitParam = Number(url.searchParams.get("limit") ?? "200");
    const from = fromParam ? new Date(fromParam) : undefined;
    const to = toParam ? new Date(toParam) : undefined;
    return jsonOk(
      await listPublishedEvents({
        from: from && !Number.isNaN(from.getTime()) ? from : undefined,
        to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        limit: Number.isFinite(limitParam) ? limitParam : 200,
      }),
    );
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
