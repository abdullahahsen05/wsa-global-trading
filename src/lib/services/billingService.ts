/**
 * Billing service — orchestrates Stripe Checkout Sessions, payment_orders,
 * subscriptions, copy_account_entitlements, and partner commission ledger.
 * Server-only (do not import in client components).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { buildMockCheckoutUrl, getBillingRuntimeMode } from "@/lib/payments/runtime";
import { getStripe, ensureStripeCustomer } from "@/lib/stripe/stripeClient";
import { getStripePriceId, getStripeCheckoutMode } from "@/lib/stripe/stripeProducts";
import { writeAuditLog } from "@/lib/services/auditService";

function copyTierForProductCode(code: string): "NORMAL" | "PREMIUM" {
  return code === "COPY_ULTRA_FAST" || code.endsWith("_PREMIUM") ? "PREMIUM" : "NORMAL";
}

// ─── Public DTOs ──────────────────────────────────────────────────────────────

export interface BillingProductDto {
  id: string;
  code: string;
  name: string;
  type: "SUBSCRIPTION" | "COPY_ACCOUNT" | "BOT" | "MENTORSHIP" | "EVALUATION";
  amount: number;
  currency: string;
  billingInterval: string;
}

export type BillingAccessState =
  | "NONE"
  | "PENDING_PAYMENT"
  | "PENDING_APPROVAL"
  | "ACTIVE"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED";

export interface BillingAccessSummaryDto {
  status: BillingAccessState;
  orderId: string | null;
  currentPeriodEnd: string | null;
  approvedAt: string | null;
  message: string;
}

export interface PaymentOrderDto {
  id: string;
  productCode: string;
  productName: string;
  amount: number;
  currency: string;
  status: string;
  checkoutUrl: string | null;
  createdAt: string;
  paidAt: string | null;
  botProductId: string | null;
  tradingAccountId: string | null;
}

export interface BotAccessDto extends BillingAccessSummaryDto {
  id: string;
  botProductId: string;
  botName: string;
  grantedAt: string | null;
}

export interface SubscriptionDto extends BillingAccessSummaryDto {
  id: string;
  productCode: string;
  productName: string;
}

export interface CopyEntitlementDto extends BillingAccessSummaryDto {
  id: string;
  tier: string;
  tradingAccountId: string | null;
  strategyId?: string | null;
}

export interface MentorshipAccessDto extends BillingAccessSummaryDto {
  id: string;
  productCode: string;
  productName: string;
}

export interface UserBillingSummaryDto {
  platformSubscription: SubscriptionDto;
  copyEntitlements: CopyEntitlementDto[];
  paymentHistory: PaymentOrderDto[];
  botAccess: BotAccessDto[];
  mentorshipAccess: MentorshipAccessDto;
  pendingApprovals: Array<{
    type: string;
    orderId: string;
    productName: string;
    paidAt: string;
  }>;
}

export type BillingReturnState =
  | "PROCESSING"
  | "PAYMENT_RECEIVED"
  | "PENDING_APPROVAL"
  | "ACTIVE"
  | "FAILED"
  | "CANCELLED";

export interface BillingReturnStatusDto {
  order: PaymentOrderDto;
  state: BillingReturnState;
  title: string;
  message: string;
}

export interface AdminBillingPendingApprovalDto {
  orderId: string;
  userId: string;
  userName: string;
  userEmail: string;
  productCode: string;
  productName: string;
  productType: string;
  amount: number;
  currency: string;
  paidAt: string | null;
}

export interface AdminBillingAccessRecordDto {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  accessType: "SUBSCRIPTION" | "COPY_ACCOUNT" | "BOT" | "MENTORSHIP";
  productName: string;
  status: string;
  scopeLabel: string;
  currentPeriodEnd: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface AdminBillingOverviewDto {
  purchases: Array<{
    id: string;
    userId: string;
    userName: string;
    userEmail: string;
    productCode: string;
    productName: string;
    productType: string;
    amount: number;
    currency: string;
    status: string;
    provider: string;
    intentId: string | null;
    checkoutUrl: string | null;
    tradingAccountId: string | null;
    tier: string | null;
    botProductId: string | null;
    createdAt: string;
    paidAt: string | null;
  }>;
  pendingApprovals: AdminBillingPendingApprovalDto[];
  activeAccess: AdminBillingAccessRecordDto[];
  expiredAccess: AdminBillingAccessRecordDto[];
}

// ─── Access check ────────────────────────────────────────────────────────────

export interface ExistingAccessResult {
  status: BillingAccessState;
  message: string;
}

type SubscriptionAccessRow = {
  id: string;
  status: string;
  currentPeriodEnd: string | null;
  approvedAt: string | null;
  createdAt: string;
  productCode: string;
  productName: string;
};

type CopyEntitlementAccessRow = {
  id: string;
  tier: string;
  status: string;
  tradingAccountId: string | null;
  strategyId?: string | null;
  currentPeriodEnd: string | null;
  approvedAt: string | null;
  createdAt: string;
};

type PaymentOrderAccessRow = {
  id: string;
  status: string;
  createdAt: string;
  productCode?: string;
  productName?: string;
  tradingAccountId?: string | null;
  copyStrategyId?: string | null;
  botProductId?: string | null;
  tier?: string | null;
  approvedAt?: string | null;
};

type BotAccessRecordRow = {
  id: string;
  botProductId: string;
  botName: string;
  status: string;
  grantedAt: string | null;
  createdAt: string;
};

type PaidOrderProvisionRow = {
  id: string;
  user_id: string;
  product_id: string;
  status: string;
  amount: number;
  currency: string;
  trading_account_id: string | null;
  tier: string | null;
  bot_product_id: string | null;
  copy_strategy_id: string | null;
  metadata?: Record<string, unknown> | null;
};

type BillingProductProvisionRow = {
  type: string;
  billing_interval: string;
  code: string;
};

async function ensureTraderProfileId(userId: string): Promise<string> {
  const supabase = createAdminClient();

  const { data: existing, error: existingError } = await supabase
    .from("trader_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to load trader profile: ${existingError.message}`);
  }

  if (existing?.id) return existing.id as string;

  const { data: created, error: createError } = await supabase
    .from("trader_profiles")
    .upsert({ user_id: userId }, { onConflict: "user_id" })
    .select("id")
    .single();

  if (createError || !created?.id) {
    throw new Error(`Failed to provision trader profile: ${createError?.message ?? "missing id"}`);
  }

  return created.id as string;
}

function compareDescByCreatedAt<T extends { createdAt: string }>(a: T, b: T) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function monthlyPeriodEndIso() {
  return new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
}

function isFuture(dateValue: string | null | undefined, nowIso: string) {
  if (!dateValue) return false;
  return new Date(dateValue).getTime() > new Date(nowIso).getTime();
}

function mapTerminalState(status: string | null | undefined): BillingAccessState {
  if (status === "FAILED") return "FAILED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "REFUNDED") return "REFUNDED";
  return "NONE";
}

function defaultMessage(status: BillingAccessState, itemName: string) {
  switch (status) {
    case "PENDING_PAYMENT":
      return "Payment pending";
    case "PENDING_APPROVAL":
      return "Payment received — pending admin approval";
    case "ACTIVE":
      return `${itemName} active`;
    case "EXPIRED":
      return `${itemName} expired`;
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Failed — try again";
    case "REFUNDED":
      return "Refunded";
    default:
      return "";
  }
}

export function canCreateCheckoutForState(status: BillingAccessState, isRenewable: boolean): boolean {
  if (status === "NONE" || status === "FAILED" || status === "CANCELLED" || status === "REFUNDED") {
    return true;
  }
  if (status === "EXPIRED") return isRenewable;
  return false;
}

export function derivePlatformSubscriptionAccess(params: {
  subscriptions: SubscriptionAccessRow[];
  orders: PaymentOrderAccessRow[];
  nowIso: string;
}): SubscriptionDto {
  const subscriptions = [...params.subscriptions].sort(compareDescByCreatedAt);
  const orders = [...params.orders].sort(compareDescByCreatedAt);

  const active = subscriptions.find((sub) => sub.status === "ACTIVE" && isFuture(sub.currentPeriodEnd, params.nowIso));
  if (active) {
    return {
      id: active.id,
      productCode: active.productCode,
      productName: active.productName,
      status: "ACTIVE",
      currentPeriodEnd: active.currentPeriodEnd,
      approvedAt: active.approvedAt,
      orderId: null,
      message: defaultMessage("ACTIVE", active.productName),
    };
  }

  const pendingApprovalSub = subscriptions.find((sub) => sub.status === "PENDING_APPROVAL");
  if (pendingApprovalSub) {
    return {
      id: pendingApprovalSub.id,
      productCode: pendingApprovalSub.productCode,
      productName: pendingApprovalSub.productName,
      status: "PENDING_APPROVAL",
      currentPeriodEnd: pendingApprovalSub.currentPeriodEnd,
      approvedAt: pendingApprovalSub.approvedAt,
      orderId: null,
      message: defaultMessage("PENDING_APPROVAL", pendingApprovalSub.productName),
    };
  }

  const paidOrder = orders.find((order) => order.status === "PAID");
  if (paidOrder) {
    return {
      id: "",
      productCode: paidOrder.productCode ?? "PLATFORM_MONTHLY",
      productName: paidOrder.productName ?? "Platform Subscription",
      status: "PENDING_PAYMENT",
      currentPeriodEnd: null,
      approvedAt: paidOrder.approvedAt ?? null,
      orderId: paidOrder.id,
      message: "Payment verified — activating platform access",
    };
  }

  const pendingOrder = orders.find((order) => order.status === "PENDING");
  if (pendingOrder) {
    return {
      id: "",
      productCode: pendingOrder.productCode ?? "PLATFORM_MONTHLY",
      productName: pendingOrder.productName ?? "Platform Subscription",
      status: "PENDING_PAYMENT",
      currentPeriodEnd: null,
      approvedAt: null,
      orderId: pendingOrder.id,
      message: defaultMessage("PENDING_PAYMENT", "Platform Subscription"),
    };
  }

  const expired = subscriptions.find((sub) =>
    (sub.status === "ACTIVE" || sub.status === "EXPIRED") && sub.currentPeriodEnd && !isFuture(sub.currentPeriodEnd, params.nowIso),
  );
  if (expired) {
    return {
      id: expired.id,
      productCode: expired.productCode,
      productName: expired.productName,
      status: "EXPIRED",
      currentPeriodEnd: expired.currentPeriodEnd,
      approvedAt: expired.approvedAt,
      orderId: null,
      message: defaultMessage("EXPIRED", expired.productName),
    };
  }

  const terminal = orders.find((order) => mapTerminalState(order.status) !== "NONE");
  const terminalState = mapTerminalState(terminal?.status);
  return {
    id: "",
    productCode: terminal?.productCode ?? "PLATFORM_MONTHLY",
    productName: terminal?.productName ?? "Platform Subscription",
    status: terminalState,
    currentPeriodEnd: null,
    approvedAt: terminal?.approvedAt ?? null,
    orderId: terminal?.id ?? null,
    message: defaultMessage(terminalState, "Platform Subscription"),
  };
}

export function deriveCopyEntitlementAccess(params: {
  tradingAccountId: string;
  strategyId?: string | null;
  entitlements: CopyEntitlementAccessRow[];
  orders: PaymentOrderAccessRow[];
  nowIso: string;
}): CopyEntitlementDto {
  const strategyId = params.strategyId ?? null;
  const entitlements = params.entitlements
    .filter((entry) => entry.tradingAccountId === params.tradingAccountId && (entry.strategyId ?? null) === strategyId)
    .sort(compareDescByCreatedAt);
  const orders = params.orders
    .filter((order) => order.tradingAccountId === params.tradingAccountId && (order.copyStrategyId ?? null) === strategyId)
    .sort(compareDescByCreatedAt);

  const active = entitlements.find((entry) => entry.status === "ACTIVE" && isFuture(entry.currentPeriodEnd, params.nowIso));
  if (active) {
    return {
      id: active.id,
      tier: active.tier,
      tradingAccountId: active.tradingAccountId,
      strategyId: active.strategyId,
      status: "ACTIVE",
      currentPeriodEnd: active.currentPeriodEnd,
      approvedAt: active.approvedAt,
      orderId: null,
      message: defaultMessage("ACTIVE", "Copy trading access"),
    };
  }

  const pendingApprovalEntry = entitlements.find((entry) => entry.status === "PENDING_APPROVAL");
  if (pendingApprovalEntry) {
    return {
      id: pendingApprovalEntry.id,
      tier: pendingApprovalEntry.tier,
      tradingAccountId: pendingApprovalEntry.tradingAccountId,
      strategyId: pendingApprovalEntry.strategyId,
      status: "PENDING_APPROVAL",
      currentPeriodEnd: pendingApprovalEntry.currentPeriodEnd,
      approvedAt: pendingApprovalEntry.approvedAt,
      orderId: null,
      message: defaultMessage("PENDING_APPROVAL", "Copy trading access"),
    };
  }

  const paidOrder = orders.find((order) => order.status === "PAID");
  if (paidOrder) {
    return {
      id: "",
      tier: paidOrder.tier ?? "NORMAL",
      tradingAccountId: params.tradingAccountId,
      strategyId,
      status: "PENDING_PAYMENT",
      currentPeriodEnd: null,
      approvedAt: paidOrder.approvedAt ?? null,
      orderId: paidOrder.id,
      message: "Payment verified. Copy access activation is still processing.",
    };
  }

  const pendingOrder = orders.find((order) => order.status === "PENDING");
  if (pendingOrder) {
    return {
      id: "",
      tier: pendingOrder.tier ?? "NORMAL",
      tradingAccountId: params.tradingAccountId,
      strategyId,
      status: "PENDING_PAYMENT",
      currentPeriodEnd: null,
      approvedAt: null,
      orderId: pendingOrder.id,
      message: defaultMessage("PENDING_PAYMENT", "Copy trading access"),
    };
  }

  const expired = entitlements.find((entry) =>
    (entry.status === "ACTIVE" || entry.status === "EXPIRED") && entry.currentPeriodEnd && !isFuture(entry.currentPeriodEnd, params.nowIso),
  );
  if (expired) {
    return {
      id: expired.id,
      tier: expired.tier,
      tradingAccountId: expired.tradingAccountId,
      strategyId: expired.strategyId,
      status: "EXPIRED",
      currentPeriodEnd: expired.currentPeriodEnd,
      approvedAt: expired.approvedAt,
      orderId: null,
      message: defaultMessage("EXPIRED", "Copy trading access"),
    };
  }

  const terminal = orders.find((order) => mapTerminalState(order.status) !== "NONE");
  const terminalState = mapTerminalState(terminal?.status);
  return {
    id: "",
    tier: terminal?.tier ?? "NORMAL",
    tradingAccountId: params.tradingAccountId,
    strategyId,
    status: terminalState,
    currentPeriodEnd: null,
    approvedAt: terminal?.approvedAt ?? null,
    orderId: terminal?.id ?? null,
    message: defaultMessage(terminalState, "Copy trading access"),
  };
}

export function deriveBotPurchaseAccess(params: {
  botProductId: string;
  botName: string;
  accessRecords: BotAccessRecordRow[];
  orders: PaymentOrderAccessRow[];
}): BotAccessDto {
  const accessRecords = params.accessRecords
    .filter((entry) => entry.botProductId === params.botProductId)
    .sort(compareDescByCreatedAt);
  const orders = params.orders
    .filter((order) => order.botProductId === params.botProductId)
    .sort(compareDescByCreatedAt);

  const active = accessRecords.find((entry) => entry.status === "ACTIVE");
  if (active) {
    return {
      id: active.id,
      botProductId: active.botProductId,
      botName: active.botName,
      status: "ACTIVE",
      currentPeriodEnd: null,
      approvedAt: active.grantedAt,
      grantedAt: active.grantedAt,
      orderId: null,
      message: defaultMessage("ACTIVE", "Bot access"),
    };
  }

  const paidOrder = orders.find((order) => order.status === "PAID");
  const requested = accessRecords.find((entry) => entry.status === "REQUESTED");
  if (requested && paidOrder) {
    return {
      id: requested.id,
      botProductId: requested.botProductId,
      botName: requested.botName,
      status: "PENDING_PAYMENT",
      currentPeriodEnd: null,
      approvedAt: null,
      grantedAt: requested.grantedAt,
      orderId: paidOrder.id,
      message: "Payment confirmed. Bot access is being activated.",
    };
  }

  if (paidOrder) {
    return {
      id: "",
      botProductId: params.botProductId,
      botName: params.botName,
      status: "PENDING_PAYMENT",
      currentPeriodEnd: null,
      approvedAt: paidOrder.approvedAt ?? null,
      grantedAt: null,
      orderId: paidOrder.id,
      message: "Payment confirmed. Bot access is being activated.",
    };
  }

  const pendingOrder = orders.find((order) => order.status === "PENDING");
  if (pendingOrder) {
    return {
      id: "",
      botProductId: params.botProductId,
      botName: params.botName,
      status: "PENDING_PAYMENT",
      currentPeriodEnd: null,
      approvedAt: null,
      grantedAt: null,
      orderId: pendingOrder.id,
      message: defaultMessage("PENDING_PAYMENT", "Bot access"),
    };
  }

  const terminal = orders.find((order) => mapTerminalState(order.status) !== "NONE");
  const terminalState = mapTerminalState(terminal?.status);
  return {
    id: "",
    botProductId: params.botProductId,
    botName: params.botName,
    status: terminalState,
    currentPeriodEnd: null,
    approvedAt: terminal?.approvedAt ?? null,
    grantedAt: null,
    orderId: terminal?.id ?? null,
    message: defaultMessage(terminalState, "Bot access"),
  };
}

export function deriveMentorshipAccess(params: {
  orders: PaymentOrderAccessRow[];
}): MentorshipAccessDto {
  const orders = [...params.orders].sort(compareDescByCreatedAt);
  const latest = orders[0];
  if (!latest) {
    return {
      id: "",
      productCode: "MENTORSHIP_1_1",
      productName: "1-to-1 Professional Mentorship",
      status: "NONE",
      currentPeriodEnd: null,
      approvedAt: null,
      orderId: null,
      message: "",
    };
  }

  const status: BillingAccessState =
    latest.approvedAt
      ? "ACTIVE"
      : latest.status === "PAID"
        ? "PENDING_APPROVAL"
        : latest.status === "PENDING"
          ? "PENDING_PAYMENT"
          : mapTerminalState(latest.status);

  return {
    id: latest.id,
    productCode: latest.productCode ?? "MENTORSHIP_1_1",
    productName: latest.productName ?? "1-to-1 Professional Mentorship",
    status,
    currentPeriodEnd: null,
    approvedAt: latest.approvedAt ?? null,
    orderId: latest.id,
    message: defaultMessage(status, "Mentorship access"),
  };
}

export async function getPlatformSubscriptionAccess(userId: string): Promise<SubscriptionDto> {
  const summary = await getTraderAccessSummary(userId);
  return summary.platformSubscription;
}

export async function getCopyEntitlementAccess(
  userId: string,
  tradingAccountId: string,
  strategyId?: string,
): Promise<CopyEntitlementDto> {
  const summary = await getTraderAccessSummary(userId);
  return (
    summary.copyEntitlements.find((entry) =>
      entry.tradingAccountId === tradingAccountId && (!strategyId || entry.strategyId === strategyId),
    ) ?? {
      id: "",
      tier: "NORMAL",
      tradingAccountId,
      strategyId: strategyId ?? null,
      status: "NONE",
      currentPeriodEnd: null,
      approvedAt: null,
      orderId: null,
      message: "",
    }
  );
}

export async function getBotPurchaseAccess(userId: string, botProductId: string): Promise<BotAccessDto> {
  const summary = await getTraderAccessSummary(userId);
  return (
    summary.botAccess.find((entry) => entry.botProductId === botProductId) ?? {
      id: "",
      botProductId,
      botName: "Trading Bot / EA",
      status: "NONE",
      currentPeriodEnd: null,
      approvedAt: null,
      grantedAt: null,
      orderId: null,
      message: "",
    }
  );
}

export async function getMentorshipAccess(userId: string): Promise<MentorshipAccessDto> {
  const summary = await getTraderAccessSummary(userId);
  return summary.mentorshipAccess;
}

/** Returns NONE if the user may purchase; otherwise returns the blocking status. */
export async function checkExistingAccess(
  userId: string,
  productCode: string,
  options?: { tradingAccountId?: string; botProductId?: string; copyStrategyId?: string },
): Promise<ExistingAccessResult> {
  const product = await getProductByCode(productCode);
  if (!product) return { status: "NONE", message: "" };

  if (product.type === "SUBSCRIPTION") {
    const access = await getPlatformSubscriptionAccess(userId);
    return { status: access.status, message: access.message };
  }

  if (product.type === "COPY_ACCOUNT") {
    if (!options?.tradingAccountId) {
      return { status: "NONE", message: "Trading account is required" };
    }
    const access = await getCopyEntitlementAccess(userId, options.tradingAccountId, options.copyStrategyId);
    return { status: access.status, message: access.message };
  }

  if (product.type === "BOT") {
    if (options?.botProductId) {
      const access = await getBotPurchaseAccess(userId, options.botProductId);
      return { status: access.status, message: access.message };
    }
    return { status: "NONE", message: "" };
  }

  if (product.type === "EVALUATION") {
    return { status: "NONE", message: "" };
  }

  const access = await getMentorshipAccess(userId);
  return { status: access.status, message: access.message };
}

