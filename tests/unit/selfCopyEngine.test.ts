import { describe, expect, it, vi } from "vitest";
import {
  BROKER_EXEC_ERROR,
  BrokerExecutionError,
  type BrokerAdapter,
  type BrokerExecutionResult,
  type BrokerSymbolInfo,
  type BrokerSymbolSpecifications,
  type BrokerTradingState,
  type CloseTradeRequest,
  type ModifyTradeRequest,
  type OpenTradeRequest,
} from "@/lib/broker/BrokerAdapter";
import { readSelfCopySettings } from "@/lib/copy/selfCopyDecision";
import {
  closeVanishedPositions,
  isUncertainFailure,
  looksAlreadyClosed,
  looksUnchanged,
  planSelfCopyOpen,
  runSelfCopyEvent,
  symbolMayBeWrong,
  type SelfCopyActivity,
  type SelfCopyDeps,
  type SelfCopyFollowerFacts,
  type SelfCopyLink,
  type SelfCopyLinkPatch,
  type SelfCopyPlatform,
  type SelfCopyPositionEvent,
  type SelfCopyRoute,
  type SelfCopyStore,
} from "@/lib/copy/selfCopyEngine";

// ── fakes ────────────────────────────────────────────────────────────────────

const SOURCE = "aaaaaaaa-0000-4000-8000-000000000001";
const FOLLOWER = "bbbbbbbb-0000-4000-8000-000000000002";
const TRADER = "cccccccc-0000-4000-8000-000000000003";
const ROUTE_ID = "11111111-1111-4111-8111-111111111111";

const PLATFORM: SelfCopyPlatform = {
  copyEnabled: true,
  liveCopyEnabled: true,
  emergencyStop: false,
  maxLotSize: null,
  maxCopiedOpenPositions: null,
  maxDailyLossPercent: null,
  maxDrawdownPercent: null,
  maxSlippagePoints: null,
};

const FACTS: SelfCopyFollowerFacts = {
  sourceStatus: "CONNECTED",
  followerStatus: "CONNECTED",
  riskBlocked: false,
  riskMessage: null,
  openCopies: 0,
  sourceBalance: 10_000,
  sourceEquity: 10_000,
  followerBalance: 10_000,
  followerEquity: 10_000,
  dailyLossPercent: null,
  drawdownPercent: null,
};

class FakeStore implements SelfCopyStore {
  routes: SelfCopyRoute[] = [];
  links: SelfCopyLink[] = [];
  activity: SelfCopyActivity[] = [];
  patches: Array<{ id: string; patch: SelfCopyLinkPatch }> = [];
  platformValue: SelfCopyPlatform = { ...PLATFORM };
  facts: SelfCopyFollowerFacts = { ...FACTS };
  failFacts = false;
  failWrite: ((patch: SelfCopyLinkPatch) => boolean) | null = null;
  hideLinkFromFind = false;
  calls = { followerFacts: 0, findLink: 0, reserveLink: 0 };
  private sequence = 0;

  async platform(): Promise<SelfCopyPlatform> {
    return this.platformValue;
  }

  async routesForSource(sourceAccountId: string): Promise<SelfCopyRoute[]> {
    return this.routes.filter((route) => route.sourceAccountId === sourceAccountId && route.status !== "ARCHIVED");
  }

  async followerFacts(): Promise<SelfCopyFollowerFacts> {
    this.calls.followerFacts += 1;
    if (this.failFacts) throw new Error("database down");
    return this.facts;
  }

  async findLink(routeId: string, sourcePositionId: string): Promise<SelfCopyLink | null> {
    this.calls.findLink += 1;
    if (this.hideLinkFromFind) return null;
    const found = this.links.find((link) => link.routeId === routeId && link.sourcePositionId === sourcePositionId);
    return found ? { ...found } : null;
  }

  async reserveLink(input: Parameters<SelfCopyStore["reserveLink"]>[0]): Promise<{ link: SelfCopyLink } | { duplicate: true }> {
    this.calls.reserveLink += 1;
    if (this.links.some((link) => link.routeId === input.routeId && link.sourcePositionId === input.sourcePositionId)) {
      return { duplicate: true as const };
    }
    this.sequence += 1;
    const link: SelfCopyLink = {
      id: `link-${this.sequence}`,
      routeId: input.routeId,
      traderId: input.traderId,
      sourceAccountId: input.sourceAccountId,
      followerAccountId: input.followerAccountId,
      sourcePositionId: input.sourcePositionId,
      followerPositionId: null,
      symbol: input.symbol,
      side: input.side,
      copiedVolume: input.volume,
      status: "PENDING",
      errorCode: null,
    };
    this.links.push(link);
    return { link: { ...link } };
  }

  async updateLink(id: string, patch: SelfCopyLinkPatch): Promise<void> {
    this.patches.push({ id, patch });
    if (this.failWrite?.(patch)) throw new Error("the database did not answer");
    const link = this.links.find((entry) => entry.id === id);
    if (!link) throw new Error(`no link ${id}`);
    if (patch.status !== undefined) link.status = patch.status;
    if (patch.symbol !== undefined) link.symbol = patch.symbol;
    if (patch.side !== undefined) link.side = patch.side;
    if (patch.followerPositionId !== undefined) link.followerPositionId = patch.followerPositionId;
    if (patch.copiedVolume !== undefined) link.copiedVolume = patch.copiedVolume;
    if (patch.errorCode !== undefined) link.errorCode = patch.errorCode;
  }

  async openLinks(sourceAccountId: string, sourcePositionId: string): Promise<SelfCopyLink[]> {
    return this.links
      .filter(
        (link) =>
          link.sourceAccountId === sourceAccountId &&
          link.sourcePositionId === sourcePositionId &&
          link.status === "OPEN" &&
          link.followerPositionId !== null,
      )
      .map((link) => ({ ...link }));
  }

  async claimClose(sourceAccountId: string, sourcePositionId: string) {
    const matching = this.links.filter((link) => link.sourceAccountId === sourceAccountId && link.sourcePositionId === sourcePositionId);
    const claimed = matching.filter((link) => link.status === "OPEN" && link.followerPositionId !== null);
    for (const link of claimed) link.status = "CLOSING";
    const withoutTicket = matching.filter((link) => link.status === "OPEN" && link.followerPositionId === null);
    return { claimed: claimed.map((link) => ({ ...link })), withoutTicket: withoutTicket.map((link) => ({ ...link })) };
  }

  async openSourcePositionIds(sourceAccountId: string): Promise<string[]> {
    return [
      ...new Set(
        this.links
          .filter((link) => link.sourceAccountId === sourceAccountId && link.status === "OPEN" && link.followerPositionId !== null)
          .map((link) => link.sourcePositionId),
      ),
    ];
  }

