if (typeof window !== "undefined") {
  throw new Error("[aurix] MetaApiBrokerAdapter is server-only.");
}

import type { TradeDto, TraderAccountSummary } from "@/lib/domain/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BROKER_EXEC_ERROR,
  type BrokerAdapter,
  type BrokerConnectionHealth,
  BrokerExecutionError,
  type BrokerExecutionResult,
  type CloseTradeRequest,
  type ModifyTradeRequest,
  type OpenTradeRequest,
} from "./BrokerAdapter";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────────────────────────
// MetaAPI broker adapter (server-only).
//
// Execution methods are implemented against the verified metaapi.cloud-sdk v29
// RPC API (createMarketBuyOrder / createMarketSellOrder / closePosition /
// modifyPosition). Because real order placement cannot be verified without a
// live broker, executionAvailable() additionally requires the explicit env flag
// BROKER_EXECUTION_ENABLED=true — so live copy stays OFF by default and the copy
// bridge keeps returning COPY_EXECUTION_NOT_CONFIGURED until an operator enables
// it after demo testing. Errors are surfaced, never faked.
// ─────────────────────────────────────────────────────────────────────────────

// MQL trade return codes that indicate success.
const SUCCESS_NUMERIC = new Set([0, 10008, 10009, 10010, 10025]);
const SUCCESS_STRING = new Set([
  "ERR_NO_ERROR",
  "TRADE_RETCODE_PLACED",
  "TRADE_RETCODE_DONE",
  "TRADE_RETCODE_DONE_PARTIAL",
  "TRADE_RETCODE_NO_CHANGES",
]);

let sharedExecutionApi: any | null = null;
const sharedExecutionConnections = new Map<string, Promise<any>>();

export class MetaApiBrokerAdapter implements BrokerAdapter {
  private readonly token = process.env.METAAPI_TOKEN;
  private readonly reliability = process.env.METAAPI_RELIABILITY === "high" ? "high" : "regular";

  /**
   * Execution is only "available" when a token is present AND the operator has
   * explicitly opted in via BROKER_EXECUTION_ENABLED. This is the live safety
   * switch: with it unset, the copy engine reports COPY_EXECUTION_NOT_CONFIGURED.
   */
  executionAvailable(): boolean {
    return Boolean(this.token) && process.env.BROKER_EXECUTION_ENABLED === "true";
  }

  private assertConfigured() {
    if (!this.token) {
      throw new BrokerExecutionError(
        BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED,
        "METAAPI_TOKEN is not configured.",
        503,
      );
    }
  }

