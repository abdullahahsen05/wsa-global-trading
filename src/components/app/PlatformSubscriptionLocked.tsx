"use client";

import Link from "next/link";
import { ShieldCheck, Sparkles } from "lucide-react";
import { Panel, GhostButton } from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionCheckoutCTA } from "@/components/app/PlatformSubscriptionCheckoutCTA";
import type { SubscriptionDto } from "@/lib/services/billingService";

export function PlatformSubscriptionLocked({
  access,
  title = "Platform subscription required",
  description = "Activate the WSA Global platform subscription to unlock this trading workspace feature.",
}: {
  access: SubscriptionDto;
  title?: string;
  description?: string;
}) {
  const helperText =
    access.status === "PENDING_APPROVAL"
      ? "Payment verified — platform activation is finishing."
      : access.status === "PENDING_PAYMENT"
        ? "Your payment is pending confirmation."
        : access.status === "EXPIRED"
          ? "Subscription expired — renew to continue."
          : "Access MT5 account tracking, core trading tools, and workflow features after activation.";

  return (
    <Panel className="border border-accent/30 bg-accent/5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-[4px] bg-accent/15">
            <ShieldCheck className="h-6 w-6 text-accent" />
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Platform Access</p>
          <h2 className="mt-2 text-2xl font-semibold text-foreground">{title}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{description}</p>
          <p className="mt-3 text-base font-semibold text-accent">$50/month</p>
          <p className="mt-2 text-sm text-muted">{helperText}</p>
          {access.status === "ACTIVE" && access.currentPeriodEnd ? (
            <p className="mt-2 text-sm text-muted">
              Renews on {new Date(access.currentPeriodEnd).toLocaleDateString()}.
            </p>
          ) : null}
          {access.status === "EXPIRED" && access.currentPeriodEnd ? (
            <p className="mt-2 text-sm text-muted">
              Last period ended on {new Date(access.currentPeriodEnd).toLocaleDateString()}.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col items-stretch gap-3">
          <PlatformSubscriptionCheckoutCTA access={access} />
          <Link href="/platform-preview">
            <GhostButton type="button">
              <Sparkles className="mr-2 inline-block h-4 w-4" />
              Preview what you unlock
            </GhostButton>
          </Link>
        </div>
      </div>
    </Panel>
  );
}