  record(activity: SelfCopyActivity): void {
    this.activity.push(activity);
  }
}

function specs(symbol: string): BrokerSymbolSpecifications {
  const gold = /XAU|GOLD/i.test(symbol);
  return {
    symbol,
    tickSize: gold ? 0.01 : 0.00001,
    tickValue: 1,
    contractSize: gold ? 100 : 100_000,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 100,
    accountCurrency: "USD",
    profitCurrency: "USD",
    accountCurrencyConversionRate: 1,
  };
}

function createBroker(symbols: BrokerSymbolInfo[] | null) {
  let counter = 0;
  return {
    executionAvailable: vi.fn((): boolean => true),
    openTrade: vi.fn(async (request: OpenTradeRequest): Promise<BrokerExecutionResult> => {
      counter += 1;
      return { ok: true, brokerOrderId: `O-${counter}`, brokerPositionId: `F-${counter}`, executedVolume: request.volume };
    }),
    closeTrade: vi.fn<(request: CloseTradeRequest) => Promise<BrokerExecutionResult>>(async () => ({ ok: true })),
    modifyTrade: vi.fn<(request: ModifyTradeRequest) => Promise<BrokerExecutionResult>>(async () => ({ ok: true })),
    fetchSymbolSpecifications: vi.fn(
      async (_accountId: string, symbol: string): Promise<BrokerSymbolSpecifications | null> => specs(symbol),
    ),
    fetchTradingState: vi.fn(async (): Promise<BrokerTradingState> => {
      throw new Error("the account state was not set up");
    }),
    ...(symbols ? { fetchSymbolList: vi.fn(async (): Promise<BrokerSymbolInfo[]> => symbols) } : {}),
  };
}

const symbol = (name: string, digits: number | null = 5): BrokerSymbolInfo => ({ name, description: null, path: null, digits });

function route(settings: Record<string, unknown> = {}, overrides: Partial<SelfCopyRoute> = {}): SelfCopyRoute {
  return {
    id: ROUTE_ID,
    traderId: TRADER,
    sourceAccountId: SOURCE,
    followerAccountId: FOLLOWER,
    status: "LIVE",
    settings: readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 0.5, ...settings }),
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function link(overrides: Partial<SelfCopyLink> = {}): SelfCopyLink {
  return {
    id: "link-pre",
    routeId: ROUTE_ID,
    traderId: TRADER,
    sourceAccountId: SOURCE,
    followerAccountId: FOLLOWER,
    sourcePositionId: "100",
    followerPositionId: "F-9",
    symbol: "EURUSD",
    side: "BUY",
    copiedVolume: 0.5,
    status: "OPEN",
    errorCode: null,
    ...overrides,
  };
}

function openEvent(overrides: Partial<SelfCopyPositionEvent> = {}): SelfCopyPositionEvent {
  return {
    sourceAccountId: SOURCE,
    eventType: "OPEN",
    sourcePositionId: "100",
    symbol: "EURUSD",
    side: "BUY",
    volume: 1,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    ...overrides,
  };
}

function modifyEvent(overrides: Partial<SelfCopyPositionEvent> = {}): SelfCopyPositionEvent {
  return openEvent({ eventType: "MODIFY", previousVolume: 1, ...overrides });
}

function closeEvent(overrides: Partial<SelfCopyPositionEvent> = {}): SelfCopyPositionEvent {
  return openEvent({ eventType: "CLOSE", ...overrides });
}

function setup(options: { routes?: SelfCopyRoute[]; symbols?: BrokerSymbolInfo[] | null; now?: () => number } = {}) {
  const store = new FakeStore();
  store.routes = options.routes ?? [route()];
  const broker = createBroker(options.symbols ?? null);
  const logs: string[] = [];
  const deps: SelfCopyDeps = {
    adapter: broker as unknown as BrokerAdapter,
    store,
    wait: async () => undefined,
    log: (line) => logs.push(line),
    ...(options.now ? { now: options.now } : {}),
  };
  return { store, broker, deps, logs };
}

function last<T>(items: T[]): T {
  return items[items.length - 1];
}

const providerError = (message: string) => new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_ERROR, message);

// ── OPEN ─────────────────────────────────────────────────────────────────────

