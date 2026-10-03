import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader, AuthError } from "@/lib/auth/session";
import { getDailyPnl } from "@/lib/services/tradeService";

export async function GET(request: Request) {
  try {
    const user = await requireTrader();
    const accountId = new URL(request.url).searchParams.get("accountId") ?? undefined;
    return jsonOk(await getDailyPnl(user.id, accountId));
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
