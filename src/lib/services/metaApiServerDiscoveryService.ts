if (typeof window !== "undefined") {
  throw new Error("[wsa] metaApiServerDiscoveryService is server-only.");
}

import type { BrokerPlatform } from "@/lib/services/brokerCatalogService";

const METAAPI_PROVISIONING_BASE =
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

export interface DiscoveredBrokerServer {
  brokerName: string;
  serverName: string;
}

export interface BrokerServerDiscoveryResult {
  available: boolean;
  servers: DiscoveredBrokerServer[];
  message: string | null;
}

export async function searchKnownMetaApiServers(params: {
  platform: BrokerPlatform;
  query: string;
}): Promise<BrokerServerDiscoveryResult> {
  const token = process.env.METAAPI_TOKEN;
  if (!token) {
    return {
      available: false,
      servers: [],
      message: "Broker server discovery is not configured.",
    };
  }
  const query = params.query.trim().slice(0, 100);
  if (query.length < 2) {
    return {
      available: true,
      servers: [],
      message: "Enter at least two characters to search known broker servers.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const version = params.platform === "MT4" ? 4 : 5;
    const url = new URL(`${METAAPI_PROVISIONING_BASE}/known-mt-servers/${version}/search`);
    url.searchParams.set("query", query);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "auth-token": token,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        available: false,
        servers: [],
        message: "Broker server search is temporarily unavailable.",
      };
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { available: true, servers: [], message: null };
    }
    const servers: DiscoveredBrokerServer[] = [];
    for (const [brokerName, values] of Object.entries(payload)) {
      if (!Array.isArray(values)) continue;
      for (const serverName of values) {
        if (typeof serverName !== "string" || !serverName.trim()) continue;
        servers.push({
          brokerName: brokerName.slice(0, 120),
          serverName: serverName.trim().slice(0, 160),
        });
      }
    }
    return {
      available: true,
      servers: servers.slice(0, 100),
      message: servers.length === 0
        ? "No broker servers matched this search. You can still enter an exact server manually."
        : null,
    };
  } catch {
    return {
      available: false,
      servers: [],
      message: "Broker server search is temporarily unavailable.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
