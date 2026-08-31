if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeServerDiscoveryService is server-only.");
}

import { Api2TradeClient, loadApi2TradeConfig } from "@/lib/broker/api2TradeClient";
import { publicBrokerConnectionError } from "@/lib/broker/api2TradeErrors";

export interface Api2TradeDiscoveredBrokerServer {
  brokerName: string;
  serverName: string;
  access: string[];
}

export interface Api2TradeBrokerServerDiscoveryResult {
  available: boolean;
  servers: Api2TradeDiscoveredBrokerServer[];
  message: string | null;
}

export async function searchApi2TradeServers(params: {
  query: string;
  seedAccountId?: string | null;
}): Promise<Api2TradeBrokerServerDiscoveryResult> {
  const config = loadApi2TradeConfig();
  if (!config) {
    return {
      available: false,
      servers: [],
      message: "Broker server discovery is not configured.",
    };
  }

  const query = params.query.trim().slice(0, 100);
  if (query.length < 1) {
    return {
      available: true,
      servers: [],
      message: "Enter a broker or server name to search known MetaTrader servers.",
    };
  }

  if (config.apiKey && !params.seedAccountId) {
    return {
      available: false,
      servers: [],
      message: "Live broker server lookup becomes available after at least one account has been connected on this workspace. You can still enter the exact server manually.",
    };
  }

  try {
    const client = new Api2TradeClient(config);
    const companies = await client.searchBroker(query, params.seedAccountId ?? undefined);
    const servers: Api2TradeDiscoveredBrokerServer[] = [];
    for (const company of companies) {
      const brokerName = (company.companyName ?? query).trim().slice(0, 120);
      for (const result of company.results ?? []) {
        const serverName = result.name?.trim();
        if (!serverName) continue;
        servers.push({
          brokerName,
          serverName: serverName.slice(0, 160),
          access: (result.access ?? []).filter(Boolean).slice(0, 50),
        });
      }
    }
    return {
      available: true,
      servers: servers.slice(0, 100),
      message: servers.length === 0
        ? "No broker servers matched this search. You can still enter the exact server manually."
        : null,
    };
  } catch (error) {
    return {
      available: false,
      servers: [],
      message: publicBrokerConnectionError(error) || "Broker server search is temporarily unavailable.",
    };
  }
}
