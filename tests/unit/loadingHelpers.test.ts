import { afterEach, describe, expect, test, vi } from "vitest";
import { throttled } from "@/hooks/useRealtimeUpdates";
import { fetchSessionPayload, type SessionPayload } from "@/hooks/useSessionUser";

// Two small pieces of the faster page loading: the throttle that keeps the live views live without refetching them on
// every snapshot, and the session read that tells "nobody is signed in" apart from "the server could not say".

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("throttled", () => {
  test("runs at once after a quiet spell, then at most once per gap - with the last call kept", () => {
    vi.useFakeTimers({ now: 10_000_000 });
    const action = vi.fn();
    const gate = throttled(2_000, action);

    gate.call();
    expect(action).toHaveBeenCalledTimes(1); // nothing ran for a while: at once

    gate.call();
    gate.call();
    gate.call();
    expect(action).toHaveBeenCalledTimes(1); // a burst is one pending run
    vi.advanceTimersByTime(1_999);
    expect(action).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(2); // at the end of the gap

    vi.advanceTimersByTime(30_000);
    expect(action).toHaveBeenCalledTimes(2); // nothing is run without a call

    gate.call();
    expect(action).toHaveBeenCalledTimes(3); // quiet for longer than the gap: at once again
  });

  test("cancel drops the pending run", () => {
    vi.useFakeTimers({ now: 10_000_000 });
    const action = vi.fn();
    const gate = throttled(1_500, action);
    gate.call();
    gate.call();
    gate.cancel();
    vi.advanceTimersByTime(5_000);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("fetchSessionPayload", () => {
  const person: SessionPayload = { id: "u1", email: "a@b.c", name: "A", role: "TRADER", status: "ACTIVE" };

  function answer(status: number, body: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  }

  test("hands back the signed-in person", async () => {
    answer(200, { ok: true, data: person });
    expect(await fetchSessionPayload()).toEqual(person);
  });

  test("'nobody is signed in' is null - only for a real 401 / 403", async () => {
    answer(401, { ok: false, error: { code: "UNAUTHORIZED", message: "no" } });
    expect(await fetchSessionPayload()).toBeNull();
    answer(403, {});
    expect(await fetchSessionPayload()).toBeNull();
    answer(200, { ok: false, error: { code: "UNAUTHORIZED", message: "no" } });
    expect(await fetchSessionPayload()).toBeNull();
  });

  test("a busy server, a rate limit or a dropped connection is an error, never a log-out", async () => {
    answer(429, { ok: false, error: { code: "RATE_LIMITED", message: "Slow down" } });
    await expect(fetchSessionPayload()).rejects.toThrow("Slow down");
    answer(500, "oops");
    await expect(fetchSessionPayload()).rejects.toThrow("Could not verify your session.");
    answer(200, { ok: true });
    await expect(fetchSessionPayload()).rejects.toThrow("Could not verify your session.");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(fetchSessionPayload()).rejects.toThrow("Failed to fetch");
  });
});
