import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import {
  ORDER_PASS_LIFE_MS,
  ORDER_PASS_RISK_LIFE_MS,
  mintOrderPass,
  readOrderPass,
  type OrderPassInput,
} from "@/lib/services/webTradePass";

// The order pass: a small signed note of "this session, this account, checked a moment ago" that the state poll hands
// to the panel and the order routes take back. It saves the sign-in, subscription and account round trips on a cold
// instance - so what it is worth, and what it is NOT worth, is pinned here.

const NOW = Date.parse("2026-10-24T10:00:00.000Z");
const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TOKEN = "token-key-1";

function input(overrides: Partial<OrderPassInput> = {}): OrderPassInput {
  return {
    user: { id: USER, role: "TRADER" },
    accountId: ACCOUNT,
    tokenKey: TOKEN,
    tokenExpiresAtMs: null,
    riskReadAt: NOW,
    aws: { longPoll: true, direct: true, dbMs: 12, loopMs: 3 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("WSA_ORDER_PASS_SECRET", "order-pass-test-secret-0123456789");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the order pass", () => {
  test("is read back for the session token it was made for", () => {
    const pass = mintOrderPass(input(), NOW);
    expect(pass).toBeTruthy();
    expect(readOrderPass(pass, { tokenKey: TOKEN }, NOW + 1_000)).toEqual({
      v: 1,
      user: USER,
      role: "TRADER",
      account: ACCOUNT,
      token: TOKEN,
      until: NOW + ORDER_PASS_LIFE_MS,
      riskUntil: NOW + ORDER_PASS_RISK_LIFE_MS,
      aws: { dbMs: 12, loopMs: 3, longPoll: true, direct: true },
    });
  });

  test("is worth nothing for another session, once it has run out, or when it was touched", () => {
    const pass = mintOrderPass(input(), NOW) as string;
    expect(readOrderPass(pass, { tokenKey: "another-token" }, NOW + 1_000)).toBeNull();
    expect(readOrderPass(pass, { tokenKey: TOKEN }, NOW + ORDER_PASS_LIFE_MS)).toBeNull();

    // somebody turns the role into ADMIN and keeps the old signature
    const [body, sig] = pass.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = `${Buffer.from(JSON.stringify({ ...claims, role: "ADMIN" })).toString("base64url")}.${sig}`;
    expect(readOrderPass(forged, { tokenKey: TOKEN }, NOW + 1_000)).toBeNull();

    for (const junk of ["", "x", "a.b.c", `${body}.`, `.${sig}`, null, undefined]) {
      expect(readOrderPass(junk, { tokenKey: TOKEN }, NOW + 1_000)).toBeNull();
    }
  });

  test("a pass signed with another key is not accepted", () => {
    const pass = mintOrderPass(input(), NOW);
    vi.stubEnv("WSA_ORDER_PASS_SECRET", "a-completely-different-secret-9876543210");
    expect(readOrderPass(pass, { tokenKey: TOKEN }, NOW + 1_000)).toBeNull();
  });

  test("never outlives the session token, and is not made for a token that is about to end", () => {
    const short = mintOrderPass(input({ tokenExpiresAtMs: NOW + 4_000 }), NOW);
    expect(readOrderPass(short, { tokenKey: TOKEN }, NOW + 1_000)?.until).toBe(NOW + 4_000);
    expect(readOrderPass(short, { tokenKey: TOKEN }, NOW + 4_000)).toBeNull();
    expect(mintOrderPass(input({ tokenExpiresAtMs: NOW + 500 }), NOW)).toBeNull();
  });

  test("says nothing about risk unless the verdict was 'clear', and trusts it for 3 seconds only", () => {
    const unknown = mintOrderPass(input({ riskReadAt: null }), NOW);
    expect(readOrderPass(unknown, { tokenKey: TOKEN }, NOW + 1_000)).not.toHaveProperty("riskUntil");

    const older = mintOrderPass(input({ riskReadAt: NOW - 2_000 }), NOW);
    expect(readOrderPass(older, { tokenKey: TOKEN }, NOW + 500)?.riskUntil).toBe(NOW - 2_000 + ORDER_PASS_RISK_LIFE_MS);
  });

  test("without a key nothing is minted and nothing is accepted - every order is then checked the long way", () => {
    const pass = mintOrderPass(input(), NOW);
    vi.stubEnv("WSA_ORDER_PASS_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(mintOrderPass(input(), NOW)).toBeNull();
    expect(readOrderPass(pass, { tokenKey: TOKEN }, NOW + 1_000)).toBeNull();
  });
});
