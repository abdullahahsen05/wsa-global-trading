import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/stripeClient";
import {
  handleStripeCheckoutCompleted,
  handleStripeInvoicePaid,
  handleStripeInvoicePaymentFailed,
  handleStripeSubscriptionDeleted,
  handleStripeSubscriptionUpdated,
  handleStripeChargeRefunded,
  expireStaleEntitlements,
  getStripeInvoiceSubscriptionId,
} from "@/lib/services/billingService";
import { createAdminClient } from "@/lib/supabase/admin";

// Next.js must not parse the body — Stripe needs the raw bytes for signature verification.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[stripe/webhook] STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 500 });
  }

  if (!sig) {
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }

  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(rawBody, sig, secret) as unknown as typeof event;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signature verification failed";
    console.warn("[stripe/webhook] invalid signature:", msg);
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // Idempotency: skip already-processed events
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("stripe_webhook_events")
    .select("id, status")
    .eq("stripe_event_id", event.id)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ received: true, skipped: true });
  }

  // Record the event before processing (PROCESSING status)
  await supabase.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    status: "PROCESSING",
  });

  let processingStatus: "PROCESSED" | "IGNORED" | "FAILED" = "IGNORED";
  let errorMessage: string | null = null;

  try {
    const obj = event.data.object as Record<string, unknown>;

    switch (event.type) {
      case "checkout.session.completed":
        await handleStripeCheckoutCompleted({
          id: obj.id as string,
          subscription: (obj.subscription as string | null) ?? null,
          payment_intent: (obj.payment_intent as string | null) ?? null,
        });
        await expireStaleEntitlements().catch(() => {});
        processingStatus = "PROCESSED";
        break;

      case "checkout.session.async_payment_succeeded":
        await handleStripeCheckoutCompleted({
          id: obj.id as string,
          subscription: (obj.subscription as string | null) ?? null,
          payment_intent: (obj.payment_intent as string | null) ?? null,
        });
        processingStatus = "PROCESSED";
        break;

      case "checkout.session.async_payment_failed":
        {
          const sessionId = obj.id as string;
          await supabase
            .from("payment_orders")
            .update({ status: "FAILED" })
            .eq("stripe_checkout_session_id", sessionId)
            .neq("status", "PAID");
          processingStatus = "PROCESSED";
        }
        break;

      case "invoice.paid":
        await handleStripeInvoicePaid({
          subscription: getStripeInvoiceSubscriptionId(obj),
          lines: obj.lines as { data?: Array<{ period?: { start?: number; end?: number } }> },
        });
        processingStatus = "PROCESSED";
        break;

      case "invoice.payment_failed":
        await handleStripeInvoicePaymentFailed(getStripeInvoiceSubscriptionId(obj));
        processingStatus = "PROCESSED";
        break;

      case "customer.subscription.updated":
        await handleStripeSubscriptionUpdated({
          id: obj.id as string,
          cancel_at_period_end: obj.cancel_at_period_end as boolean | undefined,
        });
        processingStatus = "PROCESSED";
        break;

      case "customer.subscription.deleted":
        await handleStripeSubscriptionDeleted(obj.id as string);
        processingStatus = "PROCESSED";
        break;

      case "charge.refunded":
        await handleStripeChargeRefunded((obj.payment_intent as string | null) ?? null);
        processingStatus = "PROCESSED";
        break;

      default:
        processingStatus = "IGNORED";
    }
  } catch (err) {
    processingStatus = "FAILED";
    errorMessage = err instanceof Error ? err.message : "Unknown processing error";
    console.error(`[stripe/webhook] Error processing ${event.type}:`, errorMessage);
    // Still return 200 so Stripe doesn't retry indefinitely
  }

  await supabase
    .from("stripe_webhook_events")
    .update({
      status: processingStatus,
      error_message: errorMessage,
      processed_at: new Date().toISOString(),
    })
    .eq("stripe_event_id", event.id);

  return NextResponse.json({ received: true });
}