describe("self-copy OPEN", () => {
  it("copies a new position to the follower and records the link and the activity", async () => {
    const { store, broker, deps } = setup();
    const summary = await runSelfCopyEvent(deps, openEvent());

    expect(summary).toEqual({ attempted: 1, success: 1, failed: 0, skipped: 0 });
    expect(broker.openTrade).toHaveBeenCalledTimes(1);
    expect(broker.openTrade.mock.calls[0][0]).toMatchObject({
      accountId: FOLLOWER,
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.5,
      stopLoss: 1.09,
      takeProfit: 1.12,
      slippage: null,
      comment: "wsa:self:11111111",
    });
    expect(store.links).toHaveLength(1);
    expect(store.links[0]).toMatchObject({ status: "OPEN", followerPositionId: "F-1", copiedVolume: 0.5, symbol: "EURUSD" });
    expect(store.activity).toHaveLength(1);
    expect(store.activity[0]).toMatchObject({
      outcome: "COPIED",
      code: "OPENED",
      eventType: "OPEN",
      symbol: "EURUSD",
      followerSymbol: "EURUSD",
      side: "BUY",
      sourceVolume: 1,
      copiedVolume: 0.5,
    });
    expect(store.activity[0].timings).toHaveProperty("brokerMs");
    expect(store.activity[0].message).toMatch(/BUY 0\.5 lot EURUSD opened/);
  });

  it("reads the routes itself when the caller has none, and ignores paused ones", async () => {
    const { store, broker, deps } = setup({ routes: [route({}, { status: "PAUSED" })] });
    const summary = await runSelfCopyEvent(deps, openEvent());
    expect(summary).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 0 });
    expect(broker.openTrade).not.toHaveBeenCalled();
    expect(store.activity).toHaveLength(0);
    expect(store.links).toHaveLength(0);
  });

  it("uses the routes the caller hands in", async () => {
    const { store, broker, deps } = setup({ routes: [] });
    const summary = await runSelfCopyEvent(deps, openEvent(), { routes: [route()] });
    expect(summary.success).toBe(1);
    expect(broker.openTrade).toHaveBeenCalledTimes(1);
    expect(store.links).toHaveLength(1);
  });

  it("reserves the link before it sends the order", async () => {
    const { store, broker, deps } = setup();
    const seen: string[] = [];
    broker.openTrade.mockImplementationOnce(async (request) => {
      seen.push(...store.links.map((entry) => entry.status));
      return { ok: true, brokerOrderId: "O-1", brokerPositionId: "F-1", executedVolume: request.volume };
    });
    await runSelfCopyEvent(deps, openEvent());
    expect(seen).toEqual(["PENDING"]);
  });

  describe("never twice", () => {
    it("does not copy a position that was copied already", async () => {
      const { store, broker, deps } = setup();
      await runSelfCopyEvent(deps, openEvent());
      const second = await runSelfCopyEvent(deps, openEvent());
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 1 });
      expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "ALREADY_COPIED" });
    });

    it("treats a lost reservation race as copied already", async () => {
      const { store, broker, deps } = setup();
      store.links.push(link({ status: "PENDING", followerPositionId: null }));
      store.hideLinkFromFind = true;
      const summary = await runSelfCopyEvent(deps, openEvent());
      expect(summary.skipped).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
      expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "ALREADY_COPIED" });
    });

    it("tries again for a copy that failed without reaching the broker", async () => {
      const { store, broker, deps } = setup();
      store.links.push(link({ id: "link-failed", status: "FAILED", followerPositionId: null, errorCode: BROKER_EXEC_ERROR.ACCOUNT_NOT_CONNECTED }));
      const summary = await runSelfCopyEvent(deps, openEvent());
      expect(summary.success).toBe(1);
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
      expect(store.links).toHaveLength(1);
      expect(store.links[0]).toMatchObject({ id: "link-failed", status: "OPEN", errorCode: null, followerPositionId: "F-1" });
    });

    it("does not send an order again after one that got no clear answer", async () => {
      const { store, broker, deps } = setup();
      store.links.push(link({ status: "FAILED", followerPositionId: null, errorCode: BROKER_EXEC_ERROR.PROVIDER_TIMEOUT }));
      const summary = await runSelfCopyEvent(deps, openEvent());
      expect(summary.skipped).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
      expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "ALREADY_COPIED" });
      expect(last(store.activity).message).toMatch(/did not get a clear answer/);
    });

    it("keeps a copy whose link could not be saved from being sent again", async () => {
      const { store, broker, deps } = setup();
      store.failWrite = (patch) => patch.status === "OPEN";
      const first = await runSelfCopyEvent(deps, openEvent());
      expect(first.failed).toBe(1);
      expect(last(store.activity)).toMatchObject({ outcome: "FAILED", code: "LINK_NOT_RECORDED" });
      expect(last(store.activity).message).toMatch(/order was placed/);
      // the link is left reserved (not marked FAILED), so the next signal for the same position does nothing
      expect(store.links[0].status).toBe("PENDING");
      store.failWrite = null;
      const second = await runSelfCopyEvent(deps, openEvent());
      expect(second.skipped).toBe(1);
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
    });
  });

  describe("failures", () => {
    it("records a timed-out order as failed, never sends it again, and says it may exist", async () => {
      const { store, broker, deps } = setup();
      broker.openTrade.mockRejectedValueOnce(new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_TIMEOUT, "The bridge did not answer in 8000 ms", 504));
      const summary = await runSelfCopyEvent(deps, openEvent());
      expect(summary).toEqual({ attempted: 1, success: 0, failed: 1, skipped: 0 });
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
      expect(store.links[0]).toMatchObject({ status: "FAILED", errorCode: BROKER_EXEC_ERROR.PROVIDER_TIMEOUT });
      expect(last(store.activity)).toMatchObject({ outcome: "FAILED", code: BROKER_EXEC_ERROR.PROVIDER_TIMEOUT });
      expect(last(store.activity).message).toMatch(/may still exist/);
    });

    it("tries the next spelling when the broker does not know the symbol", async () => {
      const { store, broker, deps } = setup();
      broker.openTrade.mockImplementation(async (request) => {
        if (request.symbol === "XAUUSD") throw providerError("Symbol XAUUSD not found");
        return { ok: true, brokerOrderId: "O-1", brokerPositionId: "F-1", executedVolume: request.volume };
      });
      const summary = await runSelfCopyEvent(deps, openEvent({ symbol: "XAUUSD", entryPrice: 2300, stopLoss: 2290, takeProfit: 2320 }));
      expect(summary.success).toBe(1);
      expect(broker.openTrade.mock.calls.map((call) => call[0].symbol)).toEqual(["XAUUSD", "GOLD"]);
      expect(store.links[0]).toMatchObject({ status: "OPEN", symbol: "GOLD" });
      expect(last(store.activity).message).toMatch(/XAUUSD as GOLD/);
      expect(last(store.activity).followerSymbol).toBe("GOLD");
    });

    it("does not try other spellings when the broker refuses for another reason", async () => {
      const { store, broker, deps } = setup();
      broker.openTrade.mockRejectedValue(providerError("Not enough money to open the position"));
      const summary = await runSelfCopyEvent(deps, openEvent({ symbol: "XAUUSD", entryPrice: 2300, stopLoss: 2290, takeProfit: 2320 }));
      expect(summary.failed).toBe(1);
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
      expect(store.links[0]).toMatchObject({ status: "FAILED", errorCode: BROKER_EXEC_ERROR.PROVIDER_ERROR });
      expect(last(store.activity).message).toMatch(/Not enough money/);
    });

    it("explains a database failure instead of staying silent", async () => {
      const { store, broker, deps } = setup();
      store.failFacts = true;
      const summary = await runSelfCopyEvent(deps, openEvent());
      expect(summary.failed).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
      expect(store.links).toHaveLength(0);
      expect(last(store.activity)).toMatchObject({ outcome: "FAILED", code: "COPY_ENGINE_ERROR" });
      expect(last(store.activity).message).toMatch(/database down/);
    });

    it("lets one failing follower leave the others alone", async () => {
      const second = "dddddddd-0000-4000-8000-000000000004";
      const third = "eeeeeeee-0000-4000-8000-000000000005";
      const { store, broker, deps } = setup({
        routes: [
          route({}, { id: "11111111-1111-4111-8111-111111111111", followerAccountId: FOLLOWER }),
          route({}, { id: "22222222-2222-4222-8222-222222222222", followerAccountId: second }),
          route({}, { id: "33333333-3333-4333-8333-333333333333", followerAccountId: third }),
        ],
      });
      broker.openTrade.mockImplementation(async (request) => {
        if (request.accountId === second) throw new BrokerExecutionError(BROKER_EXEC_ERROR.ACCOUNT_NOT_CONNECTED, "The account is not connected", 409);
        return { ok: true, brokerOrderId: "O", brokerPositionId: `F-${request.accountId.slice(0, 4)}`, executedVolume: request.volume };
      });
      const summary = await runSelfCopyEvent(deps, openEvent());
      expect(summary).toEqual({ attempted: 3, success: 2, failed: 1, skipped: 0 });
      expect(store.links).toHaveLength(3);
      expect(store.links.filter((entry) => entry.status === "OPEN")).toHaveLength(2);
      expect(store.links.find((entry) => entry.followerAccountId === second)?.status).toBe("FAILED");
      expect(store.activity.map((entry) => entry.outcome).sort()).toEqual(["COPIED", "COPIED", "FAILED"]);
    });
  });

  describe("every skip leaves a reason", () => {
    type Context = ReturnType<typeof setup>;
    const cases: Array<[string, string, (context: Context) => void, Record<string, unknown>?]> = [
      ["live copying switched off", "PLATFORM_LIVE_DISABLED", (c) => void (c.store.platformValue.liveCopyEnabled = false)],
      ["copy trading paused", "PLATFORM_COPY_PAUSED", (c) => void (c.store.platformValue.copyEnabled = false)],
      ["emergency stop", "PLATFORM_EMERGENCY_STOP", (c) => void (c.store.platformValue.emergencyStop = true)],
      ["execution not allowed", "EXECUTION_DISABLED", (c) => void c.broker.executionAvailable.mockReturnValue(false)],
      ["route switched off", "ROUTE_COPY_OFF", () => undefined, { copyEnabled: false }],
      ["route emergency stop", "ROUTE_EMERGENCY_STOP", () => undefined, { emergencyStop: true }],
      ["follower disconnected", "FOLLOWER_NOT_READY", (c) => void (c.store.facts = { ...FACTS, followerStatus: "DISCONNECTED" })],
      ["risk rules", "RISK_BLOCKED", (c) => void (c.store.facts = { ...FACTS, riskBlocked: true, riskMessage: "Max drawdown rule" })],
      ["max open trades", "MAX_OPEN_TRADES", (c) => void (c.store.facts = { ...FACTS, openCopies: 2 }), { maxOpenTrades: 2 }],
      ["daily loss limit", "DAILY_LOSS_LIMIT", (c) => void (c.store.facts = { ...FACTS, dailyLossPercent: 3.5 }), { maxDailyLossPercent: 3 }],
      ["drawdown limit", "DRAWDOWN_LIMIT", (c) => void (c.store.facts = { ...FACTS, drawdownPercent: 11 }), { maxDrawdownPercent: 10 }],
      ["blocked symbol", "SYMBOL_BLOCKED", () => undefined, { blockedSymbols: ["EURUSD"] }],
      ["symbol not allowed", "SYMBOL_NOT_ALLOWED", () => undefined, { allowedSymbols: ["GBPUSD"] }],
      ["no lot size", "LOT_INVALID", (c) => void (c.store.facts = { ...FACTS, sourceBalance: null }), { copyMode: "BALANCE_RATIO" }],
      ["platform lot limit", "PLATFORM_MAX_LOT", (c) => void (c.store.platformValue.maxLotSize = 0.25)],
    ];

    it.each(cases)("%s -> %s", async (_name, code, configure, settings) => {
      const context = setup({ routes: [route(settings ?? {})] });
      configure(context);
      const summary = await runSelfCopyEvent(context.deps, openEvent());
      expect(summary).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 1 });
      expect(context.broker.openTrade).not.toHaveBeenCalled();
      expect(context.store.links).toHaveLength(0);
      expect(context.store.activity).toHaveLength(1);
      expect(context.store.activity[0]).toMatchObject({ outcome: "SKIPPED", code, eventType: "OPEN", sourcePositionId: "100" });
      expect(context.store.activity[0].message.length).toBeGreaterThan(10);
    });

    it("decides the platform switches without asking the database anything", async () => {
      const context = setup();
      context.store.platformValue.liveCopyEnabled = false;
      await runSelfCopyEvent(context.deps, openEvent());
      expect(context.store.calls).toEqual({ followerFacts: 0, findLink: 0, reserveLink: 0 });
    });
  });

  describe("new trades only", () => {
    it("skips a position that was already open when the stream started", async () => {
      const { store, broker, deps } = setup();
      const summary = await runSelfCopyEvent(deps, openEvent({ existing: true }));
      expect(summary.skipped).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
      expect(store.links).toHaveLength(0);
      expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "EXISTING_POSITION" });
    });

    it("copies it when the route asks for existing positions", async () => {
      const { broker, deps } = setup({ routes: [route({ calibration: { copyExisting: true } })] });
      const summary = await runSelfCopyEvent(deps, openEvent({ existing: true }));
      expect(summary.success).toBe(1);
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
    });

    it("copies a position found in the first look when it opened after the route went live", async () => {
      // the person created the route, then opened a trade before the stream was up
      const { store, broker, deps } = setup({
        routes: [route({ liveSince: "2026-10-12T20:00:00.000Z" })],
        now: () => Date.parse("2026-10-12T20:00:12.000Z"),
      });
      const summary = await runSelfCopyEvent(
        deps,
        openEvent({
          existing: true,
          openedAt: Date.parse("2026-10-12T20:00:06.000Z"),
          detectedAt: Date.parse("2026-10-12T20:00:11.500Z"),
        }),
      );
      expect(summary.success).toBe(1);
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
      expect(last(store.activity)).toMatchObject({ outcome: "COPIED" });
    });

    it("still skips a position found in the first look that opened before the route went live", async () => {
      const { store, broker, deps } = setup({
        routes: [route({ liveSince: "2026-10-12T20:00:00.000Z" })],
        now: () => Date.parse("2026-10-12T20:00:12.000Z"),
      });
      const summary = await runSelfCopyEvent(
        deps,
        openEvent({
          existing: true,
          openedAt: Date.parse("2026-10-12T19:40:00.000Z"),
          detectedAt: Date.parse("2026-10-12T20:00:11.500Z"),
        }),
      );
      expect(summary.skipped).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
      expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "EXISTING_POSITION" });
    });

    it("says nothing about a position it has dealt with already when the worker looks at the account again", async () => {
      const { store, broker, deps } = setup();
      store.links.push(link({ sourcePositionId: "100", status: "OPEN" }));
      const summary = await runSelfCopyEvent(deps, openEvent({ existing: true }));
      expect(summary).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 1 });
      expect(store.activity).toHaveLength(0);
      expect(broker.openTrade).not.toHaveBeenCalled();
    });

    it("does not copy a position of an old route whose start is unknown, however fresh it looks", async () => {
      const { broker, deps } = setup();
      const summary = await runSelfCopyEvent(
        deps,
        openEvent({ existing: true, openedAt: 9_990, detectedAt: 10_000 }),
      );
      expect(summary.skipped).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
    });
  });

  describe("signal age and latency", () => {
    it("skips a trade that was already too old when it was noticed", async () => {
      const { store, broker, deps } = setup({ routes: [route({ calibration: { maxSignalAgeMs: 2000 } })], now: () => 10_050 });
      const summary = await runSelfCopyEvent(deps, openEvent({ detectedAt: 10_000, openedAt: 5_000 }));
      expect(summary.skipped).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
      expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "SIGNAL_TOO_OLD" });
    });

    it("measures the delay from the moment the change was noticed", async () => {
      const { store, deps } = setup({ routes: [route({ calibration: { maxSignalAgeMs: 2000 } })], now: () => 10_050 });
      const summary = await runSelfCopyEvent(deps, openEvent({ detectedAt: 10_000, openedAt: 9_900 }));
      expect(summary.success).toBe(1);
      expect(last(store.activity).latencyMs).toBe(50);
      expect(last(store.activity).timings).toMatchObject({ queueMs: 50, sourceDelayMs: 100 });
    });
  });

  describe("the follower's symbol", () => {
    it("uses the broker's own spelling from the follower's list", async () => {
      const { store, broker, deps } = setup({ symbols: [symbol("EURUSD.r"), symbol("XAUUSDm", 2)] });
      await runSelfCopyEvent(deps, openEvent({ symbol: "XAUUSD", entryPrice: 2300, stopLoss: 2290, takeProfit: 2320 }));
      expect(broker.openTrade.mock.calls[0][0].symbol).toBe("XAUUSDm");
      expect(store.links[0].symbol).toBe("XAUUSDm");
      expect(last(store.activity)).toMatchObject({ symbol: "XAUUSD", followerSymbol: "XAUUSDm" });
    });

    it("prefers the person's own mapping", async () => {
      const { broker, deps } = setup({
        routes: [route({ symbolMapping: { XAUUSD: "GOLD.pro" } })],
        symbols: [symbol("GOLD.pro", 2), symbol("XAUUSDm", 2)],
      });
      await runSelfCopyEvent(deps, openEvent({ symbol: "XAUUSD", entryPrice: 2300, stopLoss: 2290, takeProfit: 2320 }));
      expect(broker.openTrade.mock.calls[0][0].symbol).toBe("GOLD.pro");
    });

    it("lets the symbol lists judge the follower's symbol, not only the source's", async () => {
      const { broker, deps } = setup({
        routes: [route({ allowedSymbols: ["XAUUSDm"] })],
        symbols: [symbol("XAUUSDm", 2)],
      });
      const summary = await runSelfCopyEvent(deps, openEvent({ symbol: "XAUUSD", entryPrice: 2300, stopLoss: 2290, takeProfit: 2320 }));
      expect(summary.success).toBe(1);
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
    });

    it("does not wait for the symbol list when no matching is wanted", async () => {
      const { broker, deps } = setup({
        routes: [route({ calibration: { autoSymbolMatch: false } })],
        symbols: [symbol("EURUSD")],
      });
      await runSelfCopyEvent(deps, openEvent());
      expect((broker as unknown as { fetchSymbolList: ReturnType<typeof vi.fn> }).fetchSymbolList).not.toHaveBeenCalled();
      expect(broker.openTrade).toHaveBeenCalledTimes(1);
    });
  });

  describe("sizing", () => {
    it("scales by the balances", async () => {
      const { store, broker, deps } = setup({ routes: [route({ copyMode: "BALANCE_RATIO" })] });
      store.facts = { ...FACTS, followerBalance: 5_000 };
      await runSelfCopyEvent(deps, openEvent());
      expect(broker.openTrade.mock.calls[0][0].volume).toBe(0.5);
    });

    it("applies a lot multiplier", async () => {
      const { broker, deps } = setup({ routes: [route({ copyMode: "LOT_MULTIPLIER", lotMultiplier: 2 })] });
      await runSelfCopyEvent(deps, openEvent({ volume: 0.3 }));
      expect(broker.openTrade.mock.calls[0][0].volume).toBe(0.6);
    });

    it("sizes by risk percent from the entry price and the stop loss", async () => {
      const { store, broker, deps } = setup({ routes: [route({ copyMode: "RISK_PERCENT", riskPercent: 1 })] });
      const summary = await runSelfCopyEvent(deps, openEvent());
      expect(summary.success).toBe(1);
      // 1 % of 10 000 = 100 at risk, 0.01 of price = 1000 ticks of 1 -> 0.1 lot
      expect(broker.openTrade.mock.calls[0][0].volume).toBe(0.1);
      expect(last(store.activity).copiedVolume).toBe(0.1);
    });

    it("does not guess a risk-percent lot without the entry price or a stop loss", async () => {
      const first = setup({ routes: [route({ copyMode: "RISK_PERCENT", riskPercent: 1 })] });
      await runSelfCopyEvent(first.deps, openEvent({ entryPrice: null }));
      expect(first.broker.openTrade).not.toHaveBeenCalled();
      expect(last(first.store.activity)).toMatchObject({ outcome: "SKIPPED", code: "LOT_INVALID" });
      expect(last(first.store.activity).message).toMatch(/Entry price/);

      const second = setup({ routes: [route({ copyMode: "RISK_PERCENT", riskPercent: 1 })] });
      await runSelfCopyEvent(second.deps, openEvent({ stopLoss: null }));
      expect(second.broker.openTrade).not.toHaveBeenCalled();
      expect(last(second.store.activity).message).toMatch(/Stop loss/);
    });
  });

  describe("calibration", () => {
    it("trades against the source and swaps its stop loss and take profit", async () => {
      const { store, broker, deps } = setup({ routes: [route({ reverseCopy: true })] });
      await runSelfCopyEvent(deps, openEvent());
      expect(broker.openTrade.mock.calls[0][0]).toMatchObject({ side: "SELL", stopLoss: 1.12, takeProfit: 1.09 });
      expect(store.links[0].side).toBe("SELL");
      expect(last(store.activity)).toMatchObject({ side: "SELL" });
    });

    it("leaves out the levels a route does not copy", async () => {
      const { broker, deps } = setup({ routes: [route({ calibration: { copyStopLoss: false } })] });
      await runSelfCopyEvent(deps, openEvent());
      expect(broker.openTrade.mock.calls[0][0]).toMatchObject({ stopLoss: null, takeProfit: 1.12 });
    });

    it("sets fixed distances from the entry, using the digits of the follower's symbol", async () => {
      const { broker, deps } = setup({
        routes: [route({ calibration: { stopLossPoints: 150, takeProfitPoints: 300 } })],
        symbols: [symbol("XAUUSD", 2)],
      });
      await runSelfCopyEvent(deps, openEvent({ symbol: "XAUUSD", entryPrice: 2300, stopLoss: null, takeProfit: null }));
      expect(broker.openTrade.mock.calls[0][0]).toMatchObject({ stopLoss: 2298.5, takeProfit: 2303 });
    });

    it("asks the bridge for the size of a point when the symbol list does not give it", async () => {
      const { broker, deps } = setup({ routes: [route({ calibration: { stopLossPoints: 100, takeProfitPoints: 200 } })] });
      await runSelfCopyEvent(deps, openEvent({ stopLoss: null, takeProfit: null }));
      expect(broker.fetchSymbolSpecifications).toHaveBeenCalled();
      expect(broker.openTrade.mock.calls[0][0]).toMatchObject({ stopLoss: 1.099, takeProfit: 1.102 });
    });

    it("does not send an order without a level the person asked for", async () => {
      const { store, broker, deps } = setup({ routes: [route({ calibration: { stopLossPoints: 100 } })] });
      const summary = await runSelfCopyEvent(deps, openEvent({ entryPrice: null }));
      expect(summary.skipped).toBe(1);
      expect(broker.openTrade).not.toHaveBeenCalled();
      expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "LEVELS_UNAVAILABLE" });
    });

    it("sends the stricter of the platform's and the route's slippage limit", async () => {
      const both = setup({ routes: [route({ calibration: { maxSlippagePoints: 10 } })] });
      both.store.platformValue.maxSlippagePoints = 30;
      await runSelfCopyEvent(both.deps, openEvent());
      expect(both.broker.openTrade.mock.calls[0][0].slippage).toBe(10);

      const platformOnly = setup();
      platformOnly.store.platformValue.maxSlippagePoints = 30;
      await runSelfCopyEvent(platformOnly.deps, openEvent());
      expect(platformOnly.broker.openTrade.mock.calls[0][0].slippage).toBe(30);
    });
  });
});

