import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { getCopyGlobalSettings, updateCopyGlobalSettings } from "@/lib/services/copyTradingService";
import { brokerProviderConfigured, createBrokerAdapter, getBrokerProviderId, getBrokerProviderLabel } from "@/lib/broker/provider";
import { copyGlobalSettingsSchema } from "@/lib/validation/schemas";

export async function GET() {
  try {
    await requireAdmin();
    const settings = await getCopyGlobalSettings();
    const adapter = createBrokerAdapter();
    const executionConfigured = adapter.executionAvailable();
    const providerConfigured = brokerProviderConfigured();
    const encryptionConfigured = Boolean(process.env.ENCRYPTION_KEY);
    return jsonOk({
      ...settings,
      brokerProvider: getBrokerProviderId(),
      brokerProviderLabel: getBrokerProviderLabel(),
      executionConfigured,
      providerConfigured,
      metaapiTokenConfigured: false,
      api2TradeConfigured: getBrokerProviderId() === "api2trade" ? providerConfigured : false,
      encryptionConfigured,
    });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}

// PATCH — global live-copy enable + emergency-stop kill switch.
export async function PATCH(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await request.json().catch(() => null);
    const parsed = copyGlobalSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join(", "), 400);
    }
    return jsonOk(await updateCopyGlobalSettings(parsed.data, admin.id));
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
