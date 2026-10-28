import { describe, expect, test } from "vitest";
import { KeyedChains } from "@/lib/copy/keyedChains";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("KeyedChains", () => {
  test("tasks of one key run strictly one after the other, in the order they were queued", async () => {
    const chains = new KeyedChains();
    const log: string[] = [];
    const gate = deferred();

    void chains.run("ticket-1", async () => {
      log.push("open start");
      await gate.promise;
      log.push("open end");
    });
    void chains.run("ticket-1", async () => {
      log.push("close start");
      log.push("close end");
    });

    await tick();
    expect(log).toEqual(["open start"]);

    gate.resolve();
    await chains.idle();
    expect(log).toEqual(["open start", "open end", "close start", "close end"]);
  });

  test("different keys do not wait for each other", async () => {
    const chains = new KeyedChains();
    const stuck = deferred();
    const log: string[] = [];

    void chains.run("slow", async () => {
      await stuck.promise;
      log.push("slow done");
    });
    void chains.run("fast", async () => {
      log.push("fast done");
    });

    await tick();
    expect(log).toEqual(["fast done"]);

    stuck.resolve();
    await chains.idle();
    expect(log).toEqual(["fast done", "slow done"]);
  });

  test("run never rejects: an error goes to the handler and the next task of the key still runs", async () => {
    const chains = new KeyedChains();
    const errors: unknown[] = [];
    const log: string[] = [];

    const first = chains.run(
      "k",
      async () => {
        throw new Error("boom");
      },
      (error) => errors.push(error),
    );
    const second = chains.run("k", async () => {
      log.push("second ran");
    });

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(log).toEqual(["second ran"]);
  });

  test("an error without a handler is dropped quietly", async () => {
    const chains = new KeyedChains();
    await expect(
      chains.run("k", async () => {
        throw new Error("nobody listens");
      }),
    ).resolves.toBeUndefined();
  });

  test("a handler that throws does not break the chain", async () => {
    const chains = new KeyedChains();
    const log: string[] = [];

    await chains.run(
      "k",
      async () => {
        throw new Error("task failed");
      },
      () => {
        throw new Error("handler failed too");
      },
    );
    await chains.run("k", async () => {
      log.push("still running");
    });

    expect(log).toEqual(["still running"]);
  });

  test("the limit caps how many tasks run at once across all keys, first queued first served", async () => {
    const chains = new KeyedChains(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    gates.forEach((gate, index) => {
      void chains.run(`key-${index}`, async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      });
    });

    await tick();
    expect(started).toEqual([0, 1]);
    expect(chains.running).toBe(2);
    expect(chains.capacity).toBe(2);
    expect(chains.queuedForSlot).toBe(2);

    gates[0].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2].resolve();
    gates[3].resolve();
    await chains.idle();
    expect(peak).toBe(2);
    expect(chains.running).toBe(0);
    expect(chains.queuedForSlot).toBe(0);
  });

  test("a limit that is not usable means no limit", async () => {
    const chains = new KeyedChains(Number.POSITIVE_INFINITY);
    const gate = deferred();
    let active = 0;
    let peak = 0;
    for (let index = 0; index < 5; index += 1) {
      void chains.run(`k${index}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      });
    }
    await tick();
    expect(peak).toBe(5);
    gate.resolve();
    await chains.idle();
  });

  test("serves a hundred accounts concurrently without reordering orders within any account", async () => {
    const chains = new KeyedChains(16);
    const lastOrder = new Map<string, number>();
    const errors: unknown[] = [];
    let running = 0;
    let peak = 0;
    for (let account = 0; account < 100; account += 1) {
      const key = `account-${account}`;
      for (let order = 0; order < 3; order += 1) {
        void chains.run(key, async () => {
          running += 1;
          peak = Math.max(peak, running);
          if ((lastOrder.get(key) ?? -1) !== order - 1) throw new Error(`Out-of-order ${key}:${order}`);
          await new Promise((resolve) => setTimeout(resolve, 1));
          lastOrder.set(key, order);
          running -= 1;
        }, (error) => errors.push(error));
      }
    }
    await chains.idle();
    expect(errors).toEqual([]);
    expect(lastOrder.size).toBe(100);
    expect([...lastOrder.values()].every((order) => order === 2)).toBe(true);
    expect(peak).toBe(16);
  });

  test("finished keys are forgotten", async () => {
    const chains = new KeyedChains();
    await chains.run("a", async () => undefined);
    await chains.run("b", async () => undefined);
    await tick();
    expect(chains.size).toBe(0);
  });

  test("idle waits for work that is queued while it is waiting", async () => {
    const chains = new KeyedChains();
    const log: string[] = [];

    void chains.run("k", async () => {
      await tick();
      void chains.run("k", async () => {
        log.push("queued from inside");
      });
      log.push("first");
    });

    await chains.idle();
    expect(log).toEqual(["first", "queued from inside"]);
    expect(chains.size).toBe(0);
  });

  test("idle resolves at once when nothing is queued", async () => {
    await expect(new KeyedChains().idle()).resolves.toBeUndefined();
  });
});