describe("planSelfCopyOpen", () => {
  it("shows what a copy would do without reserving or sending anything", async () => {
    const { store, broker, deps } = setup({
      routes: [route({ reverseCopy: true, calibration: { copyStopLoss: false } })],
      symbols: [symbol("EURUSD.r")],
    });
    const plan = await planSelfCopyOpen(deps, { platform: store.platformValue, executionAvailable: true }, store.routes[0], openEvent());
    expect(plan.complete).toBe(true);
    if (!plan.complete) return;
    expect(plan.verdict.allowed).toBe(true);
    expect(plan.followerSymbol).toBe("EURUSD.r");
    expect(plan.followerSide).toBe("SELL");
    expect(plan.levels).toMatchObject({ stopLoss: null, takeProfit: 1.09 });
    expect(plan.lot.lot).toBe(0.5);
    expect(plan.resolution.matchedBy).toBe("auto");
    expect(broker.openTrade).not.toHaveBeenCalled();
    expect(store.links).toHaveLength(0);
    expect(store.activity).toHaveLength(0);
  });

  it("stops at the cheap gates when the platform says no, without asking the database", async () => {
    const { store, deps } = setup();
    store.platformValue.liveCopyEnabled = false;
    const plan = await planSelfCopyOpen(deps, { platform: store.platformValue, executionAvailable: true }, store.routes[0], openEvent());
    expect(plan.complete).toBe(false);
    expect(plan.verdict).toMatchObject({ allowed: false, code: "PLATFORM_LIVE_DISABLED" });
    expect(store.calls.followerFacts).toBe(0);
  });

  it("lists every gate when a lookup-based one says no", async () => {
    const { store, deps } = setup();
    store.facts = { ...FACTS, riskBlocked: true, riskMessage: "Max drawdown rule" };
    const plan = await planSelfCopyOpen(deps, { platform: store.platformValue, executionAvailable: true }, store.routes[0], openEvent());
    expect(plan.complete).toBe(true);
    expect(plan.verdict).toMatchObject({ allowed: false, code: "RISK_BLOCKED" });
    expect(plan.verdict.checks.length).toBeGreaterThan(10);
  });
});

