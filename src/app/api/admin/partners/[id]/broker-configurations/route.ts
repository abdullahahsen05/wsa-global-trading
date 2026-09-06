import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { partnerBrokerConfigurationSchema } from "@/lib/validation/schemas";
import {
  listPartnerBrokerConfigurations,
  upsertPartnerBrokerConfiguration,
} from "@/lib/services/partnerRebateCalculationService";
import { ensureBrokerProviderForName } from "@/lib/services/brokerCatalogService";
import { searchApi2TradeBrokers } from "@/lib/services/api2TradeBrokerDiscoveryService";

function normalizeBrokerName(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const supabase = createAdminClient();
    const [accountBrokerResult, configurations] = await Promise.all([
      supabase
        .from("trading_accounts")
        .select("broker_provider_id, broker_name")
        .not("broker_name", "is", null),
      listPartnerBrokerConfigurations(id),
    ]);
    if (accountBrokerResult.error) {
      return jsonFail("BROKERS_LOAD_FAILED", accountBrokerResult.error.message, 500);
    }

    const detectedBrokerIds = [
      ...new Set(
        (accountBrokerResult.data ?? [])
          .map((account) => account.broker_provider_id)
          .filter((brokerId): brokerId is string => Boolean(brokerId)),
      ),
    ];
    const liveBrokerNames = [
      ...new Set(
        (accountBrokerResult.data ?? [])
          .map((account) => String(account.broker_name ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const liveBrokerNameSet = new Set(liveBrokerNames.map(normalizeBrokerName));
    const configuredBrokerIdsForLiveNames = configurations
      .filter((config) => config.brokerProviderId && liveBrokerNameSet.has(normalizeBrokerName(config.brokerName)))
      .map((config) => config.brokerProviderId)
      .filter((brokerId): brokerId is string => Boolean(brokerId));
    const visibleBrokerIds = [...new Set([...detectedBrokerIds, ...configuredBrokerIdsForLiveNames])];
    const visibleConfigurations = configurations.filter(
      (config) =>
        !config.brokerProviderId
        || visibleBrokerIds.includes(config.brokerProviderId)
        || liveBrokerNameSet.has(normalizeBrokerName(config.brokerName)),
    );
    const { data: brokers, error } = visibleBrokerIds.length > 0
      ? await supabase
          .from("broker_providers")
          .select("id, display_name, name, is_active")
          .in("id", visibleBrokerIds)
          .order("display_name", { ascending: true })
      : { data: [], error: null };
    if (error) return jsonFail("BROKERS_LOAD_FAILED", error.message, 500);
    const brokerRows = brokers ?? [];
    const logoResults = await Promise.all(
      liveBrokerNames.slice(0, 20).map(async (name) => {
        try {
          const result = await searchApi2TradeBrokers({
            query: name,
            platform: "MT5",
            userId: admin.id,
            role: admin.role,
          });
          const normalized = normalizeBrokerName(name);
          const match = result.brokers.find((broker) => normalizeBrokerName(broker.name) === normalized)
            ?? result.brokers[0]
            ?? null;
          return [normalized, match?.logoUrl ?? null] as const;
        } catch {
          return [normalizeBrokerName(name), null] as const;
        }
      }),
    );
    const logoByBrokerName = new Map(logoResults);
    const brokerNameRows = brokerRows.map((broker) => normalizeBrokerName(broker.display_name || broker.name));
    const enrichedBrokerRows = brokerRows.map((broker) => {
      const displayName = broker.display_name || broker.name;
      return {
        ...broker,
        logoUrl: logoByBrokerName.get(normalizeBrokerName(displayName)) ?? null,
      };
    });
    const nameOnlyBrokers = liveBrokerNames
      .filter((name) => !brokerNameRows.includes(normalizeBrokerName(name)))
      .map((name) => ({
        id: `broker-name:${name}`,
        display_name: name,
        name,
        is_active: true,
        logoUrl: logoByBrokerName.get(normalizeBrokerName(name)) ?? null,
      }));
    return jsonOk({ brokers: [...enrichedBrokerRows, ...nameOnlyBrokers], configurations: visibleConfigurations });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("PARTNER_CONFIG_LOAD_FAILED", "Partner broker configuration could not be loaded.", 500);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const parsed = partnerBrokerConfigurationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join(", "), 400);
    }
    let brokerProviderId = parsed.data.brokerProviderId ?? null;
    if (!brokerProviderId && parsed.data.brokerName?.trim()) {
      const brokerProvider = await ensureBrokerProviderForName({
        displayName: parsed.data.brokerName,
        actorUserId: admin.id,
      });
      brokerProviderId = brokerProvider?.id ?? null;
    }
    const saved = await upsertPartnerBrokerConfiguration({
      actorUserId: admin.id,
      partnerId: id,
      brokerProviderId,
      modelType: parsed.data.modelType,
      rebateRatePerLot: parsed.data.rebateRatePerLot,
      xauusdRatePerLot: parsed.data.xauusdRatePerLot ?? parsed.data.rebateRatePerLot,
      cpaQualificationLots: parsed.data.cpaQualificationLots,
      cpaTier1Deposit: parsed.data.cpaTier1Deposit,
      cpaTier1Payout: parsed.data.cpaTier1Payout,
      cpaTier2Deposit: parsed.data.cpaTier2Deposit,
      cpaTier2Payout: parsed.data.cpaTier2Payout,
      cpaTier3Deposit: parsed.data.cpaTier3Deposit,
      cpaTier3Payout: parsed.data.cpaTier3Payout,
      currency: parsed.data.currency,
      isActive: parsed.data.isActive,
    });
    return jsonOk(saved, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("PARTNER_CONFIG_SAVE_FAILED", error instanceof Error ? error.message : "Partner broker configuration could not be saved.", 500);
  }
}
