import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";

let _stripe: Stripe | null = null;
let _loading: Promise<Stripe> | null = null;

/**
 * The Stripe client. The SDK is large (importing it loads every API resource), while most requests that run through
 * `billingService` - the dashboard's `/api/billing/me`, the order gates - never talk to Stripe at all. So the SDK is
 * loaded the first time a Stripe call is really made, not whenever a route that merely imports the billing code starts:
 * a cold route is ready that much sooner.
 */
export async function getStripe(): Promise<Stripe> {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  _loading ??= import("stripe").then((module_) => {
    const StripeClient = module_.default;
    _stripe = new StripeClient(key, { apiVersion: "2026-06-24.dahlia" });
    return _stripe;
  });
  try {
    return await _loading;
  } catch (error) {
    _loading = null; // (a failed load is tried again on the next call)
    throw error;
  }
}

export async function ensureStripeCustomer(
  userId: string,
  email: string,
  name: string,
): Promise<string> {
  const supabase = createAdminClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.stripe_customer_id) return profile.stripe_customer_id as string;

  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    email,
    name: name || email,
    metadata: { userId },
  });

  await supabase
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", userId);

  return customer.id;
}