// ─── Product lookup ───────────────────────────────────────────────────────────

export async function getBillingProducts(): Promise<BillingProductDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("billing_products")
    .select("id, code, name, type, amount, currency, billing_interval")
    .eq("active", true)
    .order("amount");
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    type: p.type,
    amount: Number(p.amount),
    currency: p.currency,
    billingInterval: p.billing_interval,
  }));
}

export async function getProductByCode(code: string): Promise<BillingProductDto | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("billing_products")
    .select("id, code, name, type, amount, currency, billing_interval")
    .eq("code", code)
    .eq("active", true)
    .single();
  if (error || !data) return null;
  return {
    id: data.id,
    code: data.code,
    name: data.name,
    type: data.type,
    amount: Number(data.amount),
    currency: data.currency,
    billingInterval: data.billing_interval,
  };
}

// ─── Create checkout session ──────────────────────────────────────────────────

export interface CreateCheckoutParams {
  userId: string;
  userEmail: string;
  userName: string;
  productCode: string;
  /** Required for COPY_ACCOUNT products */
  tradingAccountId?: string;
  /** Required for a published, per-strategy WSA live-copy subscription. */
  copyStrategyId?: string;
  /** NORMAL or PREMIUM for copy products */
  tier?: string;
  /** Required for BOT products — the bot_products.id */
  botProductId?: string;
  /** Full URL Airwallex redirects to after payment */
  returnUrl: string;
}

