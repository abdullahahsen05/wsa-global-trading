import { NextRequest } from "next/server";
import { AuthError, requireAdmin } from "@/lib/auth/session";
import { handleAuthError, jsonFail, jsonOk } from "@/lib/api/envelope";
import { createAdminClient } from "@/lib/supabase/admin";

type PurchaseRow = {
  id: string;
  user_id: string;
  product_id: string | null;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  created_at: string;
  paid_at: string | null;
  provider_payment_intent_id: string | null;
  provider_checkout_url: string | null;
  trading_account_id: string | null;
  tier: string | null;
  bot_product_id: string | null;
  metadata: { approvedAt?: string | null } | null;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  product_id: string | null;
  payment_order_id: string | null;
  status: string;
  current_period_end: string | null;
  approved_at: string | null;
  created_at: string;
};

type CopyEntitlementRow = {
  id: string;
  user_id: string;
  payment_order_id: string | null;
  status: string;
  current_period_end: string | null;
  approved_at: string | null;
  created_at: string;
  trading_account_id: string | null;
  tier: string;
};

type BotAccessRow = {
  id: string;
  user_id: string;
  product_id: string | null;
  status: string;
  granted_at: string | null;
  expires_at: string | null;
  created_at: string;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
};

function userDetailsMap(rows: ProfileRow[]) {
  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: row.full_name ?? row.email ?? "Unknown",
        email: row.email ?? "",
      },
    ]),
  );
}

