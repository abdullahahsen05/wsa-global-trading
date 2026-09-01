if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeBrokerDiscoveryService is server-only.");
}

import { Api2TradeClient, loadApi2TradeConfig } from "@/lib/broker/api2TradeClient";
import { publicBrokerConnectionError } from "@/lib/broker/api2TradeErrors";
import { createAdminClient } from "@/lib/supabase/admin";

export type BrokerPlatform = "MT4" | "MT5";

export interface Api2TradeBrokerSearchResult {
  id: string;
  name: string;
  logoUrl: string | null;
  website: string | null;
  platforms: BrokerPlatform[];
  serverCount: number;
  servers: Array<{
    name: string;
    access: string[];
  }>;
  source: "API2TRADE" | "WORKSPACE";
}

export interface Api2TradeBrokerSearchResponse {
  available: boolean;
  brokers: Api2TradeBrokerSearchResult[];
  message: string | null;
  cached: boolean;
}

type CacheEntry = {
  expiresAt: number;
  response: Api2TradeBrokerSearchResponse;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const EMPTY_QUERY_CACHE_TTL_MS = 90 * 1000;
const brokerSearchCache = new Map<string, CacheEntry>();

function cacheGet(key: string): Api2TradeBrokerSearchResponse | null {
  const entry = brokerSearchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    brokerSearchCache.delete(key);
    return null;
  }
  return { ...entry.response, cached: true };
}

function cacheSet(key: string, response: Api2TradeBrokerSearchResponse, ttlMs = CACHE_TTL_MS) {
  brokerSearchCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    response: { ...response, cached: false },
  });
}

function stableId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "broker";
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function inferPlatformsFromServers(servers: Array<{ name: string }>, requested?: BrokerPlatform): BrokerPlatform[] {
  if (requested) return [requested];
  const platforms = new Set<BrokerPlatform>();
  for (const server of servers) {
    if (/\bmt4\b|metatrader\s*4/i.test(server.name)) platforms.add("MT4");
    if (/\bmt5\b|metatrader\s*5/i.test(server.name)) platforms.add("MT5");
  }
  if (platforms.size === 0) platforms.add("MT5");
  return [...platforms];
}

async function loadWorkspaceBrokerRecommendations(params: {
  userId: string;
  role: string;
  platform?: BrokerPlatform;
}): Promise<Api2TradeBrokerSearchResult[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("trading_accounts")
    .select("broker_name, broker_server, broker_platform, last_synced_at, updated_at")
    .not("broker_name", "is", null)
    .order("last_synced_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(20);

  if (params.role === "TRADER") {
    query = query.eq("user_id", params.userId);
  }
  if (params.platform) {
    query = query.eq("broker_platform", params.platform);
  }

  const { data } = await query;
  const byName = new Map<string, Api2TradeBrokerSearchResult>();
  for (const row of data ?? []) {
    const name = String(row.broker_name ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const serverName = String(row.broker_server ?? "").trim();
    const platform = row.broker_platform === "MT4" || row.broker_platform === "MT5"
      ? row.broker_platform
      : params.platform ?? "MT5";
    const existing = byName.get(key);
    if (existing) {
      if (serverName && !existing.servers.some((server) => server.name === serverName)) {
        existing.servers.push({ name: serverName, access: [] });
        existing.serverCount = existing.servers.length;
      }
      if (!existing.platforms.includes(platform)) existing.platforms.push(platform);
      continue;
    }
    byName.set(key, {
      id: `workspace:${stableId(name)}`,
      name,
      logoUrl: null,
      website: null,
      platforms: [platform],
      serverCount: serverName ? 1 : 0,
      servers: serverName ? [{ name: serverName, access: [] }] : [],
      source: "WORKSPACE",
    });
  }
  return [...byName.values()].slice(0, 8);
}

export async function searchApi2TradeBrokers(params: {
  query: string;
  platform?: BrokerPlatform;
  userId: string;
  role: string;
}): Promise<Api2TradeBrokerSearchResponse> {
  const config = loadApi2TradeConfig();
  if (!config) {
    return {
      available: false,
      brokers: [],
      message: "Broker discovery is temporarily unavailable. Enter the broker and server manually.",
      cached: false,
    };
  }

  const query = params.query.trim().slice(0, 100);
  const normalizedQuery = query.toLowerCase();
  const cacheKey = normalizedQuery
    ? `api2trade:${params.platform ?? "ANY"}:${normalizedQuery}`
    : `workspace:${params.userId}:${params.role}:${params.platform ?? "ANY"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    if (!normalizedQuery) {
      const recommendations = await loadWorkspaceBrokerRecommendations(params);
      const response: Api2TradeBrokerSearchResponse = {
        available: true,
        brokers: recommendations,
        message: recommendations.length
          ? "Showing brokers already used in this workspace. Start typing to search live broker data."
          : "Start typing a broker name to search live broker data.",
        cached: false,
      };
      cacheSet(cacheKey, response, EMPTY_QUERY_CACHE_TTL_MS);
      return response;
    }

    const client = new Api2TradeClient(config);
    const companies = await client.searchBroker(query);
    const byName = new Map<string, Api2TradeBrokerSearchResult>();

    for (const company of companies) {
      const record = company as unknown as Record<string, unknown>;
      const name = (company.companyName ?? "").trim();
      if (!name) continue;
      const servers = (company.results ?? [])
        .map((result) => ({
          name: result.name?.trim() ?? "",
          access: (result.access ?? []).filter(Boolean).slice(0, 50),
        }))
        .filter((server) => server.name);
      const existing = byName.get(name.toLowerCase());
      const broker: Api2TradeBrokerSearchResult = existing ?? {
        id: `api2trade:${stableId(name)}`,
        name,
        logoUrl: pickString(record, ["logoUrl", "logo", "icon", "image"]),
        website: pickString(record, ["website", "site", "url"]),
        platforms: inferPlatformsFromServers(servers, params.platform),
        serverCount: 0,
        servers: [],
        source: "API2TRADE",
      };
      for (const server of servers) {
        if (!broker.servers.some((item) => item.name === server.name)) {
          broker.servers.push(server);
        }
      }
      broker.serverCount = broker.servers.length;
      byName.set(name.toLowerCase(), broker);
    }

    const brokers = [...byName.values()]
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        return aStarts - bStarts || b.serverCount - a.serverCount || a.name.localeCompare(b.name);
      })
      .slice(0, 25);

    const response: Api2TradeBrokerSearchResponse = {
      available: true,
      brokers,
      message: brokers.length ? null : "No brokers matched this search. You can still enter the broker/server manually.",
      cached: false,
    };
    cacheSet(cacheKey, response);
    return response;
  } catch (error) {
    return {
      available: false,
      brokers: [],
      message: publicBrokerConnectionError(error) || "Broker search is temporarily unavailable. Enter the broker and server manually.",
      cached: false,
    };
  }
}
