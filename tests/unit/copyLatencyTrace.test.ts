import { describe, expect, test } from "vitest";
import { copyLatencySample, elapsedMs } from "@/lib/copy/latencyTrace";

describe("copyLatencySample", () => {
  test("separates source detection, durable writes, preparation, and provider response", () => {
    expect(copyLatencySample({
      masterExecutedAtMs: 1_000,
      detectedAtMs: 1_365,
      eventStoredAtMs: 1_644,
      followerStartedAtMs: 1_644,
      reservationStartedAtMs: 1_650,
      reservedAtMs: 1_933,
      brokerStartedAtMs: 1_933,
      providerRespondedAtMs: 2_006,
    })).toEqual({
      sourceToDetectionMs: 365,
      detectionToStoreMs: 279,
      followerPreflightMs: 6,
      reservationMs: 283,
      reservedToBrokerMs: 0,
      providerResponseMs: 73,
      detectionToProviderResponseMs: 641,
      sourceToProviderResponseMs: 1_006,
    });
  });

  test("does not invent a source-to-follower number without a usable broker timestamp", () => {
    const sample = copyLatencySample({
      masterExecutedAtMs: null,
      detectedAtMs: 1_000,
      followerStartedAtMs: 1_010,
      reservationStartedAtMs: 1_020,
      reservedAtMs: 1_030,
      brokerStartedAtMs: 1_040,
      providerRespondedAtMs: 1_080,
    });
    expect(sample.sourceToDetectionMs).toBeNull();
    expect(sample.sourceToProviderResponseMs).toBeNull();
    expect(sample.detectionToStoreMs).toBeNull();
    expect(sample.detectionToProviderResponseMs).toBe(80);
  });

  test("rejects negative, non-finite, and implausibly old cross-system times", () => {
    expect(elapsedMs(200, 100)).toBeNull();
    expect(elapsedMs(Number.NaN, 100)).toBeNull();
    expect(elapsedMs(0, 600_001)).toBeNull();
  });
});