function copyTierLabel(_tier: string | null) {
  return "Copy trading";
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const supabase = createAdminClient();
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);

    let purchaseQuery = supabase
      .from("payment_orders")
      .select(`
        id, user_id, product_id, amount, currency, status, provider, created_at, paid_at,
        provider_payment_intent_id, provider_checkout_url,
        trading_account_id, tier, bot_product_id, metadata
      `)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) purchaseQuery = purchaseQuery.eq("status", status);

    const [purchasesResult, subscriptionsResult, entitlementsResult, botAccessResult] = await Promise.all([
      purchaseQuery,
      supabase
        .from("subscriptions")
        .select("id, user_id, product_id, payment_order_id, status, current_period_end, approved_at, created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("copy_account_entitlements")
        .select("id, user_id, payment_order_id, status, current_period_end, approved_at, created_at, trading_account_id, tier")
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("bot_access_records")
        .select("id, user_id, product_id, status, granted_at, expires_at, created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);

    if (purchasesResult.error) return jsonFail("DB_ERROR", purchasesResult.error.message, 500);
    if (subscriptionsResult.error) return jsonFail("DB_ERROR", subscriptionsResult.error.message, 500);
    if (entitlementsResult.error) return jsonFail("DB_ERROR", entitlementsResult.error.message, 500);
    if (botAccessResult.error) return jsonFail("DB_ERROR", botAccessResult.error.message, 500);

    const purchaseRows = (purchasesResult.data ?? []) as unknown as PurchaseRow[];
    const subscriptionRows = (subscriptionsResult.data ?? []) as unknown as SubscriptionRow[];
    const entitlementRows = (entitlementsResult.data ?? []) as unknown as CopyEntitlementRow[];
    const botRows = (botAccessResult.data ?? []) as unknown as BotAccessRow[];

    const profileIds = Array.from(
      new Set([
        ...purchaseRows.map((row) => row.user_id),
        ...subscriptionRows.map((row) => row.user_id),
        ...entitlementRows.map((row) => row.user_id),
        ...botRows.map((row) => row.user_id),
      ]),
    ).filter(Boolean) as string[];

    const billingProductIds = Array.from(
      new Set([
        ...purchaseRows.map((row) => row.product_id),
        ...subscriptionRows.map((row) => row.product_id),
      ].filter(Boolean) as string[]),
    );

    const botProductIds = Array.from(
      new Set(botRows.map((row) => row.product_id).filter(Boolean) as string[]),
    );

    const [profilesResult, billingProductsResult, botProductsResult] = await Promise.all([
      profileIds.length
        ? supabase.from("profiles").select("id, full_name, email").in("id", profileIds)
        : { data: [], error: null },
      billingProductIds.length
        ? supabase.from("billing_products").select("id, code, name, type").in("id", billingProductIds)
        : { data: [], error: null },
      botProductIds.length
        ? supabase.from("bot_products").select("id, name").in("id", botProductIds)
        : { data: [], error: null },
    ]);

    if (profilesResult.error) return jsonFail("DB_ERROR", profilesResult.error.message, 500);
    if (billingProductsResult.error) return jsonFail("DB_ERROR", billingProductsResult.error.message, 500);
    if (botProductsResult.error) return jsonFail("DB_ERROR", botProductsResult.error.message, 500);

    const billingProductsMap = new Map(
      ((billingProductsResult.data ?? []) as { id: string; code: string; name: string; type: string }[]).map(
        (p) => [p.id, p],
      ),
    );
    const botProductsMap = new Map(
      ((botProductsResult.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p]),
    );

    const users = userDetailsMap((profilesResult.data ?? []) as ProfileRow[]);

    const purchases = purchaseRows.map((row) => {
      const user = users.get(row.user_id) ?? { name: "Unknown", email: "" };
      const billingProduct = row.product_id ? billingProductsMap.get(row.product_id) : null;
      return {
        id: row.id,
        userId: row.user_id,
        userName: user.name,
        userEmail: user.email,
        productCode: billingProduct?.code ?? "",
        productName: billingProduct?.name ?? "",
        productType: billingProduct?.type ?? "",
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status,
        provider: row.provider,
        intentId: row.provider_payment_intent_id,
        checkoutUrl: row.provider_checkout_url,
        tradingAccountId: row.trading_account_id,
        tier: row.tier,
        botProductId: row.bot_product_id,
        createdAt: row.created_at,
        paidAt: row.paid_at,
        approvedAt: row.metadata?.approvedAt ?? null,
      };
    });

    const pendingCopyOrderIds = new Set(
      entitlementRows
        .filter((row) => row.status === "PENDING_APPROVAL" && row.payment_order_id)
        .map((row) => row.payment_order_id as string),
    );
    const pendingApprovals = purchases
      .filter((row) => {
        if (row.status !== "PAID") return false;
        if (row.productCode === "PLATFORM_MONTHLY") return false;
        if (row.productCode === "COPY_NORMAL" || row.productCode === "COPY_ULTRA_FAST") {
          return pendingCopyOrderIds.has(row.id);
        }
        if (row.productCode === "BOT_EA") return false;
        if (row.productCode === "MENTORSHIP_1_1") return false;
        return true;
      })
      .map((row) => ({
        orderId: row.id,
        userId: row.userId,
        userName: row.userName,
        userEmail: row.userEmail,
        productCode: row.productCode,
        productName: row.productName,
        productType: row.productType,
        amount: row.amount,
        currency: row.currency,
        paidAt: row.paidAt,
      }));

    const activeAccess = [
      ...subscriptionRows
        .filter((row) => row.status === "ACTIVE")
        .map((row) => {
          const user = users.get(row.user_id) ?? { name: "Unknown", email: "" };
          return {
            id: row.id,
            userId: row.user_id,
            userName: user.name,
            userEmail: user.email,
            accessType: "SUBSCRIPTION" as const,
            productName: (row.product_id ? billingProductsMap.get(row.product_id)?.name : null) ?? "Platform Subscription",
            status: row.status,
            scopeLabel: "Global platform access",
            currentPeriodEnd: row.current_period_end,
            approvedAt: row.approved_at,
            createdAt: row.created_at,
          };
        }),
      ...entitlementRows
        .filter((row) => row.status === "ACTIVE")
        .map((row) => {
          const user = users.get(row.user_id) ?? { name: "Unknown", email: "" };
          return {
            id: row.id,
            userId: row.user_id,
            userName: user.name,
            userEmail: user.email,
            accessType: "COPY_ACCOUNT" as const,
            productName: "Copy Trading Access",
            status: row.status,
            scopeLabel: `${copyTierLabel(row.tier)}${row.trading_account_id ? ` - account ${row.trading_account_id.slice(0, 8)}` : ""}`,
            currentPeriodEnd: row.current_period_end,
            approvedAt: row.approved_at,
            createdAt: row.created_at,
          };
        }),
      ...botRows
        .filter((row) => row.status === "ACTIVE")
        .map((row) => {
          const user = users.get(row.user_id) ?? { name: "Unknown", email: "" };
          return {
            id: row.id,
            userId: row.user_id,
            userName: user.name,
            userEmail: user.email,
            accessType: "BOT" as const,
            productName: (row.product_id ? botProductsMap.get(row.product_id)?.name : null) ?? "Trading Bot / EA",
            status: row.status,
            scopeLabel: "One-time purchased bot access",
            currentPeriodEnd: row.expires_at,
            approvedAt: row.granted_at,
            createdAt: row.created_at,
          };
        }),
      ...purchases
        .filter((row) => row.productCode === "MENTORSHIP_1_1" && row.status === "PAID")
        .map((row) => ({
          id: row.id,
          userId: row.userId,
          userName: row.userName,
          userEmail: row.userEmail,
          accessType: "MENTORSHIP" as const,
          productName: row.productName || "1-to-1 Mentorship",
          status: "ACTIVE",
          scopeLabel: "One-time mentorship access",
          currentPeriodEnd: null,
          approvedAt: row.approvedAt ?? row.paidAt,
          createdAt: row.createdAt,
        })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const expiredAccess = [
      ...subscriptionRows
        .filter((row) => row.status === "EXPIRED")
        .map((row) => {
          const user = users.get(row.user_id) ?? { name: "Unknown", email: "" };
          return {
            id: row.id,
            userId: row.user_id,
            userName: user.name,
            userEmail: user.email,
            accessType: "SUBSCRIPTION" as const,
            productName: (row.product_id ? billingProductsMap.get(row.product_id)?.name : null) ?? "Platform Subscription",
            status: row.status,
            scopeLabel: "Global platform access",
            currentPeriodEnd: row.current_period_end,
            approvedAt: row.approved_at,
            createdAt: row.created_at,
          };
        }),
      ...entitlementRows
        .filter((row) => row.status === "EXPIRED")
        .map((row) => {
          const user = users.get(row.user_id) ?? { name: "Unknown", email: "" };
          return {
            id: row.id,
            userId: row.user_id,
            userName: user.name,
            userEmail: user.email,
            accessType: "COPY_ACCOUNT" as const,
            productName: "Copy Trading Access",
            status: row.status,
            scopeLabel: `${copyTierLabel(row.tier)}${row.trading_account_id ? ` - account ${row.trading_account_id.slice(0, 8)}` : ""}`,
            currentPeriodEnd: row.current_period_end,
            approvedAt: row.approved_at,
            createdAt: row.created_at,
          };
        }),
      ...botRows
        .filter((row) => row.status === "EXPIRED")
        .map((row) => {
          const user = users.get(row.user_id) ?? { name: "Unknown", email: "" };
          return {
            id: row.id,
            userId: row.user_id,
            userName: user.name,
            userEmail: user.email,
            accessType: "BOT" as const,
            productName: (row.product_id ? botProductsMap.get(row.product_id)?.name : null) ?? "Trading Bot / EA",
            status: row.status,
            scopeLabel: "Bot access expired",
            currentPeriodEnd: row.expires_at,
            approvedAt: row.granted_at,
            createdAt: row.created_at,
          };
        }),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return jsonOk({ purchases, pendingApprovals, activeAccess, expiredAccess });
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError(err);
    return jsonFail("INTERNAL_ERROR", "Failed to load purchases", 500);
  }
}
