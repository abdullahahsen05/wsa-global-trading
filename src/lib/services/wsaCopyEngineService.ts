import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";
import { enqueueJob } from "@/lib/services/backgroundJobService";
import { brokerProviderConfigured, getBrokerProviderId } from "@/lib/broker/provider";

type StrategyRecord = {
  id: string;
  name: string;
  master_account_id: string;
  monthly_price: number | string;
  standard_monthly_price: number | string;
  premium_monthly_price: number | string;
  currency: string;
  billing_product_id: string | null;
  standard_billing_product_id: string | null;
  premium_billing_product_id: string | null;
};

export class WsaCopyEngineConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsaCopyEngineConfigurationError";
  }
}

function strategyProductCode(strategyId: string) {
  return `COPY_STRATEGY_${strategyId.replaceAll("-", "").toUpperCase()}_STANDARD`;
}

async function ensureStrategyBillingProduct(strategy: StrategyRecord): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("billing_products")
    .upsert({
      code: strategyProductCode(strategy.id),
      name: `${strategy.name} Copy Strategy`,
      type: "COPY_ACCOUNT",
      amount: Number(strategy.standard_monthly_price),
      currency: strategy.currency,
      billing_interval: "MONTHLY",
      active: true,
    }, { onConflict: "code" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Strategy billing product could not be saved: ${error?.message}`);
  return data.id as string;
}

export function getWsaCopyEngineRuntimeStatus() {
  const configured = brokerProviderConfigured() && process.env.WSA_COPY_ENGINE_ENABLED === "true";
  return {
    configured,
    enabled: process.env.WSA_COPY_ENGINE_ENABLED === "true",
    executionEnabled: process.env.BROKER_EXECUTION_ENABLED === "true",
    brokerProvider: getBrokerProviderId(),
    provider: "WSA_ENGINE" as const,
  };
}

export async function publishWsaStrategy(strategyId: string, actorUserId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("copy_strategies")
    .select("id, name, master_account_id, monthly_price, standard_monthly_price, premium_monthly_price, currency, billing_product_id, standard_billing_product_id, premium_billing_product_id")
    .eq("id", strategyId)
    .maybeSingle();
  if (!data) throw new Error("Copy strategy was not found.");
  const strategy = data as StrategyRecord;

  const { data: master } = await supabase
    .from("trading_accounts")
    .select("id, user_id, status, provider_account_id, account_usage")
    .eq("id", strategy.master_account_id)
    .maybeSingle();
  if (!master || master.user_id !== actorUserId || master.account_usage !== "COPY_MASTER") {
    throw new Error("Select a copy-master account connected by this administrator.");
  }
  if (master.status !== "CONNECTED" || !master.provider_account_id) {
    throw new Error("The master account must be connected and synchronized before publishing.");
  }
  if (!getWsaCopyEngineRuntimeStatus().configured) {
    throw new WsaCopyEngineConfigurationError(
      "The WSA copy engine is not configured. Set the active broker provider credentials and WSA_COPY_ENGINE_ENABLED=true.",
    );
  }

  const standardBillingProductId = await ensureStrategyBillingProduct(strategy);
  const publishedAt = new Date().toISOString();
  const { error } = await supabase.from("copy_strategies").update({
    billing_product_id: standardBillingProductId,
    standard_billing_product_id: standardBillingProductId,
    // Preserve any historical premium product for existing renewals, but do
    // not create another speed/price tier for a newly published strategy.
    status: "ACTIVE",
    mode: "LIVE",
    live_enabled: true,
    engine_status: "LIVE",
    engine_error: null,
    published_at: publishedAt,
  }).eq("id", strategyId);
  if (error) throw new Error(`Published strategy could not be saved: ${error.message}`);

  await writeAuditLog({
    actorUserId,
    action: "COPY_STRATEGY_UPDATED",
    entityType: "copy_strategy",
    entityId: strategyId,
    metadata: { action: "PUBLISH_LIVE", provider: "WSA_ENGINE" },
  });
  return { strategyId, status: "LIVE" as const, publishedAt };
}

export async function archiveWsaStrategy(strategyId: string, actorUserId: string) {
  const supabase = createAdminClient();
  const { data: strategy } = await supabase
    .from("copy_strategies")
    .select("id, billing_product_id, standard_billing_product_id, premium_billing_product_id")
    .eq("id", strategyId)
    .maybeSingle();
  if (!strategy) throw new Error("Copy strategy was not found.");

  await supabase.from("copy_strategies").update({
    status: "PAUSED",
    live_enabled: false,
    engine_status: "DRAINING",
    engine_error: null,
  }).eq("id", strategyId);
  const productIds = [
    strategy.billing_product_id,
    strategy.standard_billing_product_id,
    strategy.premium_billing_product_id,
  ].filter(Boolean) as string[];
  if (productIds.length) {
    await supabase.from("billing_products").update({ active: false }).in("id", productIds);
  }
  await enqueueJob({
    type: "CLOSE_COPY_STRATEGY",
    payload: { strategyId },
    uniqueKey: `CLOSE_COPY_STRATEGY:${strategyId}`,
    createdBy: actorUserId,
    priority: 100,
  });
  await writeAuditLog({
    actorUserId,
    action: "COPY_STRATEGY_UPDATED",
    entityType: "copy_strategy",
    entityId: strategyId,
    metadata: { action: "ARCHIVE_AND_CLOSE", provider: "WSA_ENGINE" },
  });
  return { strategyId, status: "DRAINING" as const };
}
