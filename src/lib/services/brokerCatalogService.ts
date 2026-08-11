import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";

export type BrokerPlatform = "MT4" | "MT5";

export interface BrokerProviderDto {
  id: string;
  name: string;
  displayName: string;
  platformsSupported: BrokerPlatform[];
  isActive: boolean;
  serverCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerServerDto {
  id: string;
  brokerProviderId: string;
  platform: BrokerPlatform;
  serverName: string;
  source: "MANUAL" | "METAAPI" | "API2TRADE";
  isActive: boolean;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "broker";
}

function mapServer(row: Record<string, unknown>): BrokerServerDto {
  return {
    id: row.id as string,
    brokerProviderId: row.broker_provider_id as string,
    platform: row.platform as BrokerPlatform,
    serverName: row.server_name as string,
    source: row.source as "MANUAL" | "METAAPI" | "API2TRADE",
    isActive: row.is_active as boolean,
    lastRefreshedAt: row.last_refreshed_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listBrokerProviders(params?: {
  platform?: BrokerPlatform;
  includeInactive?: boolean;
}): Promise<BrokerProviderDto[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("broker_providers")
    .select("id, name, display_name, platforms_supported, is_active, created_at, updated_at")
    .order("display_name");
  if (!params?.includeInactive) query = query.eq("is_active", true);
  if (params?.platform) query = query.contains("platforms_supported", [params.platform]);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load broker providers: ${error.message}`);

  const ids = (data ?? []).map((row) => row.id);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: servers, error: serverError } = await supabase
      .from("broker_servers")
      .select("broker_provider_id")
      .in("broker_provider_id", ids);
    if (serverError) throw new Error(`Failed to load broker server counts: ${serverError.message}`);
    for (const server of servers ?? []) {
      counts.set(server.broker_provider_id, (counts.get(server.broker_provider_id) ?? 0) + 1);
    }
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    platformsSupported: row.platforms_supported as BrokerPlatform[],
    isActive: row.is_active,
    serverCount: counts.get(row.id) ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getBrokerProvider(
  brokerProviderId: string,
): Promise<BrokerProviderDto | null> {
  const providers = await listBrokerProviders({ includeInactive: true });
  return providers.find((provider) => provider.id === brokerProviderId) ?? null;
}

export async function listBrokerServers(params: {
  brokerProviderId: string;
  platform?: BrokerPlatform;
  includeInactive?: boolean;
}): Promise<BrokerServerDto[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("broker_servers")
    .select("id, broker_provider_id, platform, server_name, source, is_active, last_refreshed_at, created_at, updated_at")
    .eq("broker_provider_id", params.brokerProviderId)
    .order("platform")
    .order("server_name");
  if (!params.includeInactive) query = query.eq("is_active", true);
  if (params.platform) query = query.eq("platform", params.platform);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load broker servers: ${error.message}`);
  return (data ?? []).map((row) => mapServer(row as Record<string, unknown>));
}

export async function createBrokerProvider(params: {
  displayName: string;
  platformsSupported: BrokerPlatform[];
  actorUserId: string;
}): Promise<BrokerProviderDto> {
  const supabase = createAdminClient();
  const baseName = slugify(params.displayName);
  let name = baseName;
  let suffix = 1;
  while (true) {
    const { data } = await supabase.from("broker_providers").select("id").eq("name", name).maybeSingle();
    if (!data) break;
    suffix += 1;
    name = `${baseName}-${suffix}`;
  }
  const { data, error } = await supabase
    .from("broker_providers")
    .insert({
      name,
      display_name: params.displayName.trim(),
      platforms_supported: [...new Set(params.platformsSupported)],
      created_by: params.actorUserId,
      updated_by: params.actorUserId,
    })
    .select("id, name, display_name, platforms_supported, is_active, created_at, updated_at")
    .single();
  if (error || !data) throw new Error(`Failed to create broker provider: ${error?.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "BROKER_PROVIDER_CREATED",
    entityType: "broker_provider",
    entityId: data.id,
    metadata: { platforms: data.platforms_supported },
  });
  return {
    id: data.id,
    name: data.name,
    displayName: data.display_name,
    platformsSupported: data.platforms_supported as BrokerPlatform[],
    isActive: data.is_active,
    serverCount: 0,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function updateBrokerProvider(params: {
  id: string;
  patch: { displayName?: string; platformsSupported?: BrokerPlatform[]; isActive?: boolean };
  actorUserId: string;
}): Promise<void> {
  const update: Record<string, unknown> = { updated_by: params.actorUserId };
  if (params.patch.displayName !== undefined) update.display_name = params.patch.displayName.trim();
  if (params.patch.platformsSupported !== undefined) {
    update.platforms_supported = [...new Set(params.patch.platformsSupported)];
  }
  if (params.patch.isActive !== undefined) update.is_active = params.patch.isActive;
  const supabase = createAdminClient();
  const { error } = await supabase.from("broker_providers").update(update).eq("id", params.id);
  if (error) throw new Error(`Failed to update broker provider: ${error.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "BROKER_PROVIDER_UPDATED",
    entityType: "broker_provider",
    entityId: params.id,
    metadata: { fields: Object.keys(params.patch) },
  });
}

export async function createBrokerServer(params: {
  brokerProviderId: string;
  platform: BrokerPlatform;
  serverName: string;
  actorUserId: string;
}): Promise<BrokerServerDto> {
  const supabase = createAdminClient();
  const { data: provider } = await supabase
    .from("broker_providers")
    .select("platforms_supported")
    .eq("id", params.brokerProviderId)
    .maybeSingle();
  if (!provider) throw new Error("Broker provider not found.");
  if (!(provider.platforms_supported as BrokerPlatform[]).includes(params.platform)) {
    throw new Error(`${params.platform} is not enabled for this broker provider.`);
  }
  const { data, error } = await supabase
    .from("broker_servers")
    .insert({
      broker_provider_id: params.brokerProviderId,
      platform: params.platform,
      server_name: params.serverName.trim(),
      source: "MANUAL",
      created_by: params.actorUserId,
      updated_by: params.actorUserId,
    })
    .select("id, broker_provider_id, platform, server_name, source, is_active, last_refreshed_at, created_at, updated_at")
    .single();
  if (error || !data) throw new Error(`Failed to add broker server: ${error?.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "BROKER_SERVER_CREATED",
    entityType: "broker_server",
    entityId: data.id,
    metadata: { providerId: params.brokerProviderId, platform: params.platform },
  });
  return mapServer(data as Record<string, unknown>);
}

export async function updateBrokerServer(params: {
  id: string;
  patch: { serverName?: string; isActive?: boolean };
  actorUserId: string;
}): Promise<void> {
  const update: Record<string, unknown> = { updated_by: params.actorUserId };
  if (params.patch.serverName !== undefined) update.server_name = params.patch.serverName.trim();
  if (params.patch.isActive !== undefined) update.is_active = params.patch.isActive;
  const supabase = createAdminClient();
  const { error } = await supabase.from("broker_servers").update(update).eq("id", params.id);
  if (error) throw new Error(`Failed to update broker server: ${error.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "BROKER_SERVER_UPDATED",
    entityType: "broker_server",
    entityId: params.id,
    metadata: { fields: Object.keys(params.patch) },
  });
}

export async function resolveBrokerSelection(params: {
  brokerProviderId: string;
  platform: BrokerPlatform;
  serverName: string;
  allowUnlistedServer?: boolean;
}): Promise<{ displayName: string; serverName: string }> {
  const supabase = createAdminClient();
  const { data: provider } = await supabase
    .from("broker_providers")
    .select("display_name, platforms_supported, is_active")
    .eq("id", params.brokerProviderId)
    .maybeSingle();
  if (!provider?.is_active) throw new Error("Selected broker provider is not active.");
  if (!(provider.platforms_supported as BrokerPlatform[]).includes(params.platform)) {
    throw new Error("Selected platform is not enabled for this broker.");
  }
  if (params.allowUnlistedServer) {
    return { displayName: provider.display_name, serverName: params.serverName.trim() };
  }
  const { data: server } = await supabase
    .from("broker_servers")
    .select("server_name, is_active")
    .eq("broker_provider_id", params.brokerProviderId)
    .eq("platform", params.platform)
    .eq("server_name", params.serverName)
    .maybeSingle();
  if (!server?.is_active) throw new Error("Selected broker server is not active or no longer configured.");
  return { displayName: provider.display_name, serverName: server.server_name };
}
