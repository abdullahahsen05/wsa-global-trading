import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  discoverBrokerWebTerminal,
  realDiscoveryDeps,
  resetBrokerWebTerminalState,
  resolveBrokerWebTerminal,
  type DiscoveryDeps,
  type FetchedPage,
  type ResolveInput,
} from "@/lib/services/brokerWebTerminalService";
import { registrableDomain, terminalHostCandidates } from "@/lib/terminal/brokerTerminal";
import { fakeDb } from "./helpers/fakeSupabase";

vi.mock("@/lib/supabase/admin", async () => {
  const { fakeDb: db } = await import("./helpers/fakeSupabase");
  return { createAdminClient: () => ({ from: db.from }) };
});

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const OWN = "https://app.wsa.test";

const START = Date.UTC(2026, 9, 12, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TERMINAL_URL = "https://webtrader.icmarkets.com/";

function terminalHtml(version: 4 | 5): string {
  return `<html><head><title>MetaTrader ${version} WebTrader | IC Markets</title></head><body>MetaTrader ${version} web terminal</body></html>`;
}

/** A small, scriptable stand-in for the public web, the broker directory and the clock. */
class World {
  clock = START;
  company: { name: string | null; website: string | null } | null = null;
  companyFails = false;
  /** how far the clock moves while the broker directory is asked (a slow directory) */
  directoryDelay = 0;
  /** the broker directory answers only when this promise is resolved */
  gate: Promise<void> | null = null;
  /** a bug inside the look (throws synchronously) */
  crash = false;
  pages = new Map<string, Partial<FetchedPage>>();
  failUrls = new Set<string>();
  resolvable = new Set<string>();
  fetched: string[] = [];
  lookups = 0;

  deps: DiscoveryDeps = {
    now: () => this.clock,
    lookupCompany: async () => {
      this.lookups += 1;
      if (this.gate) await this.gate;
      this.clock += this.directoryDelay;
      if (this.companyFails) throw new Error("the directory is down");
      return this.company;
    },
    hostResolves: (host) => {
      if (this.crash) throw new Error("boom");
      return Promise.resolve(this.resolvable.has(host));
    },
    fetchPage: async (url) => {
      this.fetched.push(url);
      if (this.failUrls.has(url)) throw new Error("network down");
      const entry = this.pages.get(url);
      if (!entry) return null;
      return { url, status: 200, text: "", xFrameOptions: null, contentSecurityPolicy: null, ...entry };
    },
  };
}

function icMarketsWorld(): World {
  const world = new World();
  world.company = { name: "IC Markets", website: "https://www.icmarkets.com/global/en" };
  world.resolvable.add("webtrader.icmarkets.com");
  world.pages.set(TERMINAL_URL, { text: terminalHtml(5) });
  world.pages.set("https://www.icmarkets.com/", { text: "<html><title>IC Markets</title><a href='/about'>About</a></html>" });
  return world;
}

function discoverInput(overrides: Partial<Parameters<typeof discoverBrokerWebTerminal>[0]> = {}) {
  return {
    server: "ICMarketsSC-Demo",
    brokerName: "IC Markets" as string | null,
    platform: "MT5" as const,
    ownOrigin: OWN as string | null,
    deadline: START + 8_000,
    ...overrides,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetBrokerWebTerminalState();
  fakeDb.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("discoverBrokerWebTerminal", () => {
  test("finds the terminal on the domain of the company the broker directory names", async () => {
    const world = icMarketsWorld();
    const result = await discoverBrokerWebTerminal(discoverInput(), world.deps);

    expect(result).toEqual({ url: TERMINAL_URL, embeddable: true, brokerName: "IC Markets" });
    // nothing outside the directory's domain was ever requested
    expect(world.fetched.length).toBeGreaterThan(0);
    for (const url of world.fetched) expect(registrableDomain(new URL(url).hostname)).toBe("icmarkets.com");
  });

  test("a link on the broker's own site leads to a terminal on an unusual host", async () => {
    const world = new World();
    world.company = { name: "Odd Broker", website: "https://www.oddbroker.com" };
    world.pages.set("https://www.oddbroker.com/", {
      text: `<a href="/about">About</a><a href="https://clients.oddbroker.com/platform/mt5-web">Launch WebTrader</a>`,
    });
    world.pages.set("https://clients.oddbroker.com/platform/mt5-web", { text: terminalHtml(5) });

    const result = await discoverBrokerWebTerminal(discoverInput({ server: "OddBroker-Live", brokerName: "Odd Broker" }), world.deps);

    expect(result?.url).toBe("https://clients.oddbroker.com/platform/mt5-web");
  });

  test("the company in the directory decides the domain, even when its brand differs from the server name", async () => {
    const world = new World();
    world.company = { name: "Some Holding Ltd", website: "https://www.some-holding.com" };
    world.resolvable.add("mt5.some-holding.com");
    world.pages.set("https://mt5.some-holding.com/", { text: terminalHtml(5) });

    const result = await discoverBrokerWebTerminal(discoverInput({ server: "ABC-Live", brokerName: null }), world.deps);

    expect(result).toEqual({ url: "https://mt5.some-holding.com/", embeddable: true, brokerName: "Some Holding Ltd" });
    for (const url of world.fetched) expect(registrableDomain(new URL(url).hostname)).toBe("some-holding.com");
  });

  test("without a website in the directory only domains that carry the brand are tried - never a typed-in name", async () => {
    const world = new World();
    world.resolvable.add("webtrader.icmarkets.com");
    world.pages.set(TERMINAL_URL, { text: terminalHtml(5) });

    const result = await discoverBrokerWebTerminal(discoverInput({ brokerName: "evil.example.net" }), world.deps);

    expect(result?.url).toBe(TERMINAL_URL);
    const domains = new Set(world.fetched.map((url) => registrableDomain(new URL(url).hostname)));
    expect([...domains].every((domain) => domain === "icmarkets.com" || domain === "icmarketssc.com")).toBe(true);
    // a good answer on the first domain ends the search
    expect(domains.has("icmarketssc.com")).toBe(false);
  });

  test("a website that is not a web address falls back to the brand, and so does a directory that fails", async () => {
    const odd = icMarketsWorld();
    odd.company = { name: "IC Markets", website: "javascript:alert(1)" };
    expect((await discoverBrokerWebTerminal(discoverInput(), odd.deps))?.url).toBe(TERMINAL_URL);

    const down = icMarketsWorld();
    down.companyFails = true;
    expect((await discoverBrokerWebTerminal(discoverInput(), down.deps))?.url).toBe(TERMINAL_URL);
  });

  test("a page that is not a terminal is not chosen, nor one that only knows the other platform", async () => {
    const parked = icMarketsWorld();
    parked.pages.set(TERMINAL_URL, { text: "<title>This domain is for sale</title>" });
    expect(await discoverBrokerWebTerminal(discoverInput(), parked.deps)).toBeNull();

    const mt4Only = icMarketsWorld();
    mt4Only.pages.set(TERMINAL_URL, { text: terminalHtml(4) });
    expect(await discoverBrokerWebTerminal(discoverInput(), mt4Only.deps)).toBeNull();
    expect((await discoverBrokerWebTerminal(discoverInput({ platform: "MT4" }), mt4Only.deps))?.url).toBe(TERMINAL_URL);
  });

  test("error pages, missing pages and redirects away from the broker's domain are ignored", async () => {
    for (const entry of [
      { status: 404 },
      { status: 500 },
      { status: 301 },
      { url: "https://evil.example.net/" },
      { url: "https://icmarkets.com.evil.net/" },
    ]) {
      const world = icMarketsWorld();
      world.pages.set(TERMINAL_URL, { text: terminalHtml(5), ...entry });
      expect(await discoverBrokerWebTerminal(discoverInput(), world.deps)).toBeNull();
    }
  });

  test("a terminal that forbids being framed is still found, but flagged", async () => {
    const world = icMarketsWorld();
    world.pages.set(TERMINAL_URL, { text: terminalHtml(5), xFrameOptions: "DENY" });
    expect(await discoverBrokerWebTerminal(discoverInput(), world.deps)).toMatchObject({ url: TERMINAL_URL, embeddable: false });

    world.pages.set(TERMINAL_URL, { text: terminalHtml(5), contentSecurityPolicy: "frame-ancestors 'self'" });
    expect(await discoverBrokerWebTerminal(discoverInput(), world.deps)).toMatchObject({ embeddable: false });

    // allowed for this very platform
    world.pages.set(TERMINAL_URL, { text: terminalHtml(5), contentSecurityPolicy: `frame-ancestors ${OWN}` });
    expect(await discoverBrokerWebTerminal(discoverInput(), world.deps)).toMatchObject({ embeddable: true });
  });

  test("the best candidate wins: a dedicated terminal host beats a general page about the platform", async () => {
    const world = icMarketsWorld();
    world.resolvable.add("web.icmarkets.com");
    world.pages.set("https://web.icmarkets.com/", { text: "<title>MetaTrader 5 platforms</title><p>MT5</p>" });

    expect((await discoverBrokerWebTerminal(discoverInput(), world.deps))?.url).toBe(TERMINAL_URL);
  });

  test("at most eight candidates are fetched per domain", async () => {
    const world = new World();
    world.company = { name: "Big Broker", website: "https://www.bigbroker.com" };
    for (const host of terminalHostCandidates("bigbroker.com", "MT5")) world.resolvable.add(host);

    expect(await discoverBrokerWebTerminal(discoverInput({ server: "BigBroker-Live", brokerName: null }), world.deps)).toBeNull();

    const candidates = world.fetched.filter((url) => !/^https:\/\/(www\.)?bigbroker\.com\/$/.test(url));
    expect(candidates).toHaveLength(8);
  });

  test("one failing request does not stop the others", async () => {
    const world = icMarketsWorld();
    world.resolvable.add("mt5.icmarkets.com");
    world.pages.set("https://mt5.icmarkets.com/", { text: terminalHtml(5) });
    world.failUrls.add(TERMINAL_URL);

    expect((await discoverBrokerWebTerminal(discoverInput(), world.deps))?.url).toBe("https://mt5.icmarkets.com/");
  });

  test("an expired deadline stops everything before the first page is requested", async () => {
    const world = icMarketsWorld();
    expect(await discoverBrokerWebTerminal(discoverInput({ deadline: START }), world.deps)).toBeNull();
    expect(world.fetched).toEqual([]);
  });

  test("a server name without a usable key looks at nothing", async () => {
    const world = icMarketsWorld();
    expect(await discoverBrokerWebTerminal(discoverInput({ server: "x" }), world.deps)).toBeNull();
    expect(world.lookups).toBe(0);
    expect(world.fetched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function resolveWith(world: World, overrides: Partial<ResolveInput> = {}) {
  return resolveBrokerWebTerminal(
    { userId: USER, server: "ICMarketsSC-Demo", platform: "MT5", brokerName: "IC Markets", ownOrigin: OWN, ...overrides },
    world.deps,
  );
}

const rows = () => fakeDb.tables.broker_web_terminals ?? [];

describe("resolveBrokerWebTerminal", () => {
  test("MetaQuotes' own servers need no look and touch no table", async () => {
    const world = icMarketsWorld();
    const info = await resolveWith(world, { server: "MetaQuotes-Demo" });
    expect(info).toMatchObject({ status: "NOT_NEEDED", url: null, host: null });
    expect(world.lookups).toBe(0);
    expect(fakeDb.calls).toHaveLength(0);
  });

  test("a server name without a key is simply not found", async () => {
    const world = icMarketsWorld();
    const info = await resolveWith(world, { server: "x" });
    expect(info).toMatchObject({ status: "NOT_FOUND", serverKey: null, url: null });
    expect(world.lookups).toBe(0);
    expect(fakeDb.calls).toHaveLength(0);
  });

  test("a finding is returned, written to the table and then served without another look", async () => {
    const world = icMarketsWorld();
    const first = await resolveWith(world);

    expect(first).toMatchObject({
      serverKey: "icmarketssc",
      status: "FOUND",
      url: TERMINAL_URL,
      host: "webtrader.icmarkets.com",
      source: "DISCOVERED",
      embeddable: true,
      brokerName: "IC Markets",
    });
    expect(first.checkedAt).toBe(new Date(START).toISOString());
    expect(rows()).toEqual([
      expect.objectContaining({
        server_key: "icmarketssc:mt5",
        url: TERMINAL_URL,
        source: "DISCOVERED",
        embeddable: true,
        broker_name: "IC Markets",
      }),
    ]);
    expect(fakeDb.callsTo("broker_web_terminals", "upsert")[0].conflictColumn).toBe("server_key");

    const fetchedBefore = world.fetched.length;
    world.clock += 3 * DAY;
    const second = await resolveWith(world);
    expect(second).toEqual(first);
    expect(world.fetched).toHaveLength(fetchedBefore);
    expect(world.lookups).toBe(1);
  });

  test("another instance, with an empty memory, uses what the table remembers", async () => {
    const world = icMarketsWorld();
    await resolveWith(world);
    resetBrokerWebTerminalState();

    const info = await resolveWith(world);
    expect(info).toMatchObject({ status: "FOUND", url: TERMINAL_URL });
    expect(world.lookups).toBe(1);
  });

  test("a finding is looked at again after two weeks", async () => {
    const world = icMarketsWorld();
    await resolveWith(world);
    world.clock += 13 * DAY;
    await resolveWith(world);
    expect(world.lookups).toBe(1);
    world.clock += 2 * DAY;
    await resolveWith(world);
    expect(world.lookups).toBe(2);
  });

  test("MT4 and MT5 of one broker are two separate findings", async () => {
    const world = icMarketsWorld();
    world.resolvable.add("mt4.icmarkets.com");
    world.pages.set("https://mt4.icmarkets.com/", { text: terminalHtml(4) });

    const mt5 = await resolveWith(world);
    const mt4 = await resolveWith(world, { platform: "MT4" });

    expect(mt5.url).toBe(TERMINAL_URL);
    expect(mt4.url).toBe("https://mt4.icmarkets.com/");
    expect(rows().map((row) => row.server_key).sort()).toEqual(["icmarketssc:mt4", "icmarketssc:mt5"]);
  });

  test("'nothing found' is remembered for six hours, not for ever", async () => {
    const world = new World();
    world.company = { name: "IC Markets", website: "https://www.icmarkets.com/" };

    const first = await resolveWith(world);
    expect(first).toMatchObject({ status: "NOT_FOUND", url: null, host: null, source: null });
    expect(rows()).toEqual([expect.objectContaining({ server_key: "icmarketssc:mt5", url: null, source: "DISCOVERED" })]);

    world.clock += 5 * HOUR;
    await resolveWith(world);
    expect(world.lookups).toBe(1);

    world.clock += 2 * HOUR;
    await resolveWith(world);
    expect(world.lookups).toBe(2);
  });

  test("a look that ran out of time is UNAVAILABLE, is not stored and is retried after two minutes", async () => {
    const world = icMarketsWorld();
    world.directoryDelay = 9_000; // the directory answers after the 8 s budget

    const first = await resolveWith(world);
    expect(first).toMatchObject({ status: "UNAVAILABLE", url: null });
    expect(rows()).toEqual([]);

    world.directoryDelay = 0;
    world.clock += MINUTE;
    expect((await resolveWith(world)).status).toBe("UNAVAILABLE");
    expect(world.lookups).toBe(1);

    world.clock += 2 * MINUTE;
    const later = await resolveWith(world);
    expect(later).toMatchObject({ status: "FOUND", url: TERMINAL_URL });
    expect(world.lookups).toBe(2);
    expect(rows()).toHaveLength(1);
  });

  test("a crash inside the look is UNAVAILABLE, never an error, and is not stored", async () => {
    const world = icMarketsWorld();
    world.crash = true;
    const info = await resolveWith(world);
    expect(info).toMatchObject({ status: "UNAVAILABLE", url: null });
    expect(rows()).toEqual([]);
  });

  test("a failed look never wipes out an address found earlier, and the broker's site gets a rest", async () => {
    const world = icMarketsWorld();
    const found = await resolveWith(world);
    expect(found.status).toBe("FOUND");

    world.clock += 20 * DAY; // the finding is stale now
    world.crash = true;
    const during = await resolveWith(world);
    expect(during).toMatchObject({ status: "FOUND", url: TERMINAL_URL });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].checked_at).toBe(new Date(START).toISOString());
    expect(world.lookups).toBe(2);

    // the next requests do not start another look at once ...
    world.clock += MINUTE;
    expect((await resolveWith(world)).status).toBe("FOUND");
    expect(world.lookups).toBe(2);

    // ... but after two minutes the broker is looked at again, and the answer is stored
    world.crash = false;
    world.clock += 2 * MINUTE;
    const recovered = await resolveWith(world);
    expect(recovered.status).toBe("FOUND");
    expect(world.lookups).toBe(3);
    expect(rows()[0].checked_at).toBe(new Date(world.clock).toISOString());
  });

  test("a refresh looks again at once - a few times per hour and user", async () => {
    const world = new World();
    world.company = { name: "IC Markets", website: "https://www.icmarkets.com/" };
    expect((await resolveWith(world)).status).toBe("NOT_FOUND");

    // the broker has put its terminal online since
    world.resolvable.add("webtrader.icmarkets.com");
    world.pages.set(TERMINAL_URL, { text: terminalHtml(5) });
    expect((await resolveWith(world)).status).toBe("NOT_FOUND"); // the earlier answer stands
    expect(world.lookups).toBe(1);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const info = await resolveWith(world, { refresh: true });
      expect(info.status).toBe("FOUND");
      expect(world.lookups).toBe(1 + attempt);
    }
    // the sixth refresh within the hour is answered from what is known
    await resolveWith(world, { refresh: true });
    expect(world.lookups).toBe(6);

    // somebody else is not affected by it, and the hour passes
    await resolveWith(world, { refresh: true, userId: OTHER_USER });
    expect(world.lookups).toBe(7);
    world.clock += 61 * MINUTE;
    await resolveWith(world, { refresh: true });
    expect(world.lookups).toBe(8);
  });

  describe("an administrator's override", () => {
    const OVERRIDE = "https://trade.icmarkets-clients.com/mt5";
    const old = () => new Date(START - 400 * DAY).toISOString();

    test("wins, is never looked up again - not even on a refresh - and is never overwritten", async () => {
      fakeDb.tables.broker_web_terminals = [
        { server_key: "icmarketssc:mt5", broker_name: "IC Markets", url: OVERRIDE, source: "ADMIN", embeddable: false, checked_at: old() },
      ];
      const world = icMarketsWorld();

      const info = await resolveWith(world);
      expect(info).toMatchObject({ status: "FOUND", url: OVERRIDE, host: "trade.icmarkets-clients.com", source: "ADMIN", embeddable: false });
      await resolveWith(world, { refresh: true });

      expect(world.lookups).toBe(0);
      expect(fakeDb.callsTo("broker_web_terminals", "upsert")).toHaveLength(0);
    });

    test("with no address it switches the automatic search off for that broker", async () => {
      fakeDb.tables.broker_web_terminals = [
        { server_key: "icmarketssc:mt5", broker_name: null, url: null, source: "ADMIN", embeddable: true, checked_at: old() },
      ];
      const world = icMarketsWorld();

      const info = await resolveWith(world);
      expect(info).toMatchObject({ status: "BLOCKED", url: null });
      expect(world.lookups).toBe(0);
    });

    test("removing it takes effect at once (it is never kept in memory)", async () => {
      fakeDb.tables.broker_web_terminals = [
        { server_key: "icmarketssc:mt5", broker_name: "IC Markets", url: OVERRIDE, source: "ADMIN", embeddable: true, checked_at: old() },
      ];
      const world = icMarketsWorld();
      expect((await resolveWith(world)).url).toBe(OVERRIDE);

      fakeDb.tables.broker_web_terminals = [];
      const after = await resolveWith(world);
      expect(after).toMatchObject({ status: "FOUND", url: TERMINAL_URL, source: "DISCOVERED" });
      expect(world.lookups).toBe(1);
    });
  });

  test("an address in the table that is not a safe https address is never served", async () => {
    fakeDb.tables.broker_web_terminals = [
      {
        server_key: "icmarketssc:mt5",
        broker_name: "IC Markets",
        url: "http://webtrader.icmarkets.com/",
        source: "DISCOVERED",
        embeddable: true,
        checked_at: new Date(START).toISOString(),
      },
    ];
    const info = await resolveWith(icMarketsWorld());
    expect(info).toMatchObject({ status: "NOT_FOUND", url: null });
  });

  describe("a database that is not ready", () => {
    test("a missing table is remembered for ten minutes; the process memory keeps the finding", async () => {
      fakeDb.selectErrors.broker_web_terminals = {
        code: "42P01",
        message: 'relation "broker_web_terminals" does not exist',
      };
      const world = icMarketsWorld();

      const first = await resolveWith(world);
      expect(first).toMatchObject({ status: "FOUND", url: TERMINAL_URL });
      expect(fakeDb.callsTo("broker_web_terminals")).toHaveLength(1);
      expect(fakeDb.callsTo("broker_web_terminals", "upsert")).toHaveLength(0);

      world.clock += MINUTE;
      expect(await resolveWith(world)).toEqual(first);
      expect(world.lookups).toBe(1);
      expect(fakeDb.callsTo("broker_web_terminals")).toHaveLength(1); // not asked again

      world.clock += 10 * MINUTE;
      await resolveWith(world);
      expect(fakeDb.callsTo("broker_web_terminals")).toHaveLength(2);
      expect(world.lookups).toBe(1);
    });

    test("any other database error is tolerated as well", async () => {
      fakeDb.selectErrors.broker_web_terminals = { message: "connection timed out" };
      fakeDb.upsertErrors.broker_web_terminals = { message: "connection timed out" };
      const world = icMarketsWorld();

      const first = await resolveWith(world);
      expect(first).toMatchObject({ status: "FOUND", url: TERMINAL_URL });
      expect(await resolveWith(world)).toEqual(first);
      expect(world.lookups).toBe(1);
    });
  });

  describe("load", () => {
    test("two people asking about the same broker at once start one look", async () => {
      const world = icMarketsWorld();
      let release!: () => void;
      world.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const a = resolveWith(world, { userId: USER });
      const b = resolveWith(world, { userId: OTHER_USER });
      await flush();
      release();
      const [first, second] = await Promise.all([a, b]);

      expect(world.lookups).toBe(1);
      expect(first.status).toBe("FOUND");
      expect(second).toEqual(first);
    });

    test("only a few looks run at once; the next one is told to try again, and is not remembered as a failure", async () => {
      const world = new World(); // nothing is found anywhere
      let release!: () => void;
      world.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const running = ["aaa-Live", "bbb-Live", "ccc-Live", "ddd-Live"].map((server) =>
        resolveWith(world, { server, brokerName: null }),
      );
      await flush();
      expect(world.lookups).toBe(4);

      const refused = await resolveWith(world, { server: "eee-Live", brokerName: null });
      expect(refused).toMatchObject({ status: "UNAVAILABLE", url: null });
      expect(world.lookups).toBe(4);

      release();
      await Promise.all(running);

      const later = await resolveWith(world, { server: "eee-Live", brokerName: null });
      expect(later.status).toBe("NOT_FOUND");
      expect(world.lookups).toBe(5);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the broker directory (API2Trade Search)", () => {
  function directory(answer: (company: string) => unknown) {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const company = new URL(String(input)).searchParams.get("company") ?? "";
      return { ok: true, status: 200, text: async () => JSON.stringify(answer(company)) };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    vi.stubEnv("API2TRADE_BASE_URL", "https://mt5.mt4api.dev");
    vi.stubEnv("API2TRADE_USERNAME", "directory-user");
    vi.stubEnv("API2TRADE_PASSWORD", "directory-pass");
  });

  test("the company that lists the very server is the owner - its name and website are used", async () => {
    const fetchMock = directory(() => [
      { companyName: "Other Broker", website: "https://www.other.example.org", results: [{ name: "Other-Demo" }] },
      {
        companyName: "Raw Trading Ltd",
        website: "https://www.icmarkets.com/",
        results: [{ name: "ICMarketsSC-Demo" }, { name: "ICMarketsSC-Live01" }],
      },
    ]);

    const company = await realDiscoveryDeps.lookupCompany("ICMarketsSC-Demo", "IC Markets");

    expect(company).toEqual({ name: "Raw Trading Ltd", website: "https://www.icmarkets.com/" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/Search");
    expect(url.searchParams.get("company")).toBe("IC Markets");
  });

  test("a server that is not listed any more still finds the company whose website carries the brand", async () => {
    directory(() => [
      { companyName: "Unrelated", website: "https://evil.example.net", results: [{ name: "Evil-Demo" }] },
      { companyName: "IC Markets", website: "https://www.icmarkets.com", results: [{ name: "ICMarketsSC-Live01" }] },
    ]);

    const company = await realDiscoveryDeps.lookupCompany("ICMarketsSC-Live99", "IC Markets");

    expect(company).toEqual({ name: "IC Markets", website: "https://www.icmarkets.com" });
  });

  test("nothing matches: no company", async () => {
    directory(() => [{ companyName: "Unrelated", website: "https://evil.example.net", results: [{ name: "Evil-Demo" }] }]);
    expect(await realDiscoveryDeps.lookupCompany("ICMarketsSC-Live99", "IC Markets")).toBeNull();
  });

  test("a directory that fails gives no company instead of an error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await realDiscoveryDeps.lookupCompany("ICMarketsSC-Live99", "IC Markets")).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });

  test("without a broker connection configured the directory is not asked", async () => {
    vi.stubEnv("API2TRADE_BASE_URL", "");
    vi.stubEnv("API2TRADE_USERNAME", "");
    vi.stubEnv("API2TRADE_PASSWORD", "");
    const fetchMock = directory(() => []);
    expect(await realDiscoveryDeps.lookupCompany("ICMarketsSC-Demo", "IC Markets")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