// ── MODIFY ───────────────────────────────────────────────────────────────────

describe("self-copy MODIFY", () => {
  function withOpenLink(options: Parameters<typeof setup>[0] = {}, overrides: Partial<SelfCopyLink> = {}) {
    const context = setup(options);
    context.store.links.push(link(overrides));
    return context;
  }

  it("does nothing for a position that is not followed", async () => {
    const { store, broker, deps } = setup();
    const summary = await runSelfCopyEvent(deps, modifyEvent());
    expect(summary).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 0 });
    expect(broker.modifyTrade).not.toHaveBeenCalled();
    expect(store.activity).toHaveLength(0);
  });

  it("closes the same share of the follower's position when the source closes a part", async () => {
    const { store, broker, deps } = withOpenLink();
    const summary = await runSelfCopyEvent(deps, modifyEvent({ volume: 0.5, previousVolume: 1 }));
    expect(summary.success).toBe(1);
    expect(broker.closeTrade).toHaveBeenCalledTimes(1);
    expect(broker.closeTrade.mock.calls[0][0]).toMatchObject({
      accountId: FOLLOWER,
      brokerPositionId: "F-9",
      volume: 0.25,
      comment: "wsa:self-copy:partial",
    });
    expect(broker.modifyTrade).not.toHaveBeenCalled();
    expect(store.links[0].copiedVolume).toBe(0.25);
    expect(last(store.activity)).toMatchObject({ outcome: "COPIED", code: "PARTIAL_CLOSED", copiedVolume: 0.25 });
  });

  it("rounds a partial close to the lot step and keeps the rest", async () => {
    const { store, broker, deps } = withOpenLink({}, { copiedVolume: 0.03 });
    await runSelfCopyEvent(deps, modifyEvent({ volume: 0.2, previousVolume: 0.3 }));
    expect(broker.closeTrade.mock.calls[0][0].volume).toBe(0.01);
    expect(store.links[0].copiedVolume).toBe(0.02);
  });

  it("leaves the follower alone when the part is smaller than the smallest lot", async () => {
    const { store, broker, deps } = withOpenLink({}, { copiedVolume: 0.01 });
    const summary = await runSelfCopyEvent(deps, modifyEvent({ volume: 0.5, previousVolume: 1 }));
    expect(summary.skipped).toBe(1);
    expect(broker.closeTrade).not.toHaveBeenCalled();
    expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "MODIFY_NOT_APPLIED" });
  });

  it("does not scale in when the source adds volume", async () => {
    const { store, broker, deps } = withOpenLink();
    const summary = await runSelfCopyEvent(deps, modifyEvent({ volume: 2, previousVolume: 1 }));
    expect(summary.skipped).toBe(1);
    expect(broker.openTrade).not.toHaveBeenCalled();
    expect(broker.closeTrade).not.toHaveBeenCalled();
    expect(last(store.activity).message).toMatch(/not scaled in/);
  });

  it("passes a changed stop loss on to the follower", async () => {
    const { store, broker, deps } = withOpenLink();
    const summary = await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: 1.095, takeProfit: 1.12, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(summary.success).toBe(1);
    expect(broker.modifyTrade.mock.calls[0][0]).toEqual({ accountId: FOLLOWER, brokerPositionId: "F-9", stopLoss: 1.095, takeProfit: 1.12 });
    expect(last(store.activity)).toMatchObject({ outcome: "COPIED", code: "MODIFIED", eventType: "MODIFY" });
  });

  it("sends nothing when the levels did not change", async () => {
    const { store, broker, deps } = withOpenLink();
    const summary = await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: 1.09, takeProfit: 1.12, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(summary).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 0 });
    expect(broker.modifyTrade).not.toHaveBeenCalled();
    expect(store.activity).toHaveLength(0);
  });

  it("removes a level the source removed, with an explicit zero", async () => {
    const { broker, deps } = withOpenLink();
    await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: null, takeProfit: 1.12, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(broker.modifyTrade.mock.calls[0][0]).toMatchObject({ stopLoss: 0, takeProfit: 1.12 });
  });

  it("passes on a stop that has moved past the entry (break-even, trailing stop) instead of removing it", async () => {
    const { broker, deps } = withOpenLink();
    await runSelfCopyEvent(
      deps,
      modifyEvent({ entryPrice: 1.1, volume: 1, previousVolume: 1, stopLoss: 1.105, takeProfit: 1.12, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(broker.modifyTrade.mock.calls[0][0]).toMatchObject({ stopLoss: 1.105, takeProfit: 1.12 });
  });

  it("swaps the levels of a reverse copy", async () => {
    const { broker, deps } = withOpenLink({ routes: [route({ reverseCopy: true })] }, { side: "SELL" });
    await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: 1.095, takeProfit: 1.12, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(broker.modifyTrade.mock.calls[0][0]).toMatchObject({ stopLoss: 1.12, takeProfit: 1.095 });
  });

  it("keeps the follower's own stop loss when the route does not copy it", async () => {
    const { broker, deps } = withOpenLink({ routes: [route({ calibration: { copyStopLoss: false } })] });
    broker.fetchTradingState.mockResolvedValue({
      positions: [{ ticket: "F-9", symbol: "EURUSD", side: "BUY", volume: 0.5, openPrice: 1.1, stopLoss: 1.0, takeProfit: null, profit: 0, swap: 0, commission: 0, openedAt: null, comment: null }],
    } as unknown as BrokerTradingState);
    await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: 1.095, takeProfit: 1.13, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(broker.modifyTrade.mock.calls[0][0]).toMatchObject({ stopLoss: 1.0, takeProfit: 1.13 });
  });

  it("changes nothing when the follower's own levels cannot be read", async () => {
    const { store, broker, deps } = withOpenLink({ routes: [route({ calibration: { copyStopLoss: false } })] });
    const summary = await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: 1.095, takeProfit: 1.13, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(summary.skipped).toBe(1);
    expect(broker.modifyTrade).not.toHaveBeenCalled();
    expect(last(store.activity).message).toMatch(/could not be read/);
  });

  it("is not upset when the broker says there is nothing to change", async () => {
    const { store, broker, deps } = withOpenLink();
    broker.modifyTrade.mockRejectedValueOnce(providerError("No changes"));
    const summary = await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: 1.095, takeProfit: 1.12, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(summary.skipped).toBe(1);
    expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED" });
  });

  it("records a refused change and keeps the link open", async () => {
    const { store, broker, deps } = withOpenLink();
    broker.modifyTrade.mockRejectedValueOnce(providerError("Invalid stops"));
    const summary = await runSelfCopyEvent(
      deps,
      modifyEvent({ volume: 1, previousVolume: 1, stopLoss: 1.2, takeProfit: 1.12, previousStopLoss: 1.09, previousTakeProfit: 1.12 }),
    );
    expect(summary.failed).toBe(1);
    expect(store.links[0]).toMatchObject({ status: "OPEN", errorCode: BROKER_EXEC_ERROR.PROVIDER_ERROR });
    expect(last(store.activity)).toMatchObject({ outcome: "FAILED", code: BROKER_EXEC_ERROR.PROVIDER_ERROR });
  });
});

// ── CLOSE ────────────────────────────────────────────────────────────────────

describe("self-copy CLOSE", () => {
  function withOpenLink(overrides: Partial<SelfCopyLink> = {}) {
    const context = setup();
    context.store.links.push(link(overrides));
    return context;
  }

  it("closes the follower's copy and marks the link closed", async () => {
    const { store, broker, deps } = withOpenLink();
    const summary = await runSelfCopyEvent(deps, closeEvent());
    expect(summary).toEqual({ attempted: 1, success: 1, failed: 0, skipped: 0 });
    expect(broker.closeTrade).toHaveBeenCalledTimes(1);
    expect(broker.closeTrade.mock.calls[0][0]).toEqual({ accountId: FOLLOWER, brokerPositionId: "F-9", comment: "wsa:self-copy:close" });
    expect(store.links[0].status).toBe("CLOSED");
    expect(last(store.activity)).toMatchObject({ outcome: "COPIED", code: "CLOSED", eventType: "CLOSE" });
  });

  it("closes once when the same close arrives twice at the same time", async () => {
    const { broker, deps } = withOpenLink();
    const [first, second] = await Promise.all([runSelfCopyEvent(deps, closeEvent()), runSelfCopyEvent(deps, closeEvent())]);
    expect(broker.closeTrade).toHaveBeenCalledTimes(1);
    expect(first.success + second.success).toBe(1);
  });

  it("sends the close again after a hiccup of the bridge", async () => {
    const { store, broker, deps } = withOpenLink();
    broker.closeTrade.mockRejectedValueOnce(providerError("Bridge hiccup"));
    const summary = await runSelfCopyEvent(deps, closeEvent());
    expect(summary.success).toBe(1);
    expect(broker.closeTrade).toHaveBeenCalledTimes(2);
    expect(store.links[0].status).toBe("CLOSED");
  });

  it("puts the copy back to open when it could not be closed, and says so", async () => {
    const { store, broker, deps } = withOpenLink();
    broker.closeTrade.mockRejectedValue(providerError("Bridge down"));
    const summary = await runSelfCopyEvent(deps, closeEvent());
    expect(summary).toEqual({ attempted: 1, success: 0, failed: 1, skipped: 0 });
    expect(broker.closeTrade).toHaveBeenCalledTimes(3);
    expect(store.links[0]).toMatchObject({ status: "OPEN", errorCode: BROKER_EXEC_ERROR.PROVIDER_ERROR });
    expect(last(store.activity)).toMatchObject({ outcome: "FAILED" });
    expect(last(store.activity).message).toMatch(/still open/);
  });

  it("does not repeat a close the broker refused for good", async () => {
    const { broker, deps } = withOpenLink();
    broker.closeTrade.mockRejectedValue(new BrokerExecutionError(BROKER_EXEC_ERROR.INVALID_REQUEST, "Volume is wrong", 400));
    await runSelfCopyEvent(deps, closeEvent());
    expect(broker.closeTrade).toHaveBeenCalledTimes(1);
  });

  it("counts a position that is gone already as closed", async () => {
    const { store, broker, deps } = withOpenLink();
    broker.closeTrade.mockRejectedValue(new Error("Position 123 not found"));
    const summary = await runSelfCopyEvent(deps, closeEvent());
    expect(summary.success).toBe(1);
    expect(broker.closeTrade).toHaveBeenCalledTimes(1);
    expect(store.links[0].status).toBe("CLOSED");
    expect(last(store.activity).message).toMatch(/already closed/);
  });

  it("explains a copy that has no ticket to close", async () => {
    const { store, broker, deps } = withOpenLink({ followerPositionId: null });
    const summary = await runSelfCopyEvent(deps, closeEvent());
    expect(summary).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 1 });
    expect(broker.closeTrade).not.toHaveBeenCalled();
    expect(last(store.activity)).toMatchObject({ outcome: "SKIPPED", code: "NO_FOLLOWER_TICKET" });
  });

  it("closes every route's copy of the position", async () => {
    const context = setup();
    context.store.links.push(
      link({ id: "l1", routeId: "11111111-1111-4111-8111-111111111111", followerPositionId: "F-1" }),
      link({ id: "l2", routeId: "22222222-2222-4222-8222-222222222222", followerAccountId: "dddddddd-0000-4000-8000-000000000004", followerPositionId: "F-2" }),
    );
    const summary = await runSelfCopyEvent(context.deps, closeEvent());
    expect(summary.success).toBe(2);
    expect(context.broker.closeTrade.mock.calls.map((call) => call[0].brokerPositionId).sort()).toEqual(["F-1", "F-2"]);
  });
});

