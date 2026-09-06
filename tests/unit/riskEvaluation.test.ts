import { vi, describe, test, expect, beforeEach } from "vitest";

// Hoist mocks before any imports
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/services/riskService", () => ({
  createRiskEvent: vi.fn(),
  findActiveRiskEvent: vi.fn(),
}));
vi.mock("@/lib/services/notificationService", () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/auditService", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { createRiskEvent, findActiveRiskEvent } from "@/lib/services/riskService";
import { createNotification } from "@/lib/services/notificationService";
import { writeAuditLog } from "@/lib/services/auditService";
import {
  computeDailyPnl,
  buildAccountInput,
  evaluateAndPersistRiskEvents,
} from "@/lib/services/riskEvaluationService";

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("computeDailyPnl", () => {
  test("sums profit from closed trades", () => {
    expect(computeDailyPnl([{ profit: 100 }, { profit: -250 }, { profit: 50 }])).toBe(-100);
  });

  test("returns 0 for empty array", () => {
    expect(computeDailyPnl([])).toBe(0);
  });

  test("coerces string profits to numbers", () => {
    expect(computeDailyPnl([{ profit: "150.50" }, { profit: "-200.25" }])).toBeCloseTo(-49.75);
  });
});

describe("buildAccountInput", () => {
  test("maps snapshot drawdown to drawdownPercent", () => {
    const result = buildAccountInput(
      "acc1",
      "Test Account",
      "MT5",
      "USD",
      "CONNECTED",
      { balance: 10000, equity: 9000, drawdown_percent: 10 },
      3,
    );
    expect(result.drawdownPercent).toBe(10);
    expect(result.openTradeCount).toBe(3);
    expect(result.balance.amount).toBe(10000);
  });

  test("defaults to zero values when snapshot is null", () => {
    const result = buildAccountInput("acc1", "Test", "MT5", "USD", "CONNECTED", null, 0);
    expect(result.drawdownPercent).toBe(0);
    expect(result.balance.amount).toBe(0);
  });
});

// ── Service orchestration (mocked Supabase) ───────────────────────────────────

// Build a chainable Supabase query builder mock that awaits to `resolveValue`
function makeQuery(resolveValue: unknown) {
  const obj: Record<string, unknown> = {
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(resolveValue).then(resolve, reject),
    single: vi.fn().mockResolvedValue(resolveValue),
  };
  const chainMethods = ["select", "eq", "is", "not", "order", "limit", "gte", "lte", "neq", "in", "update", "upsert"];
  for (const method of chainMethods) {
    obj[method] = vi.fn().mockReturnValue(obj);
  }
  const insertChain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(resolveValue),
  };
  obj["insert"] = vi.fn().mockReturnValue(insertChain);
  return obj;
}

const mockAccount = {
  id: "acc1",
  user_id: "user1",
  account_name: "Eval 100K",
  broker_name: "MT5 Demo",
  currency: "USD",
  status: "CONNECTED",
  risk_restricted_at: null,
};
const mockSnapshot = [{ balance: 10000, equity: 9500, drawdown_percent: 5.0 }];
const mockDrawdownRule = {
  id: "rule1",
  trading_account_id: null,
  name: "Max DD 4%",
  severity: "WARNING",
  metric: "MAX_DRAWDOWN",
  threshold: 4,
  enabled: true,
};

function setupMockClient(overrides: {
  account?: typeof mockAccount | null;
  snapshots?: unknown[];
  closedTrades?: unknown[];
  openCount?: number;
  platformRules?: unknown[];
  accountRules?: unknown[];
}) {
  const mockFrom = vi.fn();
  mockFrom
    .mockReturnValueOnce(makeQuery({ data: overrides.account ?? mockAccount, error: null }))
    .mockReturnValueOnce(makeQuery({ data: overrides.snapshots ?? mockSnapshot, error: null }))
    .mockReturnValueOnce(makeQuery({ data: overrides.closedTrades ?? [], error: null }))
    .mockReturnValueOnce(makeQuery({ data: null, error: null, count: overrides.openCount ?? 0 }))
    .mockReturnValueOnce(
      makeQuery({ data: overrides.platformRules ?? [mockDrawdownRule], error: null }),
    )
    .mockReturnValueOnce(makeQuery({ data: overrides.accountRules ?? [], error: null }))
    .mockReturnValueOnce(makeQuery({ data: [], error: null }))
    .mockReturnValueOnce(makeQuery({ data: null, error: null }));
  vi.mocked(createAdminClient).mockReturnValue(
    { from: mockFrom } as unknown as ReturnType<typeof createAdminClient>,
  );
}

describe("evaluateAndPersistRiskEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createRiskEvent).mockResolvedValue("new-event-id");
    vi.mocked(findActiveRiskEvent).mockResolvedValue(null);
    vi.mocked(createNotification).mockResolvedValue(undefined);
  });

  test("creates risk event and notification when rule is breached", async () => {
    // snapshot has 5% drawdown, rule threshold is 4% → breach
    setupMockClient({});
    await evaluateAndPersistRiskEvents("acc1", "admin-user");

    expect(createRiskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc1",
        ruleName: "Max DD 4%",
        severity: "WARNING",
      }),
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user1",
        type: "RISK_EVENT",
        riskEventId: "new-event-id",
      }),
    );
  });

  test("skips event creation when active event already exists (dedup)", async () => {
    setupMockClient({});
    vi.mocked(findActiveRiskEvent).mockResolvedValue("existing-event-id");

    await evaluateAndPersistRiskEvents("acc1", "admin-user");

    expect(createRiskEvent).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test("does not create events when no rules are breached", async () => {
    // drawdown_percent is 2%, threshold is 4% → no breach
    setupMockClient({
      snapshots: [{ balance: 10000, equity: 9800, drawdown_percent: 2.0 }],
    });

    await evaluateAndPersistRiskEvents("acc1", "admin-user");

    expect(createRiskEvent).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test("handles missing snapshot gracefully (drawdown = 0, no breach)", async () => {
    setupMockClient({ snapshots: [] });

    await evaluateAndPersistRiskEvents("acc1", "admin-user");

    expect(createRiskEvent).not.toHaveBeenCalled();
  });

  test("handles missing account gracefully without throwing", async () => {
    const mockFrom = vi.fn().mockReturnValueOnce(
      makeQuery({ data: null, error: { message: "not found" } }),
    );
    vi.mocked(createAdminClient).mockReturnValue(
      { from: mockFrom } as unknown as ReturnType<typeof createAdminClient>,
    );

    await expect(evaluateAndPersistRiskEvents("missing-id", null)).resolves.not.toThrow();
    expect(createRiskEvent).not.toHaveBeenCalled();
  });

  test("evaluates DAILY_LOSS with today closed trades", async () => {
    const dailyLossRule = {
      id: "daily",
      trading_account_id: null,
      name: "Daily Loss 500",
      severity: "CRITICAL",
      metric: "DAILY_LOSS",
      threshold: 500,
      enabled: true,
    };
    setupMockClient({
      snapshots: [{ balance: 10000, equity: 10000, drawdown_percent: 0 }],
      closedTrades: [{ profit: "-600" }], // -600 loss today, threshold is -500
      platformRules: [dailyLossRule],
    });

    await evaluateAndPersistRiskEvents("acc1", null);

    expect(createRiskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ ruleName: "Daily Loss 500", severity: "CRITICAL" }),
    );
  });

  test("continues gracefully when createRiskEvent throws", async () => {
    setupMockClient({});
    vi.mocked(findActiveRiskEvent).mockResolvedValue(null);
    vi.mocked(createRiskEvent).mockRejectedValue(new Error("DB write failed"));

    await expect(evaluateAndPersistRiskEvents("acc1", null)).resolves.not.toThrow();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test("writes audit log with RISK_EVENT_CREATED when new event is persisted", async () => {
    setupMockClient({});
    vi.mocked(findActiveRiskEvent).mockResolvedValue(null);
    vi.mocked(createRiskEvent).mockResolvedValue("evt-audit");

    await evaluateAndPersistRiskEvents("acc1", "admin-1");

    // writeAuditLog is fire-and-forget; give it a tick to run
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RISK_EVENT_CREATED",
        entityId: "evt-audit",
      }),
    );
  });

  test("does not create events for DAILY_LOSS when loss is below threshold", async () => {
    const dailyLossRule = {
      id: "daily",
      trading_account_id: null,
      name: "Daily Loss 500",
      severity: "CRITICAL",
      metric: "DAILY_LOSS",
      threshold: 500,
      enabled: true,
    };
    setupMockClient({
      snapshots: [{ balance: 10000, equity: 10000, drawdown_percent: 0 }],
      closedTrades: [{ profit: "-400" }], // -400 loss, threshold is -500 → no breach
      platformRules: [dailyLossRule],
    });

    await evaluateAndPersistRiskEvents("acc1", null);

    expect(createRiskEvent).not.toHaveBeenCalled();
  });

  test("returns early without evaluation when no rules exist", async () => {
    setupMockClient({
      platformRules: [],
      accountRules: [],
    });

    await evaluateAndPersistRiskEvents("acc1", "admin-user");

    expect(findActiveRiskEvent).not.toHaveBeenCalled();
    expect(createRiskEvent).not.toHaveBeenCalled();
  });
});
