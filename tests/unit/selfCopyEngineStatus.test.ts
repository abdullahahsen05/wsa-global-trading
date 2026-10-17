import { describe, expect, it } from "vitest";
import { ENGINE_FRESH_MS, judgeEngine } from "@/lib/copy/selfCopyEngineStatus";

const NOW = Date.parse("2026-10-12T20:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("judgeEngine", () => {
  it("says the worker has not reported when there is no report", () => {
    for (const report of [null, { status: null, error: null, heartbeatAt: null }]) {
      const verdict = judgeEngine(report, NOW);
      expect(verdict.state).toBe("unreported");
      expect(verdict.listening).toBe(false);
      expect(verdict.check).toMatchObject({ id: "WORKER_LISTENING", status: "warn" });
    }
  });

  it("is listening while the heartbeat is fresh", () => {
    const verdict = judgeEngine({ status: "LIVE", error: null, heartbeatAt: ago(20_000) }, NOW);
    expect(verdict.state).toBe("listening");
    expect(verdict.listening).toBe(true);
    expect(verdict.check.status).toBe("pass");
    expect(verdict.check.detail).toMatch(/20 s ago/);
  });

  it("takes a worker that stopped reporting as gone, whatever its last status said", () => {
    const verdict = judgeEngine({ status: "LIVE", error: null, heartbeatAt: ago(ENGINE_FRESH_MS + 60_000) }, NOW);
    expect(verdict.state).toBe("stale");
    expect(verdict.listening).toBe(false);
    expect(verdict.check.status).toBe("fail");
    expect(verdict.check.detail).toMatch(/4 min ago/);
  });

  it("does not trust a status without a heartbeat", () => {
    const verdict = judgeEngine({ status: "LIVE", error: null, heartbeatAt: null }, NOW);
    expect(verdict.state).toBe("stale");
    expect(verdict.listening).toBe(false);
  });

  it("shows the worker's own reason when it cannot follow the source", () => {
    const verdict = judgeEngine({ status: "ERROR", error: "Account is not connected to API2Trade", heartbeatAt: ago(5_000) }, NOW);
    expect(verdict.state).toBe("error");
    expect(verdict.listening).toBe(false);
    expect(verdict.check.status).toBe("fail");
    expect(verdict.check.detail).toMatch(/not connected to API2Trade/);
  });

  it("reports a worker that is still connecting", () => {
    const verdict = judgeEngine({ status: "STARTING", error: null, heartbeatAt: ago(2_000) }, NOW);
    expect(verdict.state).toBe("starting");
    expect(verdict.listening).toBe(false);
    expect(verdict.check.status).toBe("warn");
  });
});
