import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireTrader } from "@/lib/auth/session";
import { CopyError } from "@/lib/copy/types";
import { checkSelfCopyRoute } from "@/lib/services/selfCopyService";

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
    return jsonFail("SELF_COPY_SIMULATION_FAILED", "Self-copy simulation could not be completed.", 500);
  }
}