  private async resolveProviderAccountId(accountId: string): Promise<string> {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("trading_accounts")
      .select("provider_account_id, status")
      .eq("id", accountId)
      .maybeSingle();
    if (!data) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.ACCOUNT_NOT_FOUND, "Trading account not found.", 404);
    }
    if (!data.provider_account_id) {
      throw new BrokerExecutionError(
        BROKER_EXEC_ERROR.ACCOUNT_NOT_CONNECTED,
        "Account is not connected to MetaAPI yet.",
        409,
      );
    }
    return data.provider_account_id as string;
  }

  /**
   * Live-copy orders reuse long-lived RPC connections. This avoids a deploy,
   * websocket handshake and full synchronization for every follower order.
   * The MetaApi SDK owns reconnects; a failed initial connection is evicted.
   */
  private async withExecutionConnection<T>(accountId: string, fn: (connection: any) => Promise<T>): Promise<T> {
    this.assertConfigured();
    if (!this.executionAvailable()) {
      throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED, "Broker execution is disabled.", 503);
    }
    const providerAccountId = await this.resolveProviderAccountId(accountId);
    if (!sharedExecutionConnections.has(providerAccountId)) {
      const pending = (async () => {
        const MetaApi = ((await import("metaapi.cloud-sdk/node")) as any).default;
        sharedExecutionApi ??= new MetaApi(this.token);
        const metaAccount = await sharedExecutionApi.metatraderAccountApi.getAccount(providerAccountId);
        if (metaAccount.state !== "DEPLOYED") {
          await metaAccount.deploy();
          await metaAccount.waitDeployed(120, 1000);
        }
        await metaAccount.waitConnected(120, 1000);
        const connection = metaAccount.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized(120);
        return connection;
      })();
      sharedExecutionConnections.set(providerAccountId, pending);
      pending.catch(() => sharedExecutionConnections.delete(providerAccountId));
    }
    const connection = await sharedExecutionConnections.get(providerAccountId)!;
    return fn(connection);
  }

  /** Open a deployed, synchronized RPC connection, run fn, then always close. */
  private async withConnection<T>(accountId: string, fn: (connection: any) => Promise<T>): Promise<T> {
    this.assertConfigured();
    const providerAccountId = await this.resolveProviderAccountId(accountId);

    const MetaApi = ((await import("metaapi.cloud-sdk/node")) as any).default;
    const api = new MetaApi(this.token);
    let connection: any = null;
    try {
      const metaAccount = await api.metatraderAccountApi.getAccount(providerAccountId);
      if (metaAccount.state !== "DEPLOYED") {
        await metaAccount.deploy();
        await metaAccount.waitDeployed(90, 1000);
      }
      await metaAccount.waitConnected(60, 1000);
      connection = metaAccount.getRPCConnection();
      await connection.connect();
      await connection.waitSynchronized(60);
      return await fn(connection);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch {
          /* ignore */
        }
      }
      try {
        api.close();
      } catch {
        /* ignore */
      }
    }
  }

  private interpretTradeResponse(resp: any): BrokerExecutionResult {
    const numeric = resp?.numericCode;
    const str = resp?.stringCode;
    const ok = (typeof numeric === "number" && SUCCESS_NUMERIC.has(numeric)) || SUCCESS_STRING.has(str);
    if (!ok) {
      throw new BrokerExecutionError(
        BROKER_EXEC_ERROR.PROVIDER_ERROR,
        `Broker rejected the trade: ${str ?? numeric ?? "unknown"} ${resp?.message ?? ""}`.trim(),
        502,
      );
    }
    return {
      ok: true,
      brokerOrderId: resp?.orderId,
      brokerPositionId: resp?.positionId,
      // Only safe, non-secret fields are surfaced/logged.
      rawResponse: { numericCode: numeric, stringCode: str, message: resp?.message, orderId: resp?.orderId, positionId: resp?.positionId },
    };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async verifyConnection(accountId: string): Promise<BrokerConnectionHealth> {
    if (!this.token) {
      return { ok: false, provider: "metaapi", message: "METAAPI_TOKEN is not configured." };
    }
    try {
      await this.withConnection(accountId, async () => true);
      return { ok: true, provider: "metaapi", message: "Connected to MetaAPI." };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed.";
      return { ok: false, provider: "metaapi", message };
    }
  }

  async fetchSnapshot(accountId: string): Promise<TraderAccountSummary> {
    return this.withConnection(accountId, async (connection) => {
      const info = await connection.getAccountInformation();
      const balance = Number(info?.balance ?? 0);
      const equity = Number(info?.equity ?? 0);
      return {
        accountId,
        accountName: "",
        brokerName: info?.brokerName ?? "",
        serverName: info?.server ?? null,
        platform: null,
        status: "CONNECTED",
        balance: { amount: balance, currency: info?.currency ?? "USD" },
        equity: { amount: equity, currency: info?.currency ?? "USD" },
        floatingPnl: { amount: Number((equity - balance).toFixed(2)), currency: info?.currency ?? "USD" },
        openTradeCount: 0,
        drawdownPercent: balance > 0 ? Math.max(0, ((balance - equity) / balance) * 100) : 0,
        updatedAt: new Date().toISOString(),
      } satisfies TraderAccountSummary;
    });
  }

  async fetchOpenTrades(accountId: string): Promise<TradeDto[]> {
    return this.withConnection(accountId, async (connection) => {
      const positions: any[] = (await connection.getPositions()) ?? [];
      return positions.map((p) => ({
        id: String(p.id),
        shortTradeId: `LIVE-${String(p.id).slice(-8).toUpperCase()}`,
        accountId,
        symbol: p.symbol ?? "",
        side: p.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL",
        status: "OPEN" as const,
        volume: Number(p.volume ?? 0),
        openPrice: Number(p.openPrice ?? 0),
        closePrice: null,
        profit: { amount: Number(p.profit ?? 0), currency: "USD" },
        openedAt: p.openTime ? new Date(p.openTime).toISOString() : new Date().toISOString(),
        closedAt: null,
      }));
    });
  }

  async fetchTradeHistory(accountId: string): Promise<TradeDto[]> {
    return this.withConnection(accountId, async (connection) => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const dealsResult = await connection.getDealsByTimeRange(since, new Date());
      const deals: any[] = Array.isArray(dealsResult) ? dealsResult : (dealsResult?.deals ?? []);
      return deals
        .filter((d) => d.entryType === "DEAL_ENTRY_OUT")
        .map((d) => ({
          id: String(d.positionId ?? d.id),
          shortTradeId: `LIVE-${String(d.positionId ?? d.id).slice(-8).toUpperCase()}`,
          accountId,
          symbol: d.symbol ?? "",
          side: d.type === "DEAL_TYPE_BUY" ? "BUY" : "SELL",
          status: "CLOSED" as const,
          volume: Number(d.volume ?? 0),
          openPrice: 0,
          closePrice: Number(d.price ?? 0),
          profit: { amount: Number(d.profit ?? 0), currency: "USD" },
          openedAt: d.time ? new Date(d.time).toISOString() : new Date().toISOString(),
          closedAt: d.time ? new Date(d.time).toISOString() : new Date().toISOString(),
        }));
    });
  }

  // ── Execution ────────────────────────────────────────────────────────────────

  async openTrade(req: OpenTradeRequest): Promise<BrokerExecutionResult> {
    return this.withExecutionConnection(req.accountId, async (connection) => {
      const options = {
        ...(req.comment ? { comment: req.comment } : {}),
        ...(req.magic !== null && req.magic !== undefined ? { magic: req.magic } : {}),
        ...(req.slippage !== null && req.slippage !== undefined ? { slippage: req.slippage } : {}),
      };
      const resp =
        req.side === "BUY"
          ? await connection.createMarketBuyOrder(
              req.symbol,
              req.volume,
              req.stopLoss ?? undefined,
              req.takeProfit ?? undefined,
              Object.keys(options).length ? options : undefined,
            )
          : await connection.createMarketSellOrder(
              req.symbol,
              req.volume,
              req.stopLoss ?? undefined,
              req.takeProfit ?? undefined,
              Object.keys(options).length ? options : undefined,
            );
      const result = this.interpretTradeResponse(resp);
      return { ...result, executedVolume: req.volume };
    });
  }

  async closeTrade(req: CloseTradeRequest): Promise<BrokerExecutionResult> {
    return this.withExecutionConnection(req.accountId, async (connection) => {
      const options = req.comment ? { comment: req.comment } : {};
      const resp = req.volume && req.volume > 0
        ? await connection.closePositionPartially(req.brokerPositionId, req.volume, options)
        : await connection.closePosition(req.brokerPositionId, options);
      return this.interpretTradeResponse(resp);
    });
  }

  async modifyTrade(req: ModifyTradeRequest): Promise<BrokerExecutionResult> {
    return this.withExecutionConnection(req.accountId, async (connection) => {
      const resp = await connection.modifyPosition(
        req.brokerPositionId,
        req.stopLoss ?? undefined,
        req.takeProfit ?? undefined,
      );
      return this.interpretTradeResponse(resp);
    });
  }

  // ── Account lifecycle (cost management) ───────────────────────────────────

  /** Undeploy a MetaAPI account to stop billing. Credentials are preserved. */
  async deactivateAccount(providerAccountId: string): Promise<void> {
    this.assertConfigured();
    const MetaApi = ((await import("metaapi.cloud-sdk/node")) as any).default;
    const api = new MetaApi(this.token);
    try {
      const metaAccount = await api.metatraderAccountApi.getAccount(providerAccountId);
      if (metaAccount.state !== "UNDEPLOYED") {
        await metaAccount.undeploy();
        await metaAccount.waitUndeployed(120, 2000);
      }
    } finally {
      try { api.close(); } catch { /* ignore */ }
    }
  }

  /** Redeploy a previously undeployed MetaAPI account. */
  async reactivateAccount(providerAccountId: string): Promise<void> {
    this.assertConfigured();
    const MetaApi = ((await import("metaapi.cloud-sdk/node")) as any).default;
    const api = new MetaApi(this.token);
    try {
      const metaAccount = await api.metatraderAccountApi.getAccount(providerAccountId);
      if (metaAccount.state !== "DEPLOYED") {
        await metaAccount.deploy();
        await metaAccount.waitDeployed(120, 2000);
      }
    } finally {
      try { api.close(); } catch { /* ignore */ }
    }
  }
}
