import { describe, expect, test } from "vitest";
import { runPool } from "@/lib/copy/pool";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runPool", () => {
  test("runs every item and never more than the limit at once", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];

    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      seen.push(item);
      active -= 1;
    });

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  test("a finished task makes room at once - one slow item does not hold back the next ones", async () => {
    const slow = deferred();
    const started: number[] = [];

    const run = runPool([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) await slow.promise;
    });

    await tick();
    // item 0 is stuck; item 1 finished at once, so 2 and 3 have started although 0 is still running
    expect(started).toEqual([0, 1, 2, 3]);

    slow.resolve();
    await run;
  });

  test("hands the item and its index to the task", async () => {
    const calls: Array<[string, number]> = [];
    await runPool(["a", "b", "c"], 2, async (item, index) => {
      calls.push([item, index]);
    });
    expect(calls.sort()).toEqual([["a", 0], ["b", 1], ["c", 2]]);
  });

  test("every item still runs when some tasks fail, and the first error is thrown at the end", async () => {
    const ran: number[] = [];

    await expect(
      runPool([1, 2, 3, 4, 5], 2, async (item) => {
        ran.push(item);
        if (item === 2) throw new Error("second failed");
        if (item === 4) throw new Error("fourth failed");
      }),
    ).rejects.toThrow("second failed");

    expect(ran.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("an empty list resolves at once", async () => {
    await expect(runPool([], 4, async () => undefined)).resolves.toBeUndefined();
  });

  test("a limit that is zero, negative or not a number is treated as one", async () => {
    for (const size of [0, -3, Number.NaN]) {
      let active = 0;
      let peak = 0;
      await runPool([1, 2, 3], size, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
      });
      expect(peak).toBe(1);
    }
  });

  test("a limit larger than the list starts everything together", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3], 50, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    });
    expect(peak).toBe(3);
  });
});
