import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StreamPump } from "@/lib/copy/streamPump";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamPump", () => {
  test("runs a pass, rests for the interval, and runs the next one", async () => {
    const step = vi.fn(async () => undefined);
    const pump = new StreamPump({ step, intervalMs: 100, onFailure: vi.fn() });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(step).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(step).toHaveBeenCalledTimes(4);

    await pump.stop();
  });

  test("the rest starts when a pass ends, so a slow pass is not followed by a burst", async () => {
    const gate = deferred();
    let calls = 0;
    const pump = new StreamPump({
      step: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
      },
      intervalMs: 100,
      onFailure: vi.fn(),
    });

    pump.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);

    await pump.stop();
  });

  test("wake() cuts the rest short", async () => {
    const step = vi.fn(async () => undefined);
    const pump = new StreamPump({ step, intervalMs: 60_000, onFailure: vi.fn() });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledTimes(1);

    pump.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledTimes(2);

    await pump.stop();
  });

  test("wakes that arrive during a pass are merged into exactly one more pass", async () => {
    const gate = deferred();
    let calls = 0;
    const pump = new StreamPump({
      step: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
      },
      intervalMs: 60_000,
      onFailure: vi.fn(),
    });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    pump.wake();
    pump.wake();
    pump.wake();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // one extra pass, straight away, and then the pump rests again
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(2);

    await pump.stop();
  });

  test("a failing pass ends the pump and calls onFailure once with the error", async () => {
    const boom = new Error("boom");
    const onFailure = vi.fn();
    const step = vi.fn(async () => {
      throw boom;
    });
    const pump = new StreamPump({ step, intervalMs: 10, onFailure });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await pump.settled();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(boom);
    expect(pump.isStopped).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(step).toHaveBeenCalledTimes(1);
  });

  test("the failure handler may stop the pump without waiting for itself", async () => {
    let finished = false;
    const holder: { pump?: StreamPump } = {};
    holder.pump = new StreamPump({
      step: async () => {
        throw new Error("boom");
      },
      intervalMs: 10,
      onFailure: async () => {
        await holder.pump!.stop();
        finished = true;
      },
    });

    holder.pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await holder.pump.settled();

    expect(finished).toBe(true);
  });

  test("a failure handler that throws is swallowed", async () => {
    const pump = new StreamPump({
      step: async () => {
        throw new Error("boom");
      },
      intervalMs: 10,
      onFailure: () => {
        throw new Error("handler failed");
      },
    });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pump.settled()).resolves.toBeUndefined();
  });

  test("stop() waits for the pass in flight and no pass starts afterwards", async () => {
    const gate = deferred();
    let calls = 0;
    const pump = new StreamPump({
      step: async () => {
        calls += 1;
        await gate.promise;
      },
      intervalMs: 10,
      onFailure: vi.fn(),
    });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = pump.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
  });

  test("stop() during the rest returns at once", async () => {
    const step = vi.fn(async () => undefined);
    const pump = new StreamPump({ step, intervalMs: 3_600_000, onFailure: vi.fn() });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await pump.stop();

    expect(step).toHaveBeenCalledTimes(1);
    expect(pump.isStopped).toBe(true);
  });

  test("a failure after stop() is not reported", async () => {
    const gate = deferred();
    const onFailure = vi.fn();
    const pump = new StreamPump({
      step: async () => {
        await gate.promise;
        throw new Error("late failure");
      },
      intervalMs: 10,
      onFailure,
    });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = pump.stop();
    gate.resolve();
    await stopping;
    await pump.settled();

    expect(onFailure).not.toHaveBeenCalled();
  });

  test("wake() after stop() does nothing and start() cannot restart a stopped pump", async () => {
    const step = vi.fn(async () => undefined);
    const pump = new StreamPump({ step, intervalMs: 10, onFailure: vi.fn() });

    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    await pump.stop();
    const calls = step.mock.calls.length;

    pump.wake();
    pump.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(step).toHaveBeenCalledTimes(calls);
  });

  test("start() twice does not run two loops", async () => {
    const step = vi.fn(async () => undefined);
    const pump = new StreamPump({ step, intervalMs: 100, onFailure: vi.fn() });

    pump.start();
    pump.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledTimes(1);

    await pump.stop();
  });

  test("counts the passes that completed", async () => {
    const pump = new StreamPump({ step: async () => undefined, intervalMs: 100, onFailure: vi.fn() });
    pump.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(pump.stepCount).toBe(3);
    await pump.stop();
  });
});
