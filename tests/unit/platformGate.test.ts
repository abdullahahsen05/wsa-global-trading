// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ACCESS_HINT_KEY,
  ACCESS_HINT_MAX_AGE_MS,
  forgetAccessHint,
  parseAccessHint,
  readRememberedAccess,
  rememberAccessVerdict,
  serializeAccessHint,
  subscribeAccessHint,
} from "@/lib/shell/accessHint";
import { SHELL_HINT_KEY, clearShellHint, resetShellHintCache, serializeShellHint } from "@/lib/shell/shellHint";
import { usePlatformGate } from "@/hooks/useTraderAccessSummary";
import { json, mount, settle, text, unmountAll } from "./helpers/reactDom";

// The gated pages used to show "Loading your platform access status." for one whole request and only THEN start their
// own requests. For somebody this browser remembers as active they now draw - and ask for their data - at once, and the
// server's answer still has the last word.

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const session = { id: ID, email: "a@b.c", name: "Alba", role: "TRADER", status: "ACTIVE" };
const billing = (status: string) => ({
  ok: true,
  data: {
    platformSubscription: {
      id: "",
      productCode: "PLATFORM_MONTHLY",
      productName: "Platform Subscription",
      status,
      currentPeriodEnd: null,
      approvedAt: null,
      orderId: null,
      message: "",
    },
  },
});

/** A request that is answered when the test says so. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stubFetch(routes: { session: () => Promise<Response>; billing: () => Promise<Response> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) return routes.session();
      if (url.includes("/api/billing/me")) return routes.billing();
      throw new Error(`unexpected request ${url}`);
    }),
  );
}

function Probe() {
  const gate = usePlatformGate();
  return createElement("p", null, `${gate.checking ? "checking" : gate.access.status}${gate.assumed ? " (assumed)" : ""}`);
}

beforeEach(() => {
  window.localStorage.clear();
  resetShellHintCache();
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the remembered access", () => {
  test("is 'active' only for exactly this person, while fresh", () => {
    const raw = serializeAccessHint(ID, NOW - 1_000);
    expect(parseAccessHint(raw, ID, NOW)).toBe(true);
    expect(parseAccessHint(raw, OTHER, NOW)).toBe(false);
    expect(parseAccessHint(raw, null, NOW)).toBe(false);
    expect(parseAccessHint(null, ID, NOW)).toBe(false);
    expect(parseAccessHint("{broken", ID, NOW)).toBe(false);
    expect(parseAccessHint(serializeAccessHint(ID, NOW - ACCESS_HINT_MAX_AGE_MS - 1), ID, NOW)).toBe(false);
    expect(parseAccessHint(serializeAccessHint(ID, NOW + 120_000), ID, NOW)).toBe(false);
    expect(parseAccessHint(JSON.stringify({ u: ID }), ID, NOW)).toBe(false);
  });

  test("'active' is remembered and announced, anything else forgets it, and a refusing storage breaks nothing", () => {
    const listener = vi.fn();
    const off = subscribeAccessHint(listener);

    expect(readRememberedAccess(ID)).toBe(false);
    rememberAccessVerdict(ID, true);
    expect(readRememberedAccess(ID)).toBe(true);
    expect(readRememberedAccess(OTHER)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    rememberAccessVerdict(ID, true); // renewed only after half an hour
    expect(setItem).not.toHaveBeenCalled();

    rememberAccessVerdict(ID, false); // the server said 'not active'
    expect(readRememberedAccess(ID)).toBe(false);
    expect(window.localStorage.getItem(ACCESS_HINT_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    rememberAccessVerdict(ID, false); // nothing to forget: silent
    expect(listener).toHaveBeenCalledTimes(2);
    off();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRememberedAccess(ID)).toBe(false);
    expect(() => rememberAccessVerdict(ID, true)).not.toThrow();
    expect(() => forgetAccessHint()).not.toThrow();
  });

  test("goes together with the remembered session at log-out", () => {
    rememberAccessVerdict(ID, true);
    window.localStorage.setItem(SHELL_HINT_KEY, serializeShellHint({ id: ID, role: "TRADER" }, Date.now()));
    clearShellHint();
    expect(window.localStorage.getItem(ACCESS_HINT_KEY)).toBeNull();
    expect(window.localStorage.getItem(SHELL_HINT_KEY)).toBeNull();
  });
});

describe("usePlatformGate", () => {
  test("a first visit waits for the answer, then remembers an active subscription", async () => {
    const answer = deferred();
    stubFetch({ session: async () => json({ ok: true, data: session }), billing: () => answer.promise });

    mount(createElement(Probe));
    await settle();
    expect(text(document.body)).toBe("checking");

    answer.resolve(json(billing("ACTIVE")));
    await settle();
    expect(text(document.body)).toBe("ACTIVE");
    expect(readRememberedAccess(ID)).toBe(true);
  });

  test("somebody remembered as active is drawn as active at once; a lapsed subscription switches the page when the answer comes", async () => {
    window.localStorage.setItem(SHELL_HINT_KEY, serializeShellHint({ id: ID, role: "TRADER" }, Date.now()));
    rememberAccessVerdict(ID, true);
    const answer = deferred();
    stubFetch({ session: async () => json({ ok: true, data: session }), billing: () => answer.promise });

    mount(createElement(Probe));
    await settle();
    expect(text(document.body)).toBe("ACTIVE (assumed)"); // the access request is still on its way

    answer.resolve(json(billing("EXPIRED")));
    await settle();
    expect(text(document.body)).toBe("EXPIRED");
    expect(readRememberedAccess(ID)).toBe(false);
  });

  test("another person's remembered access is not used", async () => {
    window.localStorage.setItem(SHELL_HINT_KEY, serializeShellHint({ id: ID, role: "TRADER" }, Date.now()));
    rememberAccessVerdict(OTHER, true);
    const answer = deferred();
    stubFetch({ session: async () => json({ ok: true, data: session }), billing: () => answer.promise });

    mount(createElement(Probe));
    await settle();
    expect(text(document.body)).toBe("checking");
  });
});
