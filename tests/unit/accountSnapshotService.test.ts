import { beforeEach, describe, expect, test } from "vitest";
import {
  recordAccountSnapshot,
  resetAccountSnapshotWriterState,
  type SnapshotRpcClient,
  type SnapshotRpcError,
} from "@/lib/services/accountSnapshotService";

type Call = { fn: string; args: Record<string, unknown> };

/** A fake Supabase client: answers per function name and remembers every call. */
function fakeClient(answers: Record<string, Array<SnapshotRpcError | null> | SnapshotRpcError | null>) {
  const calls: Call[] = [];
  const cursor: Record<string, number> = {};
  const client: SnapshotRpcClient = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      const answer = answers[fn];
      if (Array.isArray(answer)) {
        const index = cursor[fn] ?? 0;
        cursor[fn] = index + 1;
        return { error: answer[Math.min(index, answer.length - 1)] ?? null };
      }
      return { error: answer ?? null };
    },
  };
  return { client, calls };
}

const MISSING_FUNCTION: SnapshotRpcError = {
  code: "PGRST202",
  message: "Could not find the function public.record_account_snapshot_v2(...) in the schema cache",
};

const BASE = { accountId: "acc-1", balance: 1000, equity: 1010.5 };
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

beforeEach(() => {
  resetAccountSnapshotWriterState();
});

describe("recordAccountSnapshot", () => {
  test("without margin only the original writer is called, exactly as before", async () => {
    const { client, calls } = fakeClient({});
    const result = await recordAccountSnapshot(client, BASE, T0);

    expect(result).toEqual({ error: null, marginRecorded: false });
    expect(calls).toEqual([
      {
        fn: "record_account_snapshot",
        args: { p_account_id: "acc-1", p_balance: 1000, p_equity: 1010.5 },
      },
    ]);
  });

  test("with margin the v2 writer is used and carries all three margin values", async () => {
    const { client, calls } = fakeClient({});
    const result = await recordAccountSnapshot(
      client,
      { ...BASE, margin: 250, freeMargin: 760.5, marginLevel: 404.2 },
      T0,
    );

    expect(result).toEqual({ error: null, marginRecorded: true });
    expect(calls).toEqual([
      {
        fn: "record_account_snapshot_v2",
        args: {
          p_account_id: "acc-1",
          p_balance: 1000,
          p_equity: 1010.5,
          p_margin: 250,
          p_free_margin: 760.5,
          p_margin_level: 404.2,
        },
      },
    ]);
  });

  test("a partly known margin is still recorded, the rest as null", async () => {
    const { client, calls } = fakeClient({});
    await recordAccountSnapshot(client, { ...BASE, freeMargin: 900 }, T0);

    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("record_account_snapshot_v2");
    expect(calls[0].args).toMatchObject({ p_margin: null, p_free_margin: 900, p_margin_level: null });
  });

  test("non-finite margin values are treated as unknown", async () => {
    const { client, calls } = fakeClient({});
    const result = await recordAccountSnapshot(
      client,
      { ...BASE, margin: Number.NaN, freeMargin: Number.POSITIVE_INFINITY, marginLevel: undefined },
      T0,
    );

    expect(result.marginRecorded).toBe(false);
    expect(calls.map((call) => call.fn)).toEqual(["record_account_snapshot"]);
  });

  test("when migration 057 is missing the snapshot is still saved, in the same call", async () => {
    const { client, calls } = fakeClient({ record_account_snapshot_v2: MISSING_FUNCTION });
    const result = await recordAccountSnapshot(client, { ...BASE, margin: 10, freeMargin: 990 }, T0);

    expect(result).toEqual({ error: null, marginRecorded: false });
    expect(calls.map((call) => call.fn)).toEqual(["record_account_snapshot_v2", "record_account_snapshot"]);
    expect(calls[1].args).toEqual({ p_account_id: "acc-1", p_balance: 1000, p_equity: 1010.5 });
  });

  test("a missing v2 function is remembered for ten minutes, then tried again", async () => {
    const { client, calls } = fakeClient({ record_account_snapshot_v2: [MISSING_FUNCTION, null] });
    const withMargin = { ...BASE, margin: 10, freeMargin: 990 };

    await recordAccountSnapshot(client, withMargin, T0);
    await recordAccountSnapshot(client, withMargin, T0 + 5 * MINUTE);
    expect(calls.map((call) => call.fn)).toEqual([
      "record_account_snapshot_v2",
      "record_account_snapshot",
      "record_account_snapshot",
    ]);

    const afterWindow = await recordAccountSnapshot(client, withMargin, T0 + 10 * MINUTE);
    expect(calls.map((call) => call.fn).slice(3)).toEqual(["record_account_snapshot_v2"]);
    expect(afterWindow).toEqual({ error: null, marginRecorded: true });
  });

  test.each([
    ["Postgres undefined_function code", { code: "42883", message: "function does not exist" }],
    ["message only", { message: "function public.record_account_snapshot_v2(uuid) does not exist" }],
  ])("recognises the missing function by %s", async (_label, error) => {
    const { client, calls } = fakeClient({ record_account_snapshot_v2: error });
    const withMargin = { ...BASE, margin: 1 };

    await recordAccountSnapshot(client, withMargin, T0);
    await recordAccountSnapshot(client, withMargin, T0 + MINUTE);

    expect(calls.filter((call) => call.fn === "record_account_snapshot_v2")).toHaveLength(1);
    expect(calls.filter((call) => call.fn === "record_account_snapshot")).toHaveLength(2);
  });

  test("a temporary v2 failure falls back but is not remembered", async () => {
    const { client, calls } = fakeClient({
      record_account_snapshot_v2: [{ code: "57014", message: "canceling statement due to statement timeout" }, null],
    });
    const withMargin = { ...BASE, margin: 10, freeMargin: 990 };

    const first = await recordAccountSnapshot(client, withMargin, T0);
    const second = await recordAccountSnapshot(client, withMargin, T0 + 5_000);

    expect(first).toEqual({ error: null, marginRecorded: false });
    expect(second).toEqual({ error: null, marginRecorded: true });
    expect(calls.map((call) => call.fn)).toEqual([
      "record_account_snapshot_v2",
      "record_account_snapshot",
      "record_account_snapshot_v2",
    ]);
  });

  test("an error from the original writer is returned to the caller", async () => {
    const failure: SnapshotRpcError = { code: "P0001", message: "Trading account not found" };
    const { client } = fakeClient({ record_account_snapshot: failure });
    const result = await recordAccountSnapshot(client, BASE, T0);

    expect(result).toEqual({ error: failure, marginRecorded: false });
  });

  test("when both writers fail the original writer's error is reported", async () => {
    const failure: SnapshotRpcError = { code: "P0001", message: "Trading account not found" };
    const { client } = fakeClient({
      record_account_snapshot_v2: { code: "P0001", message: "Trading account not found" },
      record_account_snapshot: failure,
    });
    const result = await recordAccountSnapshot(client, { ...BASE, margin: 5 }, T0);

    expect(result.error).toEqual(failure);
    expect(result.marginRecorded).toBe(false);
  });
});
