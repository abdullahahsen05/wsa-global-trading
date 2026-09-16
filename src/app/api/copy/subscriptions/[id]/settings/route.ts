import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireTrader } from "@/lib/auth/session";
import { CopyError } from "@/lib/copy/types";
import { copyFollowerSettingsSchema } from "@/lib/validation/schemas";
import { updateMyFollowerSettings } from "@/lib/services/copyTradingService";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const trader = await requireTrader();
    const { id } = await context.params;
    const parsed = copyFollowerSettingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonFail(
        "VALIDATION_ERROR",
        parsed.error.issues.map((issue) => issue.message).join(", "),
        400,
      );
    }
    const subscription = await updateMyFollowerSettings(trader.id, id, parsed.data);
    return jsonOk({ id, updated: true, subscription });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    if (error instanceof CopyError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("COPY_SETTINGS_UPDATE_FAILED", "Follower settings could not be updated.", 500);
  }
}