// ── missed closes ────────────────────────────────────────────────────────────

describe("closeVanishedPositions", () => {
  it("closes the copies whose source position is gone and leaves the others", async () => {
    const { store, broker, deps } = setup();
    store.links.push(
      link({ id: "l1", sourcePositionId: "1", followerPositionId: "F-1" }),
      link({ id: "l2", routeId: "22222222-2222-4222-8222-222222222222", sourcePositionId: "2", followerPositionId: "F-2" }),
      link({ id: "l3", routeId: "33333333-3333-4333-8333-333333333333", sourcePositionId: "3", followerPositionId: "F-3" }),
    );
    const summary = await closeVanishedPositions(deps, SOURCE, new Set(["2"]));
    expect(summary).toEqual({ attempted: 2, success: 2, failed: 0, skipped: 0 });
    expect(broker.closeTrade.mock.calls.map((call) => call[0].brokerPositionId).sort()).toEqual(["F-1", "F-3"]);
    expect(store.links.map((entry) => entry.status)).toEqual(["CLOSED", "OPEN", "CLOSED"]);
    expect(last(store.activity).message).toMatch(/while copying was not running/);
  });

  it("does nothing when every position is still there", async () => {
    const { store, broker, deps } = setup();
    store.links.push(link({ sourcePositionId: "1" }));
    const summary = await closeVanishedPositions(deps, SOURCE, new Set(["1"]));
    expect(summary).toEqual({ attempted: 0, success: 0, failed: 0, skipped: 0 });
    expect(broker.closeTrade).not.toHaveBeenCalled();
  });

  it("reads the live positions only after it has looked up the copies, and not at all when there are none", async () => {
    const { store, broker, deps } = setup();
    const readLive = vi.fn(async () => new Set<string>());

    await closeVanishedPositions(deps, SOURCE, readLive);
    expect(readLive).not.toHaveBeenCalled();

    // a copy made while the list is being read is not among the copies that were looked up
    store.links.push(link({ id: "l1", sourcePositionId: "1", followerPositionId: "F-1" }));
    const summary = await closeVanishedPositions(deps, SOURCE, async () => {
      store.links.push(link({ id: "l2", routeId: "22222222-2222-4222-8222-222222222222", sourcePositionId: "2", followerPositionId: "F-2" }));
      return new Set<string>();
    });
    expect(summary.success).toBe(1);
    expect(broker.closeTrade.mock.calls.map((call) => call[0].brokerPositionId)).toEqual(["F-1"]);
    expect(store.links.map((entry) => entry.status)).toEqual(["CLOSED", "OPEN"]);
  });
});

