import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader, AuthError } from "@/lib/auth/session";
import { followStrategy } from "@/lib/services/copyTradingService";
import { copyFollowSchema } from "@/lib/validation/schemas";
import { COPY_ERROR, CopyError } from "@/lib/copy/types";
import {
  expireStaleEntitlements,
  getActiveCopyEntitlements,
  getPlatformSubscriptionAccess,
} from "@/lib/services/billingService";

// POST — trader opts in to a strategy with one of their own accounts. Requires
// explicit consent (consentAccepted must be true), an active platform subscription,
// and an active copy entitlement for the selected follower account.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const trader = await requireTrader();
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = copyFollowSchema.safeParse(body);
    if (!parsed.success) {
      const consentIssue = parsed.error.issues.find((i) => i.path[0] === "consentAccepted");
      if (consentIssue) return jsonFail(COPY_ERROR.COPY_CONSENT_REQUIRED, "You must accept the risk disclaimer.", 400);
      return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join(", "), 400);
    }

    // Run expiry check lazily before access check
    await expireStaleEntitlements().catch(() => {});

    const platformAccess = await getPlatformSubscriptionAccess(trader.id);
    if (platformAccess.status !== "ACTIVE") {
      return jsonFail(
        "PLATFORM_SUBSCRIPTION_REQUIRED",
        "Activate your $50/month platform subscription before starting copy trading.",
        403,
      );
    }

    // Billing gate: user must have an active copy entitlement on the selected account
    const entitlements = await getActiveCopyEntitlements(
      trader.id,
      parsed.data.followerAccountId,
      id,
    );
    const entitledTier = entitlements.find((entry) => entry.tier === parsed.data.tier);
    if (!entitledTier) {
      return jsonFail(
        "COPY_ENTITLEMENT_REQUIRED",
        `Purchase this strategy's ${parsed.data.tier === "PREMIUM" ? "Premium / Fast" : "Standard"} monthly subscription for the selected account before following it.`,
        403,
      );
    }

    const result = await followStrategy(trader.id, id, {
      followerAccountId: parsed.data.followerAccountId,
      tier: parsed.data.tier,
      scalingMode: parsed.data.scalingMode,
      riskMultiplier: parsed.data.riskMultiplier,
      fixedLot: parsed.data.fixedLot,
      maxLot: parsed.data.maxLot,
    });
    return jsonOk(result, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof CopyError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
