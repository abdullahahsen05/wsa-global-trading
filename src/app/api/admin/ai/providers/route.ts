import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAdmin, requireSuperAdmin } from "@/lib/auth/session";
import { aiProviderKeySchema } from "@/lib/ai/providerValidation";
import {
  listAiProviderSettings,
  saveAiProviderKey,
} from "@/lib/services/aiProviderService";

export async function GET() {
  try {
    const user = await requireAdmin();
    const settings = await listAiProviderSettings();
    return jsonOk({ ...settings, canManageSecrets: user.role === "SUPER_ADMIN" });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("AI_PROVIDER_SETTINGS_UNAVAILABLE", "AI provider settings are unavailable.", 503);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin();
    const parsed = aiProviderKeySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonFail(
        "INVALID_AI_PROVIDER_KEY",
        parsed.error.issues.map((issue) => issue.message).join(", "),
        400,
      );
    }
    await saveAiProviderKey({
      provider: parsed.data.provider,
      apiKey: parsed.data.apiKey,
      actorUserId: user.id,
    });
    return jsonOk({ provider: parsed.data.provider, saved: true });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("Secret key must")) return jsonFail("INVALID_AI_PROVIDER_KEY", message, 400);
    return jsonFail("AI_PROVIDER_SAVE_FAILED", "The provider key could not be saved.", 500);
  }
}
