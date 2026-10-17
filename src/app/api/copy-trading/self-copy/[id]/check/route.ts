import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireTrader } from "@/lib/auth/session";
import { CopyError } from "@/lib/copy/types";
import { checkSelfCopyRoute } from "@/lib/services/selfCopyService";

/** Dry run: what the copy engine would do with a trade like the source's latest one. Places no order. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const trader = await requireTrader();
    const { id } = await context.params;
    return jsonOk(await checkSelfCopyRoute({ traderId: trader.id, id }));
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    if (error instanceof CopyError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("SELF_COPY_CHECK_FAILED", "The route could not be checked.", 500);
  }
}
