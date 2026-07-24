"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import { SelectField } from "@/components/app/FormFields";
import { GhostButton, PrimaryButton } from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";

export interface CheckoutProduct {
  code: string;
  name: string;
  amount: number;
  currency: string;
  billingInterval: string;
  description?: string;
}

interface BillingCheckoutModalProps {
  open: boolean;
  onClose: () => void;
  product: CheckoutProduct;
  tradingAccountId?: string;
  accounts?: Array<{ accountId: string; accountName: string }>;
  botProductId?: string;
  copyStrategyId?: string;
}

export function BillingCheckoutModal({
  open,
  onClose,
  product,
  tradingAccountId: propAccountId,
  accounts = [],
  botProductId,
  copyStrategyId,
}: BillingCheckoutModalProps) {
  const [selectedAccountId, setSelectedAccountId] = useState(propAccountId ?? "");
  const [apiError, setApiError] = useState("");
  const queryClient = useQueryClient();

  const isCopyProduct = product.code.startsWith("COPY_");
  const autoActivatesAfterPayment = isCopyProduct || product.code === "PLATFORM_MONTHLY";
  const needsAccountSelector = isCopyProduct && !propAccountId && accounts.length > 0;
  const canProceed = !needsAccountSelector || selectedAccountId !== "";

  const checkout = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { productCode: product.code };
      if (isCopyProduct) {
        const accountId = propAccountId ?? selectedAccountId;
        if (!accountId) throw new Error("Please select a trading account");
        body.tradingAccountId = accountId;
        body.tier = product.code === "COPY_ULTRA_FAST" ? "PREMIUM" : "NORMAL";
      }
      if (botProductId) body.botProductId = botProductId;
      if (copyStrategyId) body.copyStrategyId = copyStrategyId;

      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Checkout failed");
      return json.data as { orderId: string; checkoutUrl: string };
    },
    onSuccess: (data) => {
      handleClose();
      queryClient.invalidateQueries({ queryKey: ["billing-me"] });
      window.location.assign(data.checkoutUrl);
    },
    onError: (err: Error) => setApiError(err.message),
  });

  function handleClose() {
    setApiError("");
    setSelectedAccountId(propAccountId ?? "");
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
        <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
          <Dialog.Title className="text-xl font-semibold text-foreground">
            {product.name}
          </Dialog.Title>

          {product.description && (
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              {product.description}
            </Dialog.Description>
          )}

          <div className="mt-4 space-y-2 rounded-[4px] border border-line bg-background px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted">Amount</span>
              <span className="font-semibold text-foreground">
                {formatMoney({ amount: product.amount, currency: product.currency })}
                {product.billingInterval === "MONTHLY" ? " / month" : ""}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Billing</span>
              <span className="text-foreground">
                {product.billingInterval === "MONTHLY"
                  ? isCopyProduct
                    ? "Monthly - renews from verified payment date"
                    : "Monthly - renews from approval date"
                  : "One-time payment"}
              </span>
            </div>
          </div>

          {needsAccountSelector && (
            <div className="mt-3">
              <SelectField
                label="Trading account to activate"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
              >
                <option value="">Select account...</option>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.accountName}
                  </option>
                ))}
              </SelectField>
            </div>
          )}

          <div className="mt-4 flex items-start gap-2 rounded-[4px] border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-muted">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <span>
              {autoActivatesAfterPayment ? (
                <>
                  Access activates automatically only after the server verifies payment with Stripe. A success redirect alone does not grant access.
                </>
              ) : (
                <>
                  Access is activated after payment is confirmed and admin-approved. Stripe test card:{" "}
                  <strong className="font-mono text-foreground">4242 4242 4242 4242</strong>
                </>
              )}
            </span>
          </div>

          {apiError && (
            <p className="mt-3 rounded-[4px] border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
              {apiError}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-3 border-t border-line pt-4">
            <GhostButton type="button" onClick={handleClose}>
              Cancel
            </GhostButton>
            <PrimaryButton
              type="button"
              disabled={checkout.isPending || !canProceed}
              onClick={() => { setApiError(""); checkout.mutate(); }}
            >
              {checkout.isPending
                ? "Processing..."
                : `Pay ${formatMoney({ amount: product.amount, currency: product.currency })}`}
            </PrimaryButton>
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-[4px] border border-line bg-background text-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
