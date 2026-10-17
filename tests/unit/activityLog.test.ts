import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog, isMissingSchema, type ActivityDbError } from "@/lib/copy/activityLog";

type Row = { n: number };

function create(options: {
  results?: Array<ActivityDbError | null | "throw">;
  maxQueue?: number;
  clock?: { now: number };
} = {}) {
  const batches: Row[][] = [];
  const problems: string[] = [];
  const results = [...(options.results ?? [])];
  const clock = options.clock ?? { now: 1_000_000 };
  const log = new ActivityLog<Row>({
    insert: async (rows) => {
      batches.push(rows);
      const next = results.shift();
      if (next === "throw") throw new Error("socket hang up");
      return { error: next ?? null };
    },
    flushMs: 400,
    maxQueue: options.maxQueue ?? 500,
    missingTableBackoffMs: 600_000,
    now: () => clock.now,
    onProblem: (message) => problems.push(message),
  });
  return { log, batches, problems, clock };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isMissingSchema", () => {
  it("recognises a missing table or column", () => {
    for (const code of ["42P01", "PGRST205", "42703", "PGRST204"]) expect(isMissingSchema({ code })).toBe(true);
    expect(isMissingSchema({ code: "23505" })).toBe(false);
    expect(isMissingSchema({ message: "boom" })).toBe(false);
    expect(isMissingSchema(null)).toBe(false);
    expect(isMissingSchema(undefined)).toBe(false);
  });
});

describe("ActivityLog", () => {
  it("writes the rows of a moment together, a little later", async () => {
    const { log, batches } = create();
    log.record({ n: 1 });
    log.record({ n: 2 });
    expect(log.pending).toBe(2);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(batches).toEqual([[{ n: 1 }, { n: 2 }]]);
    expect(log.pending).toBe(0);
  });

  it("writes at once when asked to", async () => {
    const { log, batches } = create();
    log.record({ n: 1 });
    await log.flush();
    expect(batches).toEqual([[{ n: 1 }]]);
    // the timer that was waiting must not write the same row again
    await vi.advanceTimersByTimeAsync(2_000);
    expect(batches).toHaveLength(1);
  });

  it("has nothing to do when nothing was recorded", async () => {
    const { log, batches } = create();
    await log.flush();
    expect(batches).toHaveLength(0);
  });

  it("stays off while the table is missing, tells once, and comes back later", async () => {
    const { log, batches, problems, clock } = create({ results: [{ code: "42P01", message: "relation does not exist" }] });
    log.record({ n: 1 });
    await log.flush();
    expect(log.disabled).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/migration 061/);

    log.record({ n: 2 });
    expect(log.pending).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(batches).toHaveLength(1);

    clock.now += 600_001;
    expect(log.disabled).toBe(false);
    log.record({ n: 3 });
    await log.flush();
    expect(batches).toEqual([[{ n: 1 }], [{ n: 3 }]]);
  });

  it("keeps the rows of a failed write and sends them with the next batch, in order", async () => {
    const { log, batches, problems } = create({ results: [{ code: "XX000", message: "connection reset" }, null] });
    log.record({ n: 1 });
    log.record({ n: 2 });
    await log.flush();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/connection reset/);
    expect(log.pending).toBe(2);

    log.record({ n: 3 });
    await log.flush();
    expect(batches).toEqual([[{ n: 1 }, { n: 2 }], [{ n: 1 }, { n: 2 }, { n: 3 }]]);
    expect(log.pending).toBe(0);
  });

  it("tries a failed batch again by itself", async () => {
    const { log, batches } = create({ results: ["throw", null] });
    log.record({ n: 1 });
    await log.flush();
    expect(batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(batches).toEqual([[{ n: 1 }], [{ n: 1 }]]);
    expect(log.pending).toBe(0);
  });

  it("never rejects, even when the write throws", async () => {
    const { log, problems } = create({ results: ["throw"] });
    log.record({ n: 1 });
    await expect(log.flush()).resolves.toBeUndefined();
    expect(problems[0]).toMatch(/socket hang up/);
  });

  it("does not report the same trouble more than once a minute", async () => {
    const { log, problems, clock } = create({ results: [{ code: "XX000" }, { code: "XX000" }, { code: "XX000" }] });
    log.record({ n: 1 });
    await log.flush();
    log.record({ n: 2 });
    await log.flush();
    expect(problems).toHaveLength(1);
    clock.now += 61_000;
    log.record({ n: 3 });
    await log.flush();
    expect(problems).toHaveLength(2);
  });

  it("keeps the queue bounded by dropping the oldest rows", async () => {
    const { log, batches } = create({ maxQueue: 3 });
    for (let n = 1; n <= 5; n += 1) log.record({ n });
    expect(log.pending).toBe(3);
    await log.flush();
    expect(batches).toEqual([[{ n: 3 }, { n: 4 }, { n: 5 }]]);
  });

  it("hands the same write to everybody who flushes at the same time", async () => {
    const { log, batches } = create();
    log.record({ n: 1 });
    const first = log.flush();
    const second = log.flush();
    expect(first).toBe(second);
    await first;
    expect(batches).toHaveLength(1);
  });
});
