if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeServerDiscoveryService is server-only.");
}

import { Api2TradeClient, loadApi2TradeConfig } from "@/lib/broker/api2TradeClient";
import { publicApi2TradeError } from "@/lib/broker/api2TradeErrors";

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
}): Promise<Api2TradeBrokerServerDiscoveryResult> {
  const config = loadApi2TradeConfig();
  if (!config) {
    return {
      available: false,
      servers: [],
      message: "API2Trade server discovery is not configured.",
    };
  }

  const query = params.query.trim().slice(0, 100);
  if (query.length < 2) {
    return {
      available: true,
      servers: [],
      message: "Enter at least two characters to search known MetaTrader servers.",
    };
  }

  if (config.apiKey) {
    return {
      available: false,
      servers: [],
      message: "Live API2Trade server lookup is unavailable before account registration on this tenant. Select a configured server or enter the exact server manually.",
    };
  }

  try {
    const client = new Api2TradeClient(config);
    const companies = await client.searchBroker(query);
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
        ? "No API2Trade broker servers matched this search. You can still enter an exact server manually."
        : null,
    };
  } catch (error) {
    return {
      available: false,
      servers: [],
      message: publicApi2TradeError(error) || "API2Trade server search is temporarily unavailable.",
    };
  }
}
