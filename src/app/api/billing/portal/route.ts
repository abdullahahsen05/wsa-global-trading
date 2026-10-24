import { NextRequest } from "next/server";
import { requireAuth, AuthError } from "@/lib/auth/session";
import { jsonOk, jsonFail, handleAuthError } from "@/lib/api/envelope";
import { getStripe } from "@/lib/stripe/stripeClient";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth();
    const supabase = createAdminClient();

    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile?.stripe_customer_id) {
      return jsonFail("NO_STRIPE_CUSTOMER", "No Stripe subscription found on this account", 404);
    }

    const origin = req.headers.get("origin") ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
    const stripe = await getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id as string,
      return_url: `${origin}/billing`,
    });

    return jsonOk({ url: session.url });
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError(err);
    const msg = err instanceof Error ? err.message : "Portal session failed";
    return jsonFail("PORTAL_ERROR", msg, 500);
  }
}