// ── small helpers ────────────────────────────────────────────────────────────

describe("engine helpers", () => {
  it("knows which failures leave the order's fate open", () => {
    for (const code of [BROKER_EXEC_ERROR.PROVIDER_TIMEOUT, "ORDER_UNCERTAIN", "WORKER_LOST", "LINK_NOT_RECORDED"]) {
      expect(isUncertainFailure(code)).toBe(true);
    }
    for (const code of [BROKER_EXEC_ERROR.PROVIDER_ERROR, BROKER_EXEC_ERROR.ACCOUNT_NOT_CONNECTED, null, undefined, ""]) {
      expect(isUncertainFailure(code)).toBe(false);
    }
  });

  it("tells a symbol problem from the other refusals", () => {
    expect(symbolMayBeWrong(providerError("Symbol XAUUSD not found"))).toBe(true);
    expect(symbolMayBeWrong(providerError("Unknown instrument"))).toBe(true);
    expect(symbolMayBeWrong(providerError("Not enough money"))).toBe(false);
    expect(symbolMayBeWrong(providerError("Market is closed"))).toBe(false);
    expect(symbolMayBeWrong(providerError("Invalid volume"))).toBe(false);
    expect(symbolMayBeWrong(new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_TIMEOUT, "timeout"))).toBe(false);
    expect(symbolMayBeWrong(new Error("Symbol not found"))).toBe(false);
  });

  it("recognises a position that is gone and a change that changes nothing", () => {
    expect(looksAlreadyClosed(new Error("Position not found"))).toBe(true);
    expect(looksAlreadyClosed(new Error("The order was already closed"))).toBe(true);
    expect(looksAlreadyClosed(new Error("Network down"))).toBe(false);
    expect(looksAlreadyClosed("Position not found")).toBe(false);
    expect(looksUnchanged(new Error("No changes"))).toBe(true);
    expect(looksUnchanged(new Error("Nothing to modify"))).toBe(true);
    expect(looksUnchanged(new Error("Invalid stops"))).toBe(false);
  });
});
