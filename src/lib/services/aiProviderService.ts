import { decryptSecret, encryptSecret } from "@/lib/crypto/brokerCrypto";
import {
  validateProviderKey,
  type ProviderValidationResult,
} from "@/lib/ai/providerTransport";
import type { AiProvider } from "@/lib/ai/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";

type ProviderStatus = "NOT_CONFIGURED" | "VALID" | "INVALID";

interface ProviderRow {
  id: string;
  provider: AiProvider;
  is_active: boolean;
  encrypted_api_key: string;
  api_key_hint: string;
  status: ProviderStatus;
  last_validated_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface AiProviderSettingDto {
  provider: AiProvider;
  configured: boolean;
  isActive: boolean;
  apiKeyHint: string | null;
  status: ProviderStatus;
  lastValidatedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
  environmentFallbackAvailable: boolean;
}

export interface ResolvedAiProvider {
  provider: AiProvider;
  apiKey: string;
  source: "DATABASE" | "ENVIRONMENT";
}

const PROVIDERS: AiProvider[] = ["GEMINI", "OPENAI"];

export function maskAiApiKey(apiKey: string): string {
  const value = apiKey.trim();
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function envKey(provider: AiProvider): string | null {
  const value = provider === "GEMINI"
    ? process.env.GEMINI_API_KEY
    : process.env.OPENAI_API_KEY;
  return value?.trim() || null;
}

function preferredEnvProviders(): AiProvider[] {
  const preferred = process.env.AI_PROVIDER?.trim().toUpperCase();
  if (preferred === "OPENAI") return ["OPENAI", "GEMINI"];
  return ["GEMINI", "OPENAI"];
}

export async function resolveAiProvider(): Promise<ResolvedAiProvider> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("ai_provider_settings")
      .select("provider, encrypted_api_key")
      .eq("is_active", true)
      .eq("status", "VALID")
      .maybeSingle();
    if (data?.provider && data.encrypted_api_key) {
      try {
        return {
          provider: data.provider as AiProvider,
          apiKey: decryptSecret(data.encrypted_api_key as string),
          source: "DATABASE",
        };
      } catch {
        // A key encrypted with a previous ENCRYPTION_KEY is unusable. Continue
        // to the environment fallback without exposing the failure details.
      }
    }
  } catch {
    // The migration or service-role runtime may not be available yet.
    // Environment fallback remains supported during rollout.
  }

  for (const provider of preferredEnvProviders()) {
    const apiKey = envKey(provider);
    if (apiKey) return { provider, apiKey, source: "ENVIRONMENT" };
  }
  throw new Error("No valid AI provider is configured.");
}

export async function listAiProviderSettings(): Promise<{
  providers: AiProviderSettingDto[];
  resolvedProvider: AiProvider | null;
  resolvedSource: "DATABASE" | "ENVIRONMENT" | null;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_provider_settings")
    .select("id, provider, is_active, encrypted_api_key, api_key_hint, status, last_validated_at, last_error, updated_at");
  if (error) throw new Error(`Failed to load AI providers: ${error.message}`);
  const rows = (data ?? []) as ProviderRow[];
  const map = new Map(rows.map((row) => [row.provider, row]));

  let resolvedProvider: AiProvider | null = null;
  let resolvedSource: "DATABASE" | "ENVIRONMENT" | null = null;
  try {
    const resolved = await resolveAiProvider();
    resolvedProvider = resolved.provider;
    resolvedSource = resolved.source;
  } catch {
    // Honest unavailable state.
  }

  return {
    providers: PROVIDERS.map((provider) => {
      const row = map.get(provider);
      return {
        provider,
        configured: Boolean(row),
        isActive: row?.is_active ?? false,
        apiKeyHint: row?.api_key_hint ?? null,
        status: row?.status ?? "NOT_CONFIGURED",
        lastValidatedAt: row?.last_validated_at ?? null,
        lastError: row?.last_error ?? null,
        updatedAt: row?.updated_at ?? null,
        environmentFallbackAvailable: Boolean(envKey(provider)),
      };
    }),
    resolvedProvider,
    resolvedSource,
  };
}

