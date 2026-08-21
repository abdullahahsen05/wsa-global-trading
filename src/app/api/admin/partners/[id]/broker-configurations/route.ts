import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { partnerBrokerConfigurationSchema } from "@/lib/validation/schemas";
import {
  listPartnerBrokerConfigurations,
  upsertPartnerBrokerConfiguration,
} from "@/lib/services/partnerRebateCalculationService";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const supabase = createAdminClient();
    const [{ data: brokers, error }, configurations] = await Promise.all([
      supabase
        .from("broker_providers")
        .select("id, display_name, name, is_active")
        .order("display_name", { ascending: true }),
      listPartnerBrokerConfigurations(id),
    ]);
    if (error) return jsonFail("BROKERS_LOAD_FAILED", error.message, 500);
    return jsonOk({ brokers: brokers ?? [], configurations });
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
    const saved = await upsertPartnerBrokerConfiguration({
      actorUserId: admin.id,
      partnerId: id,
      brokerProviderId: parsed.data.brokerProviderId ?? null,
      modelType: parsed.data.modelType,
      rebateRatePerLot: parsed.data.rebateRatePerLot,
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
