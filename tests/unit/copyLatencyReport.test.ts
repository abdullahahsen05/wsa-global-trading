import { describe, expect, test } from "vitest";
import { latencyDistribution, summarizeBrokerTradeLatency } from "@/lib/copy/latencyReport";

describe("read-only copy latency correlation", () => {
  test("uses nearest-rank percentiles and retains the worst case", () => {
    expect(latencyDistribution([100, 300, 200, 400, 500])).toEqual({
      count: 5, p50Ms: 300, p95Ms: 500, p99Ms: 500, worstMs: 500,
    });
    expect(latencyDistribution([])).toEqual({
      count: 0, p50Ms: null, p95Ms: null, p99Ms: null, worstMs: null,
    });
  });

  test("reports coverage separately from real broker timestamp deltas", () => {
    const reports = summarizeBrokerTradeLatency(
      [
        { id: "e1", master_account_id: "master", master_trade_id: "m1", created_at: "2026-10-27T00:00:02Z" },
        { id: "e2", master_account_id: "master", master_trade_id: "m2", created_at: "2026-10-27T00:00:02Z" },
      ],
      [
        { source_event_id: "e1", follower_account_id: "follower", follower_position_id: "f1" },
        { source_event_id: "e2", follower_account_id: "follower", follower_position_id: "f2" },
        { source_event_id: "absent", follower_account_id: "follower", follower_position_id: "f3" },
      ],
      [
        { trading_account_id: "master", external_trade_id: "m1", opened_at: "2026-10-27T00:00:00.000Z" },
        { trading_account_id: "follower", external_trade_id: "f1", opened_at: "2026-10-27T00:00:01.006Z" },
        { trading_account_id: "master", external_trade_id: "m2", opened_at: "2026-10-27T00:00:02.000Z" },
      ],
    );
    expect(reports).toEqual([{
      followerAccountId: "follower", links: 3, matchedBrokerTrades: 1,
      missingMasterEvent: 1, missingMasterTrade: 0, missingFollowerTrade: 1,
      invalidOrSkewedTimestamps: 0,
      sourceToFollower: { count: 1, p50Ms: 1_006, p95Ms: 1_006, p99Ms: 1_006, worstMs: 1_006 },
    }]);
  });

  test("rejects skewed timestamps instead of treating them as fast executions", () => {
    const report = summarizeBrokerTradeLatency(
      [{ id: "e", master_account_id: "m", master_trade_id: "1", created_at: "2026-10-27T00:00:00Z" }],
      [{ source_event_id: "e", follower_account_id: "f", follower_position_id: "2" }],
      [
        { trading_account_id: "m", external_trade_id: "1", opened_at: "2026-10-27T00:00:02Z" },
        { trading_account_id: "f", external_trade_id: "2", opened_at: "2026-10-27T00:00:01Z" },
      ],
    )[0];
    expect(report.invalidOrSkewedTimestamps).toBe(1);
    expect(report.sourceToFollower.count).toBe(0);
  });
});
