import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { getEquityCurve } from "@/lib/services/analyticsService";
import { listAllAccounts } from "@/lib/services/adminService";
import type { AdminEquityTimelineDto } from "@/lib/domain/types";

export async function GET() {
  try {
    const admin = await requireAdmin();
    const accounts = await listAllAccounts();
    const connected = accounts.filter((account) => account.status === "CONNECTED");
    const currencies = [...new Set(connected.map((account) => account.equity.currency))];
    const mixedCurrencies = currencies.length > 1;
    const points = mixedCurrencies
      ? []
      : await getEquityCurve("ALL", admin.id, admin.role, "WEEKLY");
    const result: AdminEquityTimelineDto = {
      points,
      currency: currencies[0] ?? null,
      mixedCurrencies,
      capturedAt: connected
        .map((account) => account.updatedAt)
        .sort((left, right) => right.localeCompare(left))[0] ?? null,
    };
    return jsonOk(result, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    throw error;
  }
}