export async function saveAiProviderKey(params: {
  provider: AiProvider;
  apiKey: string;
  actorUserId: string;
}): Promise<void> {
  const apiKey = params.apiKey.trim();
  if (apiKey.length < 12 || apiKey.length > 500) {
    throw new Error("Secret key must be between 12 and 500 characters.");
  }
  const supabase = createAdminClient();
  const { error } = await supabase.from("ai_provider_settings").upsert({
    provider: params.provider,
    encrypted_api_key: encryptSecret(apiKey),
    api_key_hint: maskAiApiKey(apiKey),
    status: "NOT_CONFIGURED",
    is_active: false,
    last_validated_at: null,
    last_error: null,
    created_by: params.actorUserId,
    updated_by: params.actorUserId,
  }, { onConflict: "provider" });
  if (error) throw new Error(`Failed to save AI provider: ${error.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "AI_PROVIDER_KEY_UPDATED",
    entityType: "ai_provider_setting",
    entityId: null,
    metadata: { provider: params.provider },
  });
}

export async function testStoredAiProvider(params: {
  provider: AiProvider;
  actorUserId: string;
}): Promise<ProviderValidationResult> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_provider_settings")
    .select("encrypted_api_key")
    .eq("provider", params.provider)
    .maybeSingle();
  if (error) throw new Error(`Failed to load AI provider: ${error.message}`);
  if (!data?.encrypted_api_key) throw new Error("Save a provider key before testing it.");

  let apiKey: string;
  try {
    apiKey = decryptSecret(data.encrypted_api_key as string);
  } catch {
    throw new Error("The stored key cannot be decrypted. Rotate it before testing.");
  }

  const validation = await validateProviderKey(params.provider, apiKey);
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("ai_provider_settings")
    .update({
      status: validation.valid ? "VALID" : "INVALID",
      last_validated_at: now,
      last_error: validation.error,
      is_active: validation.valid ? undefined : false,
      updated_by: params.actorUserId,
    })
    .eq("provider", params.provider);
  if (updateError) throw new Error(`Failed to record provider validation: ${updateError.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "AI_PROVIDER_VALIDATED",
    entityType: "ai_provider_setting",
    entityId: null,
    metadata: { provider: params.provider, valid: validation.valid },
  });
  return validation;
}

export async function activateAiProvider(params: {
  provider: AiProvider;
  actorUserId: string;
}): Promise<void> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_provider_settings")
    .select("status")
    .eq("provider", params.provider)
    .maybeSingle();
  if (error) throw new Error(`Failed to load AI provider: ${error.message}`);
  if (data?.status !== "VALID") throw new Error("Test this provider successfully before activating it.");

  const { error: deactivateError } = await supabase
    .from("ai_provider_settings")
    .update({ is_active: false, updated_by: params.actorUserId })
    .neq("provider", params.provider);
  if (deactivateError) throw new Error(`Failed to switch AI provider: ${deactivateError.message}`);
  const { error: activateError } = await supabase
    .from("ai_provider_settings")
    .update({ is_active: true, updated_by: params.actorUserId })
    .eq("provider", params.provider);
  if (activateError) throw new Error(`Failed to activate AI provider: ${activateError.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "AI_PROVIDER_ACTIVATED",
    entityType: "ai_provider_setting",
    entityId: null,
    metadata: { provider: params.provider },
  });
}

export async function deleteAiProviderKey(params: {
  provider: AiProvider;
  actorUserId: string;
}): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("ai_provider_settings")
    .delete()
    .eq("provider", params.provider);
  if (error) throw new Error(`Failed to delete AI provider key: ${error.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "AI_PROVIDER_KEY_DELETED",
    entityType: "ai_provider_setting",
    entityId: null,
    metadata: { provider: params.provider },
  });
}

export type { ProviderValidationResult };
