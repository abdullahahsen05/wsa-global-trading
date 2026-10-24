// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SHELL_HINT_KEY,
  SHELL_HINT_MAX_AGE_MS,
  clearShellHint,
  parseShellHint,
  readShellHint,
  rememberShellHint,
  resetShellHintCache,
  serializeShellHint,
  subscribeShellHint,
} from "@/lib/shell/shellHint";
import { LAST_ACCOUNT_KEY, forgetLastAccount, parseLastAccount, readLastAccount, rememberLastAccount } from "@/lib/shell/lastAccount";

// What the app shell remembers in the browser so a reload draws the navigation at once: a hint (id + role, never a
// credential) and the account looked at last. Both are guesses that the server's answer replaces.

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  window.localStorage.clear();
  resetShellHintCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseShellHint", () => {
  test("keeps the id and the role of a fresh hint and nothing else", () => {
    const raw = JSON.stringify({ id: ID, role: "ADMIN", at: NOW - 1_000, email: "a@b.c", token: "secret" });
    expect(parseShellHint(raw, NOW)).toEqual({ id: ID, role: "ADMIN", at: NOW - 1_000 });
    expect(parseShellHint(serializeShellHint({ id: ID, role: "PARTNER" }, NOW), NOW)).toEqual({ id: ID, role: "PARTNER", at: NOW });
  });

  test("refuses what is missing, damaged, unknown, too old or from the future", () => {
    const hint = (over: Record<string, unknown>) => JSON.stringify({ id: ID, role: "TRADER", at: NOW, ...over });
    expect(parseShellHint(null, NOW)).toBeNull();
    expect(parseShellHint("{not json", NOW)).toBeNull();
    expect(parseShellHint("null", NOW)).toBeNull();
    expect(parseShellHint(hint({ role: "ROOT" }), NOW)).toBeNull();
    expect(parseShellHint(hint({ id: "" }), NOW)).toBeNull();
    expect(parseShellHint(hint({ id: "x".repeat(65) }), NOW)).toBeNull();
    expect(parseShellHint(hint({ at: "yesterday" }), NOW)).toBeNull();
    expect(parseShellHint(hint({ at: NOW - SHELL_HINT_MAX_AGE_MS - 1 }), NOW)).toBeNull();
    expect(parseShellHint(hint({ at: NOW + 120_000 }), NOW)).toBeNull();
    expect(parseShellHint(hint({ at: NOW + 30_000 }), NOW)).not.toBeNull(); // a little clock difference is fine
  });
});

describe("the remembered session", () => {
  test("is stored, handed out as one stable object, and announced to whoever listens", () => {
    const listener = vi.fn();
    const off = subscribeShellHint(listener);
    expect(readShellHint()).toBeNull();

    rememberShellHint({ id: ID, role: "TRADER" });
    expect(listener).toHaveBeenCalledTimes(1);
    const hint = readShellHint();
    expect(hint).toMatchObject({ id: ID, role: "TRADER" });
    expect(readShellHint()).toBe(hint); // same object until storage changes - what useSyncExternalStore needs
    off();
  });

  test("is not written again for the same person and role within the hour", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    rememberShellHint({ id: ID, role: "TRADER" });
    rememberShellHint({ id: ID, role: "TRADER" });
    expect(setItem).toHaveBeenCalledTimes(1);

    rememberShellHint({ id: ID, role: "ADMIN" }); // a role change is written at once
    expect(setItem).toHaveBeenCalledTimes(2);

    vi.setSystemTime(NOW + 61 * 60_000);
    rememberShellHint({ id: ID, role: "ADMIN" }); // an hour later it is renewed
    expect(setItem).toHaveBeenCalledTimes(3);
  });

  test("an old entry in storage is ignored, and clearing removes it and says so (clearing nothing is silent)", () => {
    window.localStorage.setItem(SHELL_HINT_KEY, serializeShellHint({ id: ID, role: "TRADER" }, NOW - SHELL_HINT_MAX_AGE_MS - 5));
    expect(readShellHint()).toBeNull();

    rememberShellHint({ id: ID, role: "TRADER" });
    const listener = vi.fn();
    const off = subscribeShellHint(listener);
    clearShellHint();
    expect(window.localStorage.getItem(SHELL_HINT_KEY)).toBeNull();
    expect(readShellHint()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    clearShellHint();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  test("a storage that refuses to answer never breaks the shell", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readShellHint()).toBeNull();
    expect(() => rememberShellHint({ id: ID, role: "TRADER" })).not.toThrow();
    expect(() => clearShellHint()).not.toThrow();
    expect(readLastAccount(ID)).toBeNull();
    expect(() => rememberLastAccount(ID, ACCOUNT)).not.toThrow();
  });
});

describe("the account looked at last", () => {
  test("is a guess only for the same person and only a real account id", () => {
    const raw = JSON.stringify({ u: ID, a: ACCOUNT });
    expect(parseLastAccount(raw, ID)).toBe(ACCOUNT);
    expect(parseLastAccount(raw, "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(parseLastAccount(JSON.stringify({ u: ID, a: "not-a-uuid" }), ID)).toBeNull();
    expect(parseLastAccount("{broken", ID)).toBeNull();
    expect(parseLastAccount(null, ID)).toBeNull();
    expect(parseLastAccount(raw, "")).toBeNull();
  });

  test("is remembered per person and forgotten on log-out", () => {
    expect(readLastAccount(ID)).toBeNull();
    rememberLastAccount(ID, ACCOUNT);
    expect(readLastAccount(ID)).toBe(ACCOUNT);
    expect(readLastAccount("22222222-2222-4222-8222-222222222222")).toBeNull();

    rememberLastAccount(ID, "not-a-uuid"); // refused, the old one stays
    expect(readLastAccount(ID)).toBe(ACCOUNT);

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    rememberLastAccount(ID, ACCOUNT); // same value: no write
    expect(setItem).not.toHaveBeenCalled();

    forgetLastAccount();
    expect(window.localStorage.getItem(LAST_ACCOUNT_KEY)).toBeNull();
    expect(readLastAccount(ID)).toBeNull();
  });
});
