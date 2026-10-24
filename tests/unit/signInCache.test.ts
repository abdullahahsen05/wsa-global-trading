import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { AuthError, requireAuth, requireTrader, resetSignInCache, SIGN_IN_HOLD_MS } from "@/lib/auth/session";

// The sign-in of the hot paths (WSA Trade): a verified "yes" for the exact session token is reused for a few
// seconds. These tests pin what is kept, for how long, and what is never kept.

const NOW = new Date("2026-10-20T10:00:00.000Z");
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: string;
  status: string;
}

const profiles: Record<string, Profile> = {};
const profileReads: string[] = [];
let userAnswer: () => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
let sessionToken: string | null = null;

const supabase = {
  auth: {
    getUser: vi.fn(() => userAnswer()),
    getSession: vi.fn(async () => ({ data: { session: sessionToken ? { access_token: sessionToken } : null } })),
  },
  from: vi.fn((table: string) => {
    if (table !== "profiles") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: (_column: string, id: string) => ({
          single: async () => {
            profileReads.push(id);
            const profile = profiles[id];
            return profile ? { data: { ...profile }, error: null } : { data: null, error: { message: "no rows" } };
          },
        }),
      }),
    };
  }),
};

let tokenCounter = 0;

/** A session token shaped like a Supabase one (header.payload.signature); only the payload is ever looked at. */
function tokenFor(sub: string | null, expiresAtMs: number | null = NOW.getTime() + 3_600_000): string {
  tokenCounter += 1;
  const claims: Record<string, unknown> = {};
  if (sub !== null) claims.sub = sub;
  if (expiresAtMs !== null) claims.exp = Math.floor(expiresAtMs / 1000);
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature-${tokenCounter}`;
}

function profile(id: string, overrides: Partial<Profile> = {}): Profile {
  return { id, email: `${id.slice(0, 4)}@example.com`, full_name: "Test Trader", role: "TRADER", status: "ACTIVE", ...overrides };
}

/** Supabase accepts the token and says whose it is. */
function verifiesAs(id: string | null) {
  userAnswer = async () => (id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetSignInCache();
  profileReads.length = 0;
  for (const key of Object.keys(profiles)) delete profiles[key];
  profiles[USER_A] = profile(USER_A);
  profiles[USER_B] = profile(USER_B);
  supabase.auth.getUser.mockClear();
  supabase.auth.getSession.mockClear();
  supabase.from.mockClear();
  sessionToken = tokenFor(USER_A);
  verifiesAs(USER_A);
  vi.mocked(createClient).mockResolvedValue(supabase as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the full check stays the default", () => {
  test("without the option every request asks Supabase to verify the token and reads the profile again", async () => {
    await requireTrader();
    await requireTrader();

    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
    expect(profileReads).toEqual([USER_A, USER_A]);
  });

  test("the profile is read while Supabase verifies the token: one round trip, and the read counts only for the verified person", async () => {
    await requireTrader();
    expect(profileReads).toEqual([USER_A]); // the token names USER_A, Supabase confirms USER_A: no second read

    // a token that CLAIMS to be USER_B but that Supabase says belongs to USER_A: the early read of B is thrown away
    profileReads.length = 0;
    sessionToken = tokenFor(USER_B);
    verifiesAs(USER_A);
    const user = await requireTrader();
    expect(user.id).toBe(USER_A);
    expect(profileReads).toEqual([USER_B, USER_A]);

    // a token Supabase does not accept gets nothing, whatever it claims
    verifiesAs(null);
    await expect(requireTrader()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("a person who is signed out is refused, a suspended one too, a partner is not a trader", async () => {
    verifiesAs(null);
    await expect(requireAuth()).rejects.toMatchObject({ code: "UNAUTHORIZED", statusCode: 401 });

    verifiesAs(USER_A);
    profiles[USER_A] = profile(USER_A, { status: "SUSPENDED" });
    await expect(requireAuth()).rejects.toMatchObject({ code: "SUSPENDED", statusCode: 403 });

    profiles[USER_A] = profile(USER_A, { role: "PARTNER" });
    await expect(requireTrader()).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(requireTrader()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("a verified sign-in is reused for a few seconds", () => {
  test("the second request with the same token asks nobody - only the session cookie is read", async () => {
    const first = await requireTrader({ cached: true });
    const second = await requireTrader({ cached: true });

    expect(first).toMatchObject({ id: USER_A, role: "TRADER", status: "ACTIVE" });
    expect(second).toEqual(first);
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
    expect(profileReads).toEqual([USER_A]);
    expect(supabase.auth.getSession).toHaveBeenCalledTimes(2);
  });

  test("it holds for ten seconds and not a moment longer", async () => {
    await requireTrader({ cached: true });

    vi.setSystemTime(NOW.getTime() + SIGN_IN_HOLD_MS - 100);
    await requireTrader({ cached: true });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW.getTime() + SIGN_IN_HOLD_MS + 100);
    await requireTrader({ cached: true });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
    expect(profileReads).toEqual([USER_A, USER_A]);
  });

  test("never beyond the life of the token itself", async () => {
    sessionToken = tokenFor(USER_A, NOW.getTime() + 4_000);
    await requireTrader({ cached: true });

    vi.setSystemTime(NOW.getTime() + 3_000);
    await requireTrader({ cached: true });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW.getTime() + 4_500);
    await requireTrader({ cached: true });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
  });

  test("a token that has already run out is not held at all", async () => {
    sessionToken = tokenFor(USER_A, NOW.getTime() - 1_000);
    await requireTrader({ cached: true });
    await requireTrader({ cached: true });

    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
  });

  test("a renewed session (another token) is checked on its own", async () => {
    await requireTrader({ cached: true });
    sessionToken = tokenFor(USER_A);
    await requireTrader({ cached: true });

    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
  });

  test("two people never share a sign-in", async () => {
    await requireTrader({ cached: true });

    sessionToken = tokenFor(USER_B);
    verifiesAs(USER_B);
    const other = await requireTrader({ cached: true });

    expect(other.id).toBe(USER_B);
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
  });

  test("what comes back is a copy: changing it does not change what is held", async () => {
    const first = await requireTrader({ cached: true });
    first.role = "ADMIN";
    first.status = "SUSPENDED";

    const second = await requireTrader({ cached: true });

    expect(second).toMatchObject({ role: "TRADER", status: "ACTIVE" });
  });

  test("requests that arrive while the token is being verified wait for that one check", async () => {
    let release: () => void = () => undefined;
    userAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ data: { user: { id: USER_A } }, error: null });
      });

    const together = Promise.all([requireTrader({ cached: true }), requireTrader({ cached: true }), requireTrader({ cached: true })]);
    await vi.advanceTimersByTimeAsync(0);
    release();
    const people = await together;

    expect(people.map((person) => person.id)).toEqual([USER_A, USER_A, USER_A]);
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
    expect(profileReads).toEqual([USER_A]);
  });
});

describe("only a yes is ever kept", () => {
  test("a token Supabase does not accept is refused every time - the refusal is not remembered", async () => {
    verifiesAs(null);
    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);

    // the same token is accepted after all (a short outage on the way): the next request gets in
    verifiesAs(USER_A);
    await expect(requireTrader({ cached: true })).resolves.toMatchObject({ id: USER_A });
  });

  test("no session cookie: refused at once, nobody is asked", async () => {
    sessionToken = null;

    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "UNAUTHORIZED", statusCode: 401 });
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
    expect(profileReads).toHaveLength(0);
  });

  test("a person without a profile is refused and nothing is held", async () => {
    delete profiles[USER_A];

    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
  });

  test("a failing check is a refusal, never an exception to the route", async () => {
    userAnswer = async () => {
      throw new Error("socket hang up");
    };

    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("a suspension counts as soon as the hold has run out - and the person is refused", async () => {
    await requireTrader({ cached: true });
    profiles[USER_A] = profile(USER_A, { status: "SUSPENDED" });

    // within the hold the picture of a few seconds ago is used (this is the price of the speed)
    await expect(requireTrader({ cached: true })).resolves.toMatchObject({ status: "ACTIVE" });

    vi.setSystemTime(NOW.getTime() + SIGN_IN_HOLD_MS + 1);
    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "SUSPENDED", statusCode: 403 });
  });

  test("a role that changed is read again when the hold has run out", async () => {
    await requireTrader({ cached: true });
    profiles[USER_A] = profile(USER_A, { role: "PARTNER" });

    vi.setSystemTime(NOW.getTime() + SIGN_IN_HOLD_MS + 1);
    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("one round trip instead of two", () => {
  test("the profile is read while Supabase still verifies the token", async () => {
    let release: () => void = () => undefined;
    userAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ data: { user: { id: USER_A } }, error: null });
      });

    const signedIn = requireTrader({ cached: true });
    await vi.advanceTimersByTimeAsync(0);

    // the token has not been verified yet, and the profile of the person it names is already on its way
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
    expect(profileReads).toEqual([USER_A]);

    release();
    await expect(signedIn).resolves.toMatchObject({ id: USER_A });
    expect(profileReads).toEqual([USER_A]);
  });

  test("a token that names somebody else than Supabase verified never lends that person's profile", async () => {
    // the token says USER_B, Supabase verifies USER_A: the early read of B is thrown away
    sessionToken = tokenFor(USER_B);
    verifiesAs(USER_A);

    const person = await requireTrader({ cached: true });

    expect(person.id).toBe(USER_A);
    expect(profileReads).toEqual([USER_B, USER_A]);
  });

  test("a forged token gets nothing, whatever it says about itself", async () => {
    sessionToken = tokenFor(USER_B);
    verifiesAs(null);

    await expect(requireTrader({ cached: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(profileReads).toEqual([USER_B]); // (read with the forger's own token: row-level security gives it nothing)
  });

  test("a token that says nothing about itself is verified first and its profile read after", async () => {
    sessionToken = "an-opaque-token";

    const person = await requireTrader({ cached: true });

    expect(person.id).toBe(USER_A);
    expect(profileReads).toEqual([USER_A]);
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);

    // (no expiry in it: the ten seconds apply)
    await requireTrader({ cached: true });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
  });

  test("an early read that fails is read again after the verification", async () => {
    let attempts = 0;
    const original = supabase.from.getMockImplementation();
    supabase.from.mockImplementationOnce(() => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            attempts += 1;
            throw new Error("connection reset");
          },
        }),
      }),
    }));

    const person = await requireTrader({ cached: true });

    expect(person.id).toBe(USER_A);
    expect(attempts).toBe(1);
    expect(profileReads).toEqual([USER_A]);
    if (original) supabase.from.mockImplementation(original);
  });
});