export interface CheckoutResult {
  orderId: string;
  checkoutUrl: string;
}

export async function resumePendingCheckoutSession(params: {
  userId: string;
  productId: string;
  tradingAccountId?: string;
  copyStrategyId?: string;
  botProductId?: string;
}): Promise<CheckoutResult | null> {
  const supabase = createAdminClient();
  let query = supabase
    .from("payment_orders")
    .select("id, provider, provider_checkout_url, stripe_checkout_session_id")
    .eq("user_id", params.userId)
    .eq("product_id", params.productId)
    .eq("status", "PENDING")
    .order("created_at", { ascending: false })
    .limit(1);

  query = params.tradingAccountId
    ? query.eq("trading_account_id", params.tradingAccountId)
    : query.is("trading_account_id", null);
  query = params.copyStrategyId
    ? query.eq("copy_strategy_id", params.copyStrategyId)
    : query.is("copy_strategy_id", null);
  query = params.botProductId
    ? query.eq("bot_product_id", params.botProductId)
    : query.is("bot_product_id", null);

  const { data: order, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to load pending checkout: ${error.message}`);
  if (!order) return null;

  const checkoutUrl = order.provider_checkout_url as string | null;
  const stripeSessionId = order.stripe_checkout_session_id as string | null;

  if (order.provider !== "STRIPE") {
    return checkoutUrl ? { orderId: order.id, checkoutUrl } : null;
  }

  if (!stripeSessionId || !checkoutUrl) {
    await supabase.from("payment_orders").update({ status: "FAILED" }).eq("id", order.id).eq("status", "PENDING");
    return null;
  }

  try {
    const session = await getStripe().checkout.sessions.retrieve(stripeSessionId);
    if (session.status === "open") {
      return { orderId: order.id, checkoutUrl: session.url ?? checkoutUrl };
    }

    if (session.status === "complete" && session.payment_status === "paid") {
      await handleStripeCheckoutCompleted({
        id: session.id,
        subscription: typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null,
        payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      });
      throw new Error("Payment is already complete. Refresh the page to use your activated access.");
    }

    await supabase.from("payment_orders").update({ status: "CANCELLED" }).eq("id", order.id).eq("status", "PENDING");
    return null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Payment is already complete")) throw error;
    // A transient Stripe API problem should not lock the trader out of an
    // otherwise valid hosted Checkout URL.
    return { orderId: order.id, checkoutUrl };
  }
}

export type VerifiedPaymentProvisioningDecision =
  | { kind: "SUBSCRIPTION"; status: "ACTIVE" }
  | { kind: "COPY_ACCOUNT"; status: "ACTIVE" }
  | { kind: "BOT"; status: "ACTIVE" }
  | { kind: "MANUAL"; status: null };

export function getVerifiedPaymentProvisioningDecision(
  productType: BillingProductDto["type"],
): VerifiedPaymentProvisioningDecision {
  if (productType === "SUBSCRIPTION") return { kind: "SUBSCRIPTION", status: "ACTIVE" };
  if (productType === "COPY_ACCOUNT") return { kind: "COPY_ACCOUNT", status: "ACTIVE" };
  if (productType === "BOT") return { kind: "BOT", status: "ACTIVE" };
  return { kind: "MANUAL", status: null };
}

async function ensurePaidOrderProvisioned(
  order: PaidOrderProvisionRow,
  product: BillingProductProvisionRow,
): Promise<void> {
  const supabase = createAdminClient();
  const periodEnd = product.billing_interval === "MONTHLY" ? monthlyPeriodEndIso() : null;

  if (product.type === "SUBSCRIPTION") {
    const decision = getVerifiedPaymentProvisioningDecision(product.type);
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("id, status")
      .eq("payment_order_id", order.id)
      .maybeSingle();

    const activatedAt = new Date().toISOString();
    if (!existing) {
      const traderProfileId = await ensureTraderProfileId(order.user_id);
      const { error: insertError } = await supabase.from("subscriptions").insert({
        trader_profile_id: traderProfileId,
        plan_name: product.code === "PLATFORM_MONTHLY" ? "Platform Subscription" : product.code,
        starts_at: activatedAt,
        started_at: activatedAt,
        ends_at: periodEnd,
        user_id: order.user_id,
        product_id: order.product_id,
        payment_order_id: order.id,
        status: decision.status,
        approved_at: activatedAt,
        approved_by_admin_id: null,
        current_period_end: periodEnd,
      });
      if (insertError) {
        throw new Error(`Failed to provision subscription access: ${insertError.message}`);
      }
    } else if (existing.status === "PENDING_APPROVAL") {
      const { error: updateError } = await supabase
        .from("subscriptions")
        .update({
          status: decision.status,
          approved_at: activatedAt,
          approved_by_admin_id: null,
        })
        .eq("id", existing.id);
      if (updateError) {
        throw new Error(`Failed to activate subscription access: ${updateError.message}`);
      }
    }
    return;
  }

  if (product.type === "COPY_ACCOUNT") {
    const decision = getVerifiedPaymentProvisioningDecision(product.type);
    const { data: existing } = await supabase
      .from("copy_account_entitlements")
      .select("id, status")
      .eq("payment_order_id", order.id)
      .maybeSingle();

    const activatedAt = new Date().toISOString();
    if (!existing) {
      const { error: insertError } = await supabase.from("copy_account_entitlements").insert({
        user_id: order.user_id,
        trading_account_id: order.trading_account_id,
        strategy_id: order.copy_strategy_id,
        payment_order_id: order.id,
        tier: order.tier ?? copyTierForProductCode(product.code),
        status: decision.status,
        amount: order.amount,
        currency: order.currency,
        current_period_end: periodEnd,
        approved_at: activatedAt,
      });
      if (insertError) {
        throw new Error(`Failed to provision copy entitlement: ${insertError.message}`);
      }
    } else if (existing.status !== "ACTIVE") {
      const { error: updateError } = await supabase
        .from("copy_account_entitlements")
        .update({
          status: decision.status,
          current_period_end: periodEnd,
          approved_at: activatedAt,
          approved_by_admin_id: null,
        })
        .eq("id", existing.id);
      if (updateError) {
        throw new Error(`Failed to activate copy entitlement: ${updateError.message}`);
      }
    }
    await ensureActiveCopyFollowerForPaidOrder(order);
    return;
  }

  if (product.type === "BOT" && order.bot_product_id) {
    const decision = getVerifiedPaymentProvisioningDecision(product.type);
    const activatedAt = new Date().toISOString();
    const { data: existing } = await supabase
      .from("bot_access_records")
      .select("id, status")
      .eq("user_id", order.user_id)
      .eq("product_id", order.bot_product_id)
      .maybeSingle();

    if (!existing) {
      const { error: insertError } = await supabase.from("bot_access_records").insert({
        product_id: order.bot_product_id,
        user_id: order.user_id,
        status: decision.status,
        source: "FUTURE_PAYMENT",
        price_amount: order.amount,
        price_currency: order.currency,
        granted_by: null,
        granted_at: activatedAt,
      });
      if (insertError) {
        throw new Error(`Failed to provision bot access: ${insertError.message}`);
      }
      return;
    }

    if (existing.status !== "ACTIVE") {
      const { error: updateError } = await supabase
        .from("bot_access_records")
        .update({
          status: decision.status,
          source: "FUTURE_PAYMENT",
          price_amount: order.amount,
          price_currency: order.currency,
          granted_by: null,
          granted_at: activatedAt,
        })
        .eq("id", existing.id);
      if (updateError) {
        throw new Error(`Failed to activate bot access: ${updateError.message}`);
      }
    }
  }
}

async function ensureActiveCopyFollowerForPaidOrder(order: PaidOrderProvisionRow): Promise<void> {
  if (!order.copy_strategy_id || !order.trading_account_id) return;
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const [{ data: strategy }, { data: account }] = await Promise.all([
    supabase
      .from("copy_strategies")
      .select("id, status, live_enabled, engine_status")
      .eq("id", order.copy_strategy_id)
      .maybeSingle(),
    supabase
      .from("trading_accounts")
      .select("id, user_id, status, account_usage, provider_account_id")
      .eq("id", order.trading_account_id)
      .maybeSingle(),
  ]);

  if (!strategy || strategy.status !== "ACTIVE" || !strategy.live_enabled || strategy.engine_status !== "LIVE") return;
  if (
    !account
    || account.user_id !== order.user_id
    || account.account_usage !== "TRADER"
    || account.status !== "CONNECTED"
    || !account.provider_account_id
  ) {
    return;
  }

  const { error } = await supabase
    .from("copy_strategy_followers")
    .upsert(
      {
        strategy_id: order.copy_strategy_id,
        follower_account_id: order.trading_account_id,
        trader_id: order.user_id,
        tier: order.tier ?? "NORMAL",
        status: "ACTIVE",
        scaling_mode: "EQUITY_PROPORTIONAL",
        copy_enabled: true,
        copy_mode: "LOT_MULTIPLIER",
        lot_multiplier: 1,
        risk_multiplier: 1,
        copy_new_trades_only: true,
        copy_existing_trades: false,
        pause_on_disconnect: true,
        emergency_stop: false,
        engine_status: "LIVE",
        engine_error: null,
        engine_synced_at: now,
        consent_accepted_at: now,
        paused_at: null,
      },
      { onConflict: "strategy_id,follower_account_id" },
    );
  if (error) throw new Error(`Failed to activate copy follower: ${error.message}`);
}

async function activateVerifiedPaidCopyFollowers(userId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: paidOrders } = await supabase
    .from("payment_orders")
    .select("id, user_id, product_id, status, amount, currency, trading_account_id, copy_strategy_id, tier, bot_product_id")
    .eq("user_id", userId)
    .eq("status", "PAID")
    .not("trading_account_id", "is", null)
    .not("copy_strategy_id", "is", null);

  for (const order of paidOrders ?? []) {
    await ensureActiveCopyFollowerForPaidOrder(order as PaidOrderProvisionRow);
  }
}

async function markOrderPaid(orderId: string): Promise<void> {
  const supabase = createAdminClient();

  const { data: order, error: orderErr } = await supabase
    .from("payment_orders")
    .select("id, user_id, product_id, status, amount, currency, trading_account_id, tier, bot_product_id, copy_strategy_id, metadata")
    .eq("id", orderId)
    .single();

  if (orderErr || !order) {
    console.warn(`[billing] markOrderPaid: no order for ${orderId}`);
    return;
  }

  if (order.status !== "PAID") {
    await supabase
      .from("payment_orders")
      .update({ status: "PAID", paid_at: new Date().toISOString() })
      .eq("id", order.id);
  }

  const { data: product } = await supabase
    .from("billing_products")
    .select("type, billing_interval, code")
    .eq("id", order.product_id)
    .single();

  if (!product) return;

  await ensurePaidOrderProvisioned(order as PaidOrderProvisionRow, product as BillingProductProvisionRow);
  await maybeCreatePartnerCommission(order.user_id, order.id, order.amount, order.currency);
}

export async function createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutResult> {
  const product = await getProductByCode(params.productCode);
  if (!product) throw new Error("Product not found or inactive");
  if (product.billingInterval === "FREE") throw new Error("This product is free — no payment needed");
  if (product.type === "COPY_ACCOUNT" && !params.tradingAccountId) {
    throw new Error("Trading account is required for copy trading access");
  }
  if (product.code.startsWith("COPY_STRATEGY_") && !params.copyStrategyId) {
    throw new Error("Copy strategy is required for this subscription");
  }
  if (product.type === "BOT" && !params.botProductId) {
    throw new Error("Bot product is required for this purchase");
  }

  const supabase = createAdminClient();

  if (product.type === "COPY_ACCOUNT") {
    const [{ data: account }, platformAccess, strategyResult] = await Promise.all([
      supabase
        .from("trading_accounts")
        .select("id, user_id")
        .eq("id", params.tradingAccountId!)
        .eq("user_id", params.userId)
        .maybeSingle(),
      getPlatformSubscriptionAccess(params.userId),
      params.copyStrategyId
        ? supabase
            .from("copy_strategies")
            .select("id, billing_product_id, standard_billing_product_id, premium_billing_product_id, status, live_enabled, engine_status")
            .eq("id", params.copyStrategyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (!account) throw new Error("Trading account not found or access denied");
    if (platformAccess.status !== "ACTIVE") {
      throw new Error("An active platform subscription is required before purchasing copy access");
    }
    if (params.copyStrategyId) {
      const strategy = strategyResult.data;
      const strategyProductIds = strategy
        ? [strategy.billing_product_id, strategy.standard_billing_product_id, strategy.premium_billing_product_id]
        : [];
      if (!strategy || !strategyProductIds.includes(product.id) || strategy.status !== "ACTIVE" || !strategy.live_enabled || strategy.engine_status !== "LIVE") {
        throw new Error("This copy strategy is not available for live subscriptions");
      }
    }
    params.tier = copyTierForProductCode(product.code);
  }
  const runtimeMode = getBillingRuntimeMode({ BILLING_PROVIDER: process.env.BILLING_PROVIDER });

  // Create the payment_order record first (PENDING)
  const { data: order, error: orderErr } = await supabase
    .from("payment_orders")
    .insert({
      user_id: params.userId,
      product_id: product.id,
      amount: product.amount,
      currency: product.currency,
      status: "PENDING",
      provider: runtimeMode === "mock" ? "MOCK" : "STRIPE",
      trading_account_id: params.tradingAccountId ?? null,
      tier: params.tier ?? null,
      bot_product_id: params.botProductId ?? null,
      copy_strategy_id: params.copyStrategyId ?? null,
      metadata: { checkoutMode: runtimeMode },
    })
    .select("id")
    .single();

  if (orderErr || !order) throw new Error(`Failed to create payment order: ${orderErr?.message}`);

  // MOCK MODE: bypass Stripe, mark order PENDING with a local mock URL.
  // The return page calls /api/billing/mock-confirm to simulate payment success.
  if (runtimeMode === "mock") {
    const mockIntentId = `mock_${order.id}`;
    const mockCheckoutUrl = buildMockCheckoutUrl(params.returnUrl, order.id);
    await supabase
      .from("payment_orders")
      .update({
        provider_payment_intent_id: mockIntentId,
        provider_checkout_url: mockCheckoutUrl,
      })
      .eq("id", order.id);
    return { orderId: order.id, checkoutUrl: mockCheckoutUrl };
  }

  // STRIPE MODE: create a hosted Checkout Session.
  const stripe = getStripe();
  const stripeCustomerId = await ensureStripeCustomer(params.userId, params.userEmail, params.userName);
  const checkoutMode = getStripeCheckoutMode(product.billingInterval);
  const origin = new URL(params.returnUrl).origin;

  const session = await stripe.checkout.sessions.create({
    mode: checkoutMode,
    customer: stripeCustomerId,
    line_items: params.copyStrategyId
      ? [{
          price_data: {
            currency: product.currency.toLowerCase(),
            unit_amount: Math.round(product.amount * 100),
            recurring: { interval: "month" },
            product_data: { name: product.name },
          },
          quantity: 1,
        }]
      : [{ price: getStripePriceId(params.productCode), quantity: 1 }],
    success_url: `${params.returnUrl}?orderId=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/billing?checkout=cancelled`,
    client_reference_id: order.id,
    metadata: {
      localOrderId: order.id,
      userId: params.userId,
      productCode: params.productCode,
      ...(params.tradingAccountId ? { tradingAccountId: params.tradingAccountId } : {}),
      ...(params.copyStrategyId ? { copyStrategyId: params.copyStrategyId } : {}),
      ...(params.botProductId ? { botProductId: params.botProductId } : {}),
    },
  });

  await supabase
    .from("payment_orders")
    .update({
      stripe_checkout_session_id: session.id,
      stripe_customer_id: stripeCustomerId,
      provider_checkout_url: session.url,
    })
    .eq("id", order.id);

  return { orderId: order.id, checkoutUrl: session.url! };
}

// ─── Stripe event handlers ────────────────────────────────────────────────────

/** Called from the Stripe webhook when checkout.session.completed fires. */
export async function handleStripeCheckoutCompleted(session: {
  id: string;
  subscription?: string | null;
  payment_intent?: string | null;
}): Promise<void> {
  const supabase = createAdminClient();

  const { data: order } = await supabase
    .from("payment_orders")
    .select("id, status")
    .eq("stripe_checkout_session_id", session.id)
    .maybeSingle();

  if (!order) {
    console.warn(`[stripe] handleStripeCheckoutCompleted: no order for session ${session.id}`);
    return;
  }

  // Update Stripe-specific IDs before provisioning
  await supabase
    .from("payment_orders")
    .update({
      ...(session.subscription ? { stripe_subscription_id: session.subscription } : {}),
      ...(session.payment_intent ? { stripe_payment_intent_id: session.payment_intent } : {}),
    })
    .eq("id", order.id);

  await markOrderPaid(order.id);

  // Link stripe_subscription_id to subscription/entitlement rows
  if (session.subscription) {
    await supabase
      .from("subscriptions")
      .update({ stripe_subscription_id: session.subscription })
      .eq("payment_order_id", order.id);

    await supabase
      .from("copy_account_entitlements")
      .update({ stripe_subscription_id: session.subscription })
      .eq("payment_order_id", order.id);
  }
}

/** Called on invoice.paid — extends current_period_end for active subscriptions. */
export async function handleStripeInvoicePaid(invoice: {
  subscription?: string | null;
  lines?: { data?: Array<{ period?: { start?: number; end?: number } }> };
}): Promise<void> {
  if (!invoice.subscription) return;
  const supabase = createAdminClient();

  const periodData = invoice.lines?.data?.[0]?.period;
  const newPeriodEnd = periodData?.end
    ? new Date(periodData.end * 1000).toISOString()
    : monthlyPeriodEndIso();
  const newPeriodStart = periodData?.start
    ? new Date(periodData.start * 1000).toISOString()
    : new Date().toISOString();

  // Only extend ACTIVE rows — renewals don't need re-approval
  await Promise.all([
    supabase
      .from("subscriptions")
      .update({ current_period_start: newPeriodStart, current_period_end: newPeriodEnd })
      .eq("stripe_subscription_id", invoice.subscription)
      .eq("status", "ACTIVE"),

    supabase
      .from("copy_account_entitlements")
      .update({ current_period_start: newPeriodStart, current_period_end: newPeriodEnd })
      .eq("stripe_subscription_id", invoice.subscription)
      .eq("status", "ACTIVE"),
  ]);
}

/** Called on customer.subscription.deleted — cancels local subscription. */
export async function handleStripeSubscriptionDeleted(stripeSubscriptionId: string): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data: liveCopyEntitlements } = await supabase
    .from("copy_account_entitlements")
    .select("strategy_id, trading_account_id")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .in("status", ["ACTIVE", "PENDING_APPROVAL"])
    .not("strategy_id", "is", null);

  await Promise.all([
    supabase
      .from("subscriptions")
      .update({ status: "CANCELLED", cancelled_at: now })
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .in("status", ["ACTIVE", "PENDING_APPROVAL"]),

    supabase
      .from("copy_account_entitlements")
      .update({ status: "CANCELLED" })
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .in("status", ["ACTIVE", "PENDING_APPROVAL"]),
  ]);

  for (const entitlement of liveCopyEntitlements ?? []) {
    if (!entitlement.strategy_id || !entitlement.trading_account_id) continue;
    await supabase
      .from("copy_strategy_followers")
      .update({ status: "REVOKED", engine_status: "REMOVED", engine_error: null })
      .eq("strategy_id", entitlement.strategy_id)
      .eq("follower_account_id", entitlement.trading_account_id);
  }
}

/** Called on customer.subscription.updated — syncs cancel_at_period_end flag. */
export async function handleStripeSubscriptionUpdated(subscription: {
  id: string;
  cancel_at_period_end?: boolean;
}): Promise<void> {
  if (subscription.cancel_at_period_end === undefined) return;
  const supabase = createAdminClient();

  await Promise.all([
    supabase
      .from("subscriptions")
      .update({ cancel_at_period_end: subscription.cancel_at_period_end })
      .eq("stripe_subscription_id", subscription.id),

    supabase
      .from("copy_account_entitlements")
      .update({ cancel_at_period_end: subscription.cancel_at_period_end })
      .eq("stripe_subscription_id", subscription.id),
  ]);
}

/** Called on invoice.payment_failed — logs without extending access. */
export async function handleStripeInvoicePaymentFailed(stripeSubscriptionId: string | null): Promise<void> {
  if (!stripeSubscriptionId) return;
  console.warn(`[stripe] invoice.payment_failed for subscription ${stripeSubscriptionId}`);
  // Access is preserved until current_period_end; expireStaleEntitlements() handles the rest.
}

/** Called on charge.refunded — marks order REFUNDED and logs it. */
export async function handleStripeChargeRefunded(paymentIntentId: string | null): Promise<void> {
  if (!paymentIntentId) return;
  const supabase = createAdminClient();
  await supabase
    .from("payment_orders")
    .update({ status: "REFUNDED" })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .neq("status", "REFUNDED");
}

// ─── Webhook: handle payment succeeded ───────────────────────────────────────

export async function handlePaymentSucceeded(intentId: string): Promise<void> {
  const supabase = createAdminClient();

  // Find the order (idempotent — already PAID means skip)
  const { data: order, error: orderErr } = await supabase
    .from("payment_orders")
    .select("id, user_id, product_id, status, amount, currency, trading_account_id, tier, bot_product_id")
    .eq("provider_payment_intent_id", intentId)
    .single();

  if (orderErr || !order) {
    console.warn(`[billing] handlePaymentSucceeded: no order for intent ${intentId}`);
    return;
  }
  await markOrderPaid(order.id);
  return;
  /*

  // Mark order as PAID
  await supabase
    .from("payment_orders")
    .update({ status: "PAID", paid_at: new Date().toISOString() })
    .eq("id", order.id);

  // Get product type
  const { data: product } = await supabase
    .from("billing_products")
    .select("type, billing_interval, code")
    .eq("id", order.product_id)
    .single();

  if (!product) return;

  const pEnd = product.billing_interval === "MONTHLY"
    ? new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  if (product.type === "SUBSCRIPTION") {
    await supabase.from("subscriptions").insert({
      user_id: order.user_id,
      product_id: order.product_id,
      payment_order_id: order.id,
      status: "PENDING_APPROVAL",
      current_period_end: pEnd,
    });
  } else if (product.type === "COPY_ACCOUNT") {
    await supabase.from("copy_account_entitlements").insert({
      user_id: order.user_id,
      trading_account_id: order.trading_account_id ?? null,
      payment_order_id: order.id,
      tier: order.tier ?? copyTierForProductCode(product.code),
      status: "PENDING_APPROVAL",
      amount: order.amount,
      currency: order.currency,
      current_period_end: pEnd,
    });
  } else if (product.type === "BOT" && order.bot_product_id) {
    await supabase.from("bot_access_records").insert({
      product_id: order.bot_product_id,
      user_id: order.user_id,
      status: "REQUESTED",
      source: "FUTURE_PAYMENT",
      price_amount: order.amount,
      price_currency: order.currency,
    });
  }
  // MENTORSHIP / EVALUATION: just leave the payment_order as proof of payment;
  // admin handles fulfillment manually.

  // ── Partner commission ────────────────────────────────────
  await maybeCreatePartnerCommission(order.user_id, order.id, order.amount, order.currency);
  */
}

export async function confirmMockPayment(
  userId: string,
  orderId: string,
): Promise<{ ok: boolean; message: string }> {
  const runtimeMode = getBillingRuntimeMode({ BILLING_PROVIDER: process.env.BILLING_PROVIDER });

  if (runtimeMode !== "mock") {
    return { ok: false, message: "Mock billing mode is not enabled" };
  }

  const supabase = createAdminClient();
  const { data: order, error } = await supabase
    .from("payment_orders")
    .select("id, user_id, status, provider")
    .eq("id", orderId)
    .eq("user_id", userId)
    .single();

  if (error || !order) return { ok: false, message: "Order not found" };
  if (order.provider !== "MOCK") return { ok: false, message: "Order is not using mock billing" };
  if (order.status === "PAID") {
    await markOrderPaid(order.id);
    return { ok: true, message: "Payment already recorded and access provisioned" };
  }
  if (order.status !== "PENDING") {
    return { ok: false, message: `Order cannot be confirmed from status ${order.status}` };
  }

  await markOrderPaid(order.id);
  return { ok: true, message: "Payment verified and access provisioned" };
}

async function maybeCreatePartnerCommission(
  userId: string,
  purchaseId: string,
  grossAmount: number,
  currency: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: existingCommission } = await supabase
    .from("partner_commissions")
    .select("id")
    .eq("purchase_id", purchaseId)
    .maybeSingle();
  if (existingCommission) return;

  // Find assigned partner for this trader
  const { data: tp } = await supabase
    .from("trader_profiles")
    .select("partner_id")
    .eq("user_id", userId)
    .single();

  if (!tp?.partner_id) return;

  // Get commission %
  const { data: pp } = await supabase
    .from("partner_profiles")
    .select("commission_percent, commission_type")
    .eq("user_id", tp.partner_id)
    .single();

  if (!pp) return;

  const commissionAmount = Number(grossAmount) * (Number(pp.commission_percent ?? 0) / 100);
  const now = new Date();
  const payoutMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  await supabase.from("partner_commissions").insert({
    partner_id: tp.partner_id,
    trader_id: userId,
    purchase_id: purchaseId,
    source_type: "PAYMENT",
    source_id: purchaseId,
    gross_amount: grossAmount,
    commission_percent: pp.commission_percent ?? 0,
    commission_amount: commissionAmount,
    currency,
    status: "PENDING",
    payout_month: payoutMonth,
  });
}

// ─── User billing summary ─────────────────────────────────────────────────────

/**
 * Repairs subscriptions created under the previous manual-approval policy.
 * A PAID payment order is server-verified, so its platform subscription can be
 * activated safely and idempotently when the trader next loads billing access.
 */
async function activateVerifiedPaidPlatformSubscriptions(userId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: pending } = await supabase
    .from("subscriptions")
    .select("id, payment_order_id")
    .eq("user_id", userId)
    .eq("status", "PENDING_APPROVAL")
    .not("payment_order_id", "is", null);

  const pendingRows = pending ?? [];
  const orderIds = pendingRows
    .map((row) => row.payment_order_id)
    .filter((value): value is string => Boolean(value));
  if (orderIds.length === 0) return;

  const { data: platformProduct } = await supabase
    .from("billing_products")
    .select("id")
    .eq("code", "PLATFORM_MONTHLY")
    .maybeSingle();
  if (!platformProduct) return;

  const { data: paidOrders } = await supabase
    .from("payment_orders")
    .select("id")
    .in("id", orderIds)
    .eq("status", "PAID")
    .eq("product_id", platformProduct.id);
  const paidOrderIds = new Set((paidOrders ?? []).map((row) => row.id));
  const subscriptionIds = pendingRows
    .filter((row) => row.payment_order_id && paidOrderIds.has(row.payment_order_id))
    .map((row) => row.id);
  if (subscriptionIds.length === 0) return;

  const activatedAt = new Date().toISOString();
  await supabase
    .from("subscriptions")
    .update({
      status: "ACTIVE",
      approved_at: activatedAt,
      approved_by_admin_id: null,
    })
    .in("id", subscriptionIds)
    .eq("status", "PENDING_APPROVAL");
}

/**
 * Repairs Bot/EA purchases created under the previous manual-approval policy.
 * Only access records backed by a server-recorded PAID Bot/EA order qualify.
 */
async function activateVerifiedPaidBotAccess(userId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: requested } = await supabase
    .from("bot_access_records")
    .select("id, product_id")
    .eq("user_id", userId)
    .eq("status", "REQUESTED")
    .eq("source", "FUTURE_PAYMENT");

  const requestedRows = requested ?? [];
  const productIds = requestedRows.map((row) => row.product_id);
  if (productIds.length === 0) return;

  const { data: botBillingProduct } = await supabase
    .from("billing_products")
    .select("id")
    .eq("code", "BOT_EA")
    .maybeSingle();
  if (!botBillingProduct) return;

  const { data: paidOrders } = await supabase
    .from("payment_orders")
    .select("bot_product_id")
    .eq("user_id", userId)
    .eq("product_id", botBillingProduct.id)
    .eq("status", "PAID")
    .in("bot_product_id", productIds);

  const paidProductIds = new Set(
    (paidOrders ?? [])
      .map((row) => row.bot_product_id)
      .filter((value): value is string => Boolean(value)),
  );
  const accessIds = requestedRows
    .filter((row) => paidProductIds.has(row.product_id))
    .map((row) => row.id);
  if (accessIds.length === 0) return;

  await supabase
    .from("bot_access_records")
    .update({
      status: "ACTIVE",
      granted_at: new Date().toISOString(),
      granted_by: null,
    })
    .in("id", accessIds)
    .eq("status", "REQUESTED");
}

export async function getTraderAccessSummary(userId: string): Promise<UserBillingSummaryDto> {
  await Promise.all([
    activateVerifiedPaidPlatformSubscriptions(userId),
    activateVerifiedPaidBotAccess(userId),
    activateVerifiedPaidCopyFollowers(userId),
  ]);
  const supabase = createAdminClient();

  const [{ data: subs }, { data: entitlements }, { data: orders }, { data: botRecs }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("id, status, current_period_end, approved_at, created_at, billing_products(code, name)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("copy_account_entitlements")
      .select("id, tier, status, trading_account_id, strategy_id, current_period_end, approved_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),

    supabase
      .from("payment_orders")
      .select("id, status, amount, currency, paid_at, created_at, provider_checkout_url, trading_account_id, copy_strategy_id, bot_product_id, tier, metadata, billing_products(code, name, type, billing_interval)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),

    supabase
      .from("bot_access_records")
      .select("id, product_id, status, granted_at, created_at, bot_products(name)")
      .eq("user_id", userId)
      .limit(20),
  ]);

  type SubRow = {
    id: string;
    status: string;
    current_period_end: string | null;
    approved_at: string | null;
    created_at: string;
    billing_products: { code: string; name: string } | null;
  };

  type EntRow = {
    id: string;
    tier: string;
    status: string;
    trading_account_id: string | null;
    strategy_id: string | null;
    current_period_end: string | null;
    approved_at: string | null;
    created_at: string;
  };

  type OrderRow = {
    id: string;
    status: string;
    amount: number;
    currency: string;
    paid_at: string | null;
    created_at: string;
    provider_checkout_url: string | null;
    trading_account_id: string | null;
    copy_strategy_id: string | null;
    bot_product_id: string | null;
    tier: string | null;
    metadata: { approvedAt?: string | null } | null;
    billing_products: { code: string; name: string; type: string; billing_interval: string } | null;
  };

  type BotRecRow = {
    id: string;
    product_id: string;
    status: string;
    granted_at: string | null;
    created_at: string;
    bot_products: { name: string } | null;
  };

  const allSubs = (subs ?? []) as unknown as SubRow[];
  const allEnts = (entitlements ?? []) as unknown as EntRow[];
  const allOrders = (orders ?? []) as unknown as OrderRow[];
  const allBotRecs = (botRecs ?? []) as unknown as BotRecRow[];

  const normalizedOrders = allOrders.map((o) => ({
    id: o.id,
    status: o.status,
    createdAt: o.created_at,
    productCode: o.billing_products?.code,
    productName: o.billing_products?.name,
    tradingAccountId: o.trading_account_id,
    copyStrategyId: o.copy_strategy_id,
    botProductId: o.bot_product_id,
    tier: o.tier,
    approvedAt: o.metadata?.approvedAt ?? null,
  }));

  const platformOrders = normalizedOrders.filter((o) => o.productCode === "PLATFORM_MONTHLY");
  const platformSubscription = derivePlatformSubscriptionAccess({
    subscriptions: allSubs
      .filter((s) => s.billing_products?.code === "PLATFORM_MONTHLY")
      .map((s) => ({
        id: s.id,
        status: s.status,
        currentPeriodEnd: s.current_period_end,
        approvedAt: s.approved_at,
        createdAt: s.created_at,
        productCode: s.billing_products?.code ?? "PLATFORM_MONTHLY",
        productName: s.billing_products?.name ?? "Platform Subscription",
      })),
    orders: platformOrders,
    nowIso: new Date().toISOString(),
  });

  const copyScopes = Array.from(
    new Set(
      [
        ...allEnts
          .filter((entry) => entry.trading_account_id)
          .map((entry) => `${entry.trading_account_id}:${entry.strategy_id ?? "legacy"}`),
        ...normalizedOrders
          .filter((order) => order.productCode?.startsWith("COPY_") && order.tradingAccountId)
          .map((order) => `${order.tradingAccountId}:${order.copyStrategyId ?? "legacy"}`),
      ],
    ),
  );

  const copyEntitlements = copyScopes.map((scope) => {
    const separator = scope.indexOf(":");
    const tradingAccountId = scope.slice(0, separator);
    const encodedStrategyId = scope.slice(separator + 1);
    const strategyId = encodedStrategyId === "legacy" ? null : encodedStrategyId;
    return deriveCopyEntitlementAccess({
      tradingAccountId,
      strategyId,
      entitlements: allEnts.map((e) => ({
        id: e.id,
        tier: e.tier,
        status: e.status,
        tradingAccountId: e.trading_account_id,
        strategyId: e.strategy_id,
        currentPeriodEnd: e.current_period_end,
        approvedAt: e.approved_at,
        createdAt: e.created_at,
      })),
      orders: normalizedOrders.filter(
        (o) => o.productCode?.startsWith("COPY_") && o.tradingAccountId === tradingAccountId && (o.copyStrategyId ?? null) === strategyId,
      ),
      nowIso: new Date().toISOString(),
    });
  });

  const botIds = Array.from(
    new Set(
      [
        ...allBotRecs.map((r) => r.product_id),
        ...normalizedOrders.map((o) => o.botProductId).filter((value): value is string => Boolean(value)),
      ],
    ),
  );

  const botAccess = botIds.map((botProductId) =>
    deriveBotPurchaseAccess({
      botProductId,
      botName:
        allBotRecs.find((r) => r.product_id === botProductId)?.bot_products?.name ??
        "Trading Bot / EA",
      accessRecords: allBotRecs.map((r) => ({
        id: r.id,
        botProductId: r.product_id,
        botName: r.bot_products?.name ?? "Trading Bot / EA",
        status: r.status,
        grantedAt: r.granted_at,
        createdAt: r.created_at,
      })),
      orders: normalizedOrders.filter((o) => o.botProductId === botProductId),
    }),
  );

  const mentorshipAccess = deriveMentorshipAccess({
    orders: normalizedOrders.filter((o) => o.productCode === "MENTORSHIP_1_1"),
  });

  const pendingApprovals = [
    ...normalizedOrders
      .filter((o) => (o.productCode === "COPY_NORMAL" || o.productCode === "COPY_ULTRA_FAST") && o.status === "PAID")
      .map((o) => ({
        type: "COPY_ENTITLEMENT",
        orderId: o.id,
        productName: o.productName ?? `Copy Trading (${o.tier ?? "NORMAL"})`,
        paidAt: allOrders.find((row) => row.id === o.id)?.paid_at ?? "",
      })),
    ...normalizedOrders
      .filter((o) => o.productCode === "MENTORSHIP_1_1" && o.status === "PAID" && !o.approvedAt)
      .map((o) => ({
        type: "MENTORSHIP",
        orderId: o.id,
        productName: o.productName ?? "1-to-1 Professional Mentorship",
        paidAt: allOrders.find((row) => row.id === o.id)?.paid_at ?? "",
      })),
  ];

  return {
    platformSubscription,
    copyEntitlements,
    paymentHistory: allOrders.map((o) => ({
      id: o.id,
      productCode: o.billing_products?.code ?? "",
      productName: o.billing_products?.name ?? "",
      amount: Number(o.amount),
      currency: o.currency,
      status: o.status,
      checkoutUrl: o.provider_checkout_url,
      createdAt: o.created_at,
      paidAt: o.paid_at,
      botProductId: o.bot_product_id,
      tradingAccountId: o.trading_account_id,
    })),
    botAccess,
    mentorshipAccess,
    pendingApprovals,
  };
}

export async function getUserBillingSummary(userId: string): Promise<UserBillingSummaryDto> {
  return getTraderAccessSummary(userId);
}

export function deriveBillingReturnState(
  order: PaymentOrderDto,
  summary: UserBillingSummaryDto,
): Omit<BillingReturnStatusDto, "order"> {
  if (order.status === "FAILED" || order.status === "REFUNDED") {
    return {
      state: "FAILED",
      title: order.status === "REFUNDED" ? "Payment refunded" : "Payment failed",
      message: "No access has been activated for this order.",
    };
  }
  if (order.status === "CANCELLED") {
    return { state: "CANCELLED", title: "Checkout cancelled", message: "No payment was recorded." };
  }
  if (order.status !== "PAID") {
    return {
      state: "PROCESSING",
      title: "Confirming payment",
      message: "We are waiting for the payment provider to confirm this order. This page refreshes automatically.",
    };
  }

  if (order.productCode === "BOT_EA") {
    const access = summary.botAccess.find((entry) => entry.botProductId === order.botProductId);
    if (access?.status === "ACTIVE") {
      return { state: "ACTIVE", title: "Bot access active", message: "Your bot is ready in My Bots." };
    }
    return {
      state: "PROCESSING",
      title: "Activating bot access",
      message: "Your Bot/EA payment is confirmed. Access is being activated automatically.",
    };
  }

  if (order.productCode === "COPY_NORMAL" || order.productCode === "COPY_ULTRA_FAST") {
    const active = summary.copyEntitlements.some(
      (entry) => entry.tradingAccountId === order.tradingAccountId && entry.status === "ACTIVE",
    );
    return active
      ? { state: "ACTIVE", title: "Copy access active", message: "Copy access is active for the selected account." }
      : { state: "PROCESSING", title: "Activating copy access", message: "Payment is confirmed and copy access is being activated." };
  }

  if (order.productCode === "PLATFORM_MONTHLY") {
    return summary.platformSubscription.status === "ACTIVE"
      ? {
          state: "ACTIVE",
          title: "Platform access active",
          message: "Your payment is confirmed and the WSA Global trader portal is unlocked.",
        }
      : {
          state: "PROCESSING",
          title: "Activating platform access",
          message: "Your payment is confirmed. Platform access is being activated automatically.",
        };
  }

  if (order.productCode === "MENTORSHIP_1_1") {
    return summary.mentorshipAccess.status === "ACTIVE"
      ? { state: "ACTIVE", title: "Mentorship access active", message: "Your mentorship access is active." }
      : { state: "PENDING_APPROVAL", title: "Payment received — pending admin approval", message: "An admin will review and activate your mentorship access." };
  }

  return {
    state: "PAYMENT_RECEIVED",
    title: "Payment received",
    message: "The payment is confirmed. Product-specific access processing may still be required.",
  };
}

type StripeCheckoutReturnSession = {
  id: string;
  status: string | null;
  payment_status: string;
  client_reference_id: string | null;
  metadata?: Record<string, string> | null;
  subscription?: string | { id: string } | null;
  payment_intent?: string | { id: string } | null;
};

export function canReconcileStripeCheckoutReturn(
  orderId: string,
  storedSessionId: string,
  session: StripeCheckoutReturnSession,
): boolean {
  const referencedOrderId = session.client_reference_id ?? session.metadata?.localOrderId ?? null;
  return (
    session.id === storedSessionId &&
    referencedOrderId === orderId &&
    session.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required")
  );
}

function stripeResourceId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

export async function getBillingReturnStatus(
  userId: string,
  orderId: string,
  stripeSessionId?: string | null,
): Promise<BillingReturnStatusDto | null> {
  const supabase = createAdminClient();
  const { data: storedOrder, error } = await supabase
    .from("payment_orders")
    .select("id, status, provider, stripe_checkout_session_id")
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !storedOrder) return null;

  if (stripeSessionId && storedOrder.stripe_checkout_session_id !== stripeSessionId) {
    return null;
  }

  // Local development cannot receive Stripe webhooks without a forwarding tunnel.
  // Verify the signed-in user's exact Checkout Session with Stripe on the secure
  // return path so a completed test/live Checkout does not remain stuck at PENDING.
  // The webhook remains the primary asynchronous source and this path is idempotent.
  if (
    (storedOrder.status === "PENDING" || storedOrder.status === "PAID") &&
    storedOrder.provider === "STRIPE" &&
    stripeSessionId &&
    storedOrder.stripe_checkout_session_id
  ) {
    try {
      const session = (await getStripe().checkout.sessions.retrieve(stripeSessionId)) as StripeCheckoutReturnSession;
      if (canReconcileStripeCheckoutReturn(orderId, storedOrder.stripe_checkout_session_id, session)) {
        await handleStripeCheckoutCompleted({
          id: session.id,
          subscription: stripeResourceId(session.subscription),
          payment_intent: stripeResourceId(session.payment_intent),
        });
      }
    } catch {
      // Keep the honest PROCESSING state; polling or a later webhook can retry.
    }
  }

  const summary = await getTraderAccessSummary(userId);
  const order = summary.paymentHistory.find((entry) => entry.id === orderId);
  if (!order) return null;
  return { order, ...deriveBillingReturnState(order, summary) };
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

export async function approvePaymentAccess(
  orderId: string,
  adminId: string,
): Promise<{ ok: boolean; message: string }> {
  const supabase = createAdminClient();

  const { data: order, error } = await supabase
    .from("payment_orders")
    .select("id, user_id, product_id, status, trading_account_id, tier, bot_product_id, metadata")
    .eq("id", orderId)
    .single();

  if (error || !order) return { ok: false, message: "Order not found" };
  if (order.status !== "PAID") return { ok: false, message: "Order is not in PAID status" };

  const { data: product } = await supabase
    .from("billing_products")
    .select("type, code, billing_interval")
    .eq("id", order.product_id)
    .single();

  if (!product) return { ok: false, message: "Product not found" };

  await ensurePaidOrderProvisioned(order as PaidOrderProvisionRow, product as BillingProductProvisionRow);

  const now = new Date().toISOString();
  const pEnd = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();

  if (product.type === "SUBSCRIPTION") {
    await supabase
      .from("subscriptions")
      .update({
        status: "ACTIVE",
        starts_at: now,
        started_at: now,
        ends_at: pEnd,
        current_period_end: pEnd,
        approved_by_admin_id: adminId,
        approved_at: now,
      })
      .eq("payment_order_id", orderId)
      .eq("status", "PENDING_APPROVAL");
  } else if (product.type === "COPY_ACCOUNT") {
    await supabase
      .from("copy_account_entitlements")
      .update({
        status: "ACTIVE",
        current_period_end: pEnd,
        approved_by_admin_id: adminId,
        approved_at: now,
      })
      .eq("payment_order_id", orderId)
      .eq("status", "PENDING_APPROVAL");
  } else if (product.type === "BOT" && order.bot_product_id) {
    await supabase
      .from("bot_access_records")
      .update({
        status: "ACTIVE",
        granted_by: adminId,
        granted_at: now,
      })
      .eq("user_id", order.user_id)
      .eq("product_id", order.bot_product_id)
      .eq("source", "FUTURE_PAYMENT");
  } else if (product.type === "MENTORSHIP") {
    await supabase
      .from("payment_orders")
      .update({
        metadata: {
          ...((order.metadata as Record<string, unknown> | null) ?? {}),
          approvedAt: now,
          approvedByAdminId: adminId,
        },
      })
      .eq("id", orderId);
  }

  await writeAuditLog({
    actorUserId: adminId,
    action: "PAYMENT_ACCESS_APPROVED",
    entityType: "payment_order",
    entityId: orderId,
    metadata: { productType: product.type, userId: order.user_id },
  });

  return { ok: true, message: "Access approved" };
}

/** Expire entitlements whose current_period_end has passed. */
export async function expireStaleEntitlements(): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data: expiredCopySubscriptions } = await supabase
    .from("copy_account_entitlements")
    .select("strategy_id, trading_account_id")
    .eq("status", "ACTIVE")
    .lt("current_period_end", now)
    .not("strategy_id", "is", null);

  await Promise.all([
    supabase
      .from("subscriptions")
      .update({ status: "EXPIRED" })
      .eq("status", "ACTIVE")
      .lt("current_period_end", now),

    supabase
      .from("copy_account_entitlements")
      .update({ status: "EXPIRED" })
      .eq("status", "ACTIVE")
      .lt("current_period_end", now),
  ]);

  for (const entitlement of expiredCopySubscriptions ?? []) {
    if (!entitlement.strategy_id || !entitlement.trading_account_id) continue;
    await supabase
      .from("copy_strategy_followers")
      .update({ status: "REVOKED", engine_status: "REMOVED", engine_error: null })
      .eq("strategy_id", entitlement.strategy_id)
      .eq("follower_account_id", entitlement.trading_account_id);
  }
}

/** Returns whether a user has an active platform subscription. */
export async function hasActivePlatformSubscription(userId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { count } = await supabase
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .gt("current_period_end", new Date().toISOString());
  return (count ?? 0) > 0;
}

/** Returns active copy entitlements for a user, optionally for a specific account. */
export async function getActiveCopyEntitlements(
  userId: string,
  tradingAccountId?: string,
  strategyId?: string,
): Promise<CopyEntitlementDto[]> {
  const supabase = createAdminClient();
  let q = supabase
    .from("copy_account_entitlements")
    .select("id, tier, status, trading_account_id, strategy_id, current_period_end, approved_at")
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .gt("current_period_end", new Date().toISOString());

  if (tradingAccountId) q = q.eq("trading_account_id", tradingAccountId);
  if (strategyId) q = q.eq("strategy_id", strategyId);

  const { data } = await q;
  return (data ?? []).map((row) => ({
    id: row.id,
    tier: row.tier,
    tradingAccountId: row.trading_account_id,
    strategyId: row.strategy_id,
    status: row.status as BillingAccessState,
    currentPeriodEnd: row.current_period_end,
    approvedAt: row.approved_at,
    orderId: null,
    message: "Active live strategy subscription.",
  }));
}
