import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAllAccounts } from "@/lib/services/adminService";
import type { AdminEquityTimelineDto } from "@/lib/domain/types";

export async function GET() {
  try {
    await requireAdmin();
    const accounts = await listAllAccounts();
    const connected = accounts.filter((account) => account.status === "CONNECTED");
    const currencies = [...new Set(connected.map((account) => account.equity.currency))];
    const mixedCurrencies = currencies.length > 1;
    const { data: timeline, error: timelineError } = mixedCurrencies || connected.length === 0
      ? { data: [], error: null }
      : await createAdminClient().rpc("platform_equity_timeline", {
          p_account_ids: connected.map((account) => account.accountId),
          p_start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
    if (timelineError) throw new Error(`Failed to load platform equity history: ${timelineError.message}`);
    const points = (timeline ?? []).map((point: { captured_at: string; balance: number | string; equity: number | string }) => ({
      capturedAt: point.captured_at as string,
      balance: Number(point.balance),
      equity: Number(point.equity),
    }));
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
