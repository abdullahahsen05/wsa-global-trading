"use client";

import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  EmptyState,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { BillingCheckoutModal } from "@/components/app/BillingCheckoutModal";
import type { BotProductDto } from "@/lib/domain/types";
import type { UserBillingSummaryDto } from "@/lib/services/billingService";
import { CheckCircle2 } from "lucide-react";

interface PageData {
  product: BotProductDto;
}

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

const ACCESS_STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  ACTIVE: "lime",
  PENDING_APPROVAL: "accent",
  PENDING_PAYMENT: "muted",
  FAILED: "danger",
  CANCELLED: "muted",
};

const BOT_EA_PRODUCT = {
  code: "BOT_EA",
  name: "Trading Bot / EA",
  amount: 500,
  currency: "USD",
  billingInterval: "ONE_TIME",
  description: "One-time purchase — access activates after verified payment.",
};

export default function MarketplaceProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const { data, isLoading, isError } = useQuery<PageData>({
    queryKey: ["marketplace-product", slug],
    queryFn: () => apiFetch(`/api/marketplace/products/${slug}`),
  });

  const { data: billingSummary, isLoading: billingLoading } = useQuery<UserBillingSummaryDto>({
    queryKey: ["billing-me"],
    queryFn: () => apiFetch("/api/billing/me"),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <WorkspacePage eyebrow="Marketplace" title="Loading…" description="">
        <div className="h-48 animate-pulse rounded-[4px] bg-panel" />
      </WorkspacePage>
    );
  }

  if (isError || !data) {
    return (
      <WorkspacePage eyebrow="Marketplace" title="Not found" description="">
        <EmptyState
          title="Product not found"
          description="This product may have been removed or is not yet published."
        />
      </WorkspacePage>
    );
  }

  const { product } = data;
  const purchase = billingSummary?.botAccess.find((entry) => entry.botProductId === product.id);
  const canPurchase =
    !purchase ||
    purchase.status === "NONE" ||
    purchase.status === "FAILED" ||
    purchase.status === "CANCELLED";

  return (
    <WorkspacePage
      eyebrow="Marketplace"
      title={product.name}
      description={product.shortDescription ?? ""}
    >
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="muted">{product.platform}</StatusPill>
            {product.difficulty ? <StatusPill tone="muted">{product.difficulty}</StatusPill> : null}
            {product.riskLevel ? (
              <StatusPill tone={product.riskLevel === "LOW" ? "lime" : product.riskLevel === "HIGH" ? "danger" : "accent"}>
                {product.riskLevel} Risk
              </StatusPill>
            ) : null}
            {product.version ? <StatusPill tone="muted">v{product.version}</StatusPill> : null}
          </div>
          <div className="text-right">
            <p className="text-xl font-bold text-foreground">$500 one-time</p>
            <p className="text-xs text-muted">USD</p>
          </div>
        </div>

        {product.description ? (
          <p className="mt-4 whitespace-pre-wrap text-sm text-muted">{product.description}</p>
        ) : null}

        {product.features && product.features.length > 0 ? (
          <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
            {product.features.map((feature, index) => (
              <li key={index} className="flex items-center gap-2 text-sm text-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-2" />
                {feature}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-6 flex items-center gap-3">
          {billingLoading ? (
            <p className="text-sm text-muted">Checking purchase status…</p>
          ) : canPurchase ? (
            <PrimaryButton type="button" onClick={() => setCheckoutOpen(true)}>
              Buy Bot — $500
            </PrimaryButton>
          ) : purchase ? (
            <div className="flex items-center gap-2">
              <StatusPill tone={ACCESS_STATUS_TONE[purchase.status] ?? "muted"}>
                {purchase.status.replaceAll("_", " ")}
              </StatusPill>
              <p className="text-sm text-muted">
                {purchase.status === "PENDING_APPROVAL"
                  ? "Payment verified. Your bot access is being activated."
                  : purchase.status === "PENDING_PAYMENT"
                    ? "Payment is being confirmed or access is being activated."
                    : purchase.status === "ACTIVE"
                      ? "You have active access to this bot."
                      : purchase.message}
              </p>
            </div>
          ) : null}
        </div>
      </Panel>

      <BillingCheckoutModal
        open={checkoutOpen}
        onClose={() => setCheckoutOpen(false)}
        product={{ ...BOT_EA_PRODUCT, name: `${product.name} — Bot / EA` }}
        botProductId={product.id}
      />
    </WorkspacePage>
  );
}
