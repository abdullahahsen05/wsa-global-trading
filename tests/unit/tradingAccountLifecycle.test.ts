import { describe, expect, it } from "vitest";
import {
  ACCOUNT_INACTIVITY_MS,
  latestAccountActivityAt,
  resolveLiveSelectedAccountId,
  resolveAccountLifecycleStatus,
} from "@/lib/accounts/lifecycle";
import type { AccountStatus, TraderAccountSummary } from "@/lib/domain/types";

const now = new Date("2026-07-25T00:00:00.000Z").getTime();

function account(
  accountId: string,
  status: AccountStatus,
  live = status === "CONNECTED",
): TraderAccountSummary {
  return {
    accountId,
    accountName: accountId,
    brokerName: "WSA GLOBAL",
    serverName: "MetaQuotes-Demo",
    platform: "MT5",
    status,
    balance: { amount: 0, currency: "USD" },
    equity: { amount: 0, currency: "USD" },
    floatingPnl: { amount: 0, currency: "USD" },
    openTradeCount: 0,
    drawdownPercent: 0,
    updatedAt: "2026-07-25T00:00:00.000Z",
    live,
  };
}

describe("trading account lifecycle", () => {
  it("keeps incomplete account information pending", () => {
    expect(resolveAccountLifecycleStatus({
      status: "CONNECTED",
      lastSyncedAt: "2026-07-24T00:00:00.000Z",
      serverName: null,
      platform: "MT5",
      now,
    })).toBe("PENDING");
  });

  it("does not call an account connected before its first successful sync", () => {
    expect(resolveAccountLifecycleStatus({
      status: "CONNECTED",
      lastSyncedAt: null,
      snapshotCapturedAt: null,
      serverName: "MetaQuotes-Demo",
      platform: "MT5",
      now,
    })).toBe("SYNCING");
  });

  it("keeps recently synchronized accounts live", () => {
    expect(resolveAccountLifecycleStatus({
      status: "CONNECTED",
      lastSyncedAt: new Date(now - ACCOUNT_INACTIVITY_MS + 60_000).toISOString(),
      serverName: "MetaQuotes-Demo",
      platform: "MT5",
      now,
    })).toBe("CONNECTED");
  });

  it("requires reconnection after ten days without broker activity", () => {
    expect(resolveAccountLifecycleStatus({
      status: "CONNECTED",
      lastSyncedAt: new Date(now - ACCOUNT_INACTIVITY_MS).toISOString(),
      serverName: "MetaQuotes-Demo",
      platform: "MT5",
      now,
    })).toBe("INACTIVE");
  });

  it("uses the newest successful snapshot or sync activity", () => {
    expect(latestAccountActivityAt(
      "2026-07-10T00:00:00.000Z",
      "2026-07-24T12:00:00.000Z",
    )).toBe("2026-07-24T12:00:00.000Z");
  });

  it("keeps the topbar selection when that account is live", () => {
    const accounts = [
      account("pending-account", "PENDING", false),
      account("test-abd", "CONNECTED"),
      account("second-live", "CONNECTED"),
    ];

    expect(resolveLiveSelectedAccountId(accounts, "second-live")).toBe("second-live");
  });

  it("never falls back to a pending account for the shared selection", () => {
    const accounts = [
      account("account-121", "PENDING", false),
      account("test-abd", "CONNECTED"),
    ];

    expect(resolveLiveSelectedAccountId(accounts, "account-121")).toBe("test-abd");
    expect(resolveLiveSelectedAccountId(accounts, null)).toBe("test-abd");
  });
});
