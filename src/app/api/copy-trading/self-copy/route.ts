import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireTrader } from "@/lib/auth/session";
import { CopyError } from "@/lib/copy/types";
import { selfCopyCreateSchema } from "@/lib/validation/schemas";
import {
  createSelfCopyRelationship,
  listSelfCopyRelationships,
} from "@/lib/services/selfCopyService";
import {
  getPlatformSubscriptionAccess,
} from "@/lib/services/billingService";

export async function GET() {
  try {
    const trader = await requireTrader();
    return jsonOk({ relationships: await listSelfCopyRelationships(trader.id) });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("SELF_COPY_UNAVAILABLE", "Self-copy setups are unavailable.", 503);
  }
}

export async function POST(request: Request) {
  try {
    const trader = await requireTrader();
    const parsed = selfCopyCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join(", "), 400);
    }
    const platformAccess = await getPlatformSubscriptionAccess(trader.id);
    if (platformAccess.status !== "ACTIVE") {
      return jsonFail(
        "PLATFORM_SUBSCRIPTION_REQUIRED",
        "Activate your platform subscription before creating self-copy.",
        403,
      );
    }
    const relationship = await createSelfCopyRelationship({
      traderId: trader.id,
      ...parsed.data,
    });
    return jsonOk(relationship, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    if (error instanceof CopyError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("SELF_COPY_CREATE_FAILED", "Self-copy setup could not be created.", 500);
  }
}
