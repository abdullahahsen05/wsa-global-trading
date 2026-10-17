import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireTrader } from "@/lib/auth/session";
import { CopyError } from "@/lib/copy/types";
import { getSelfCopyActivity } from "@/lib/services/selfCopyService";

/** The latest copied, skipped and failed trades of one route (with the reason for every skip). */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const trader = await requireTrader();
    const { id } = await context.params;
    const requested = Number(new URL(request.url).searchParams.get("limit"));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(200, Math.floor(requested)) : 40;
    return jsonOk(await getSelfCopyActivity({ traderId: trader.id, id, limit }));
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    if (error instanceof CopyError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("SELF_COPY_ACTIVITY_UNAVAILABLE", "The activity of this route is unavailable.", 503);
  }
}
