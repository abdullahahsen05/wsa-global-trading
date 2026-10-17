import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CLASSIC_TERMINAL_URL,
  MODERN_TERMINAL_URL,
  buildMetaTraderUrl,
  createManualAccountId,
  inferPlatformFromServer,
  isMetaQuotesServer,
  isMetaTraderPlatform,
  isMetaTraderSource,
  maskLogin,
  normalizePlatform,
  parseManualAccountInput,
  resolveTerminalPlatform,
  sanitizeLabel,
  sanitizeLogin,
  sanitizeServer,
  validateCustomTerminalUrl,
} from "@/lib/terminal/metatrader";
import { sanitizeWorkspace } from "@/lib/terminal/workspace";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platform and source guards", () => {
  test("only MT4 / MT5 are platforms", () => {
    expect(isMetaTraderPlatform("MT4")).toBe(true);
    expect(isMetaTraderPlatform("MT5")).toBe(true);
    expect(isMetaTraderPlatform("mt5")).toBe(false);
    expect(isMetaTraderPlatform(5)).toBe(false);
    expect(isMetaTraderPlatform(null)).toBe(false);
  });

  test("normalizePlatform accepts any casing and spacing", () => {
    expect(normalizePlatform("mt5")).toBe("MT5");
    expect(normalizePlatform(" Mt4 ")).toBe("MT4");
    expect(normalizePlatform("MT6")).toBeNull();
    expect(normalizePlatform("")).toBeNull();
    expect(normalizePlatform(5)).toBeNull();
  });

  test("terminal sources", () => {
    expect(isMetaTraderSource("auto")).toBe(true);
    expect(isMetaTraderSource("classic")).toBe(true);
    expect(isMetaTraderSource("modern")).toBe(true);
    expect(isMetaTraderSource("custom")).toBe(true);
    expect(isMetaTraderSource("proxy")).toBe(false);
    expect(isMetaTraderSource(undefined)).toBe(false);
  });
});

describe("platform recognition", () => {
  test("MetaQuotes' own servers are recognised", () => {
    expect(isMetaQuotesServer("MetaQuotes-Demo")).toBe(true);
    expect(isMetaQuotesServer(" metaquotes-demo2 ")).toBe(true);
    expect(isMetaQuotesServer("ICMarketsSC-Live")).toBe(false);
    expect(isMetaQuotesServer(null)).toBe(false);
  });

  test("an MT4 / MT5 marker in a broker server name tells the platform", () => {
    expect(inferPlatformFromServer("Exness-MT5Real10")).toBe("MT5");
    expect(inferPlatformFromServer("ICMarketsSC-MT5-2")).toBe("MT5");
    expect(inferPlatformFromServer("XM.COM-MT4 3")).toBe("MT4");
    expect(inferPlatformFromServer("mt4-live")).toBe("MT4");
  });

  test("a name without a clear marker says nothing (and is never guessed)", () => {
    expect(inferPlatformFromServer("Pepperstone-Demo")).toBeNull();
    expect(inferPlatformFromServer("MetaQuotes-Demo")).toBeNull();
    expect(inferPlatformFromServer("AMT5Live")).toBeNull();
    expect(inferPlatformFromServer("Broker-MT50")).toBeNull();
    expect(inferPlatformFromServer("")).toBeNull();
    expect(inferPlatformFromServer(null)).toBeNull();
    expect(inferPlatformFromServer(5)).toBeNull();
  });

  test("the platform stored with the account wins, the server name is only the fallback", () => {
    expect(resolveTerminalPlatform("MT4", "Exness-MT5Real10")).toBe("MT4");
    expect(resolveTerminalPlatform(" mt5 ", null)).toBe("MT5");
    expect(resolveTerminalPlatform(null, "Exness-MT5Real10")).toBe("MT5");
    expect(resolveTerminalPlatform("unknown", "XM.COM-MT4 3")).toBe("MT4");
    expect(resolveTerminalPlatform(undefined, "Pepperstone-Demo")).toBeNull();
  });
});

describe("sanitizeLogin", () => {
  test("accepts digits, trims, and takes safe integers", () => {
    expect(sanitizeLogin("12345678")).toBe("12345678");
    expect(sanitizeLogin("  87654321 ")).toBe("87654321");
    expect(sanitizeLogin(4242)).toBe("4242");
  });

  test.each([
    ["letters", "12ab"],
    ["spaces inside", "12 34"],
    ["empty", ""],
    ["too long", "1234567890123"],
    ["sign", "-5"],
    ["decimal", "1.5"],
    ["markup", "<1>"],
  ])("rejects %s", (_name, value) => {
    expect(sanitizeLogin(value)).toBeNull();
  });

  test("rejects zero, negatives, fractions and unsafe numbers", () => {
    expect(sanitizeLogin(0)).toBeNull();
    expect(sanitizeLogin(-3)).toBeNull();
    expect(sanitizeLogin(1.5)).toBeNull();
    expect(sanitizeLogin(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(sanitizeLogin(null)).toBeNull();
    expect(sanitizeLogin({})).toBeNull();
  });
});

describe("sanitizeServer", () => {
  test.each(["ICMarketsSC-Demo", "FTMO-Server3", "XM.COM-MT5 3", "Broker (Live)", "Pepperstone-Demo_2"])(
    "accepts %s",
    (name) => {
      expect(sanitizeServer(name)).toBe(name);
    },
  );

  test("collapses runs of spaces and trims", () => {
    expect(sanitizeServer("  Broker   Live  ")).toBe("Broker Live");
  });

  test.each([
    ["one character", "A"],
    ["leading dash", "-Server"],
    ["markup", "<script>alert(1)</script>"],
    ["semicolon", "Server;drop"],
    ["slash", "a/b"],
    ["quote", 'Ser"ver'],
    ["too long", "A".repeat(65)],
  ])("rejects %s", (_name, value) => {
    expect(sanitizeServer(value)).toBeNull();
  });

  test("rejects non-strings", () => {
    expect(sanitizeServer(12)).toBeNull();
    expect(sanitizeServer(null)).toBeNull();
  });
});

describe("sanitizeLabel", () => {
  test("drops angle brackets and control characters and collapses spaces", () => {
    expect(sanitizeLabel("  <b>My</b>\u0000  acc\n ", "x")).toBe("bMy/b acc");
  });

  test("is capped at 40 characters", () => {
    expect(sanitizeLabel("a".repeat(100), "x")).toHaveLength(40);
  });

  test("falls back when nothing is left", () => {
    expect(sanitizeLabel("<>", "fallback")).toBe("fallback");
    expect(sanitizeLabel("   ", "fallback")).toBe("fallback");
    expect(sanitizeLabel(42, "fallback")).toBe("fallback");
  });

  test("is idempotent", () => {
    for (const sample of ["  a  b ", "<x>y", `${"w ".repeat(30)}z`, "tail  ", "\u0007bell"]) {
      const once = sanitizeLabel(sample, "f");
      expect(sanitizeLabel(once, "f")).toBe(once);
    }
  });
});

describe("maskLogin", () => {
  test("shows at most the last four digits", () => {
    expect(maskLogin("12345678")).toBe("••••5678");
    expect(maskLogin("987654321012")).toBe("••••1012");
  });

  test("never reveals more than half of a short login", () => {
    expect(maskLogin("1234")).toBe("••••34");
    expect(maskLogin("12")).toBe("••••2");
    expect(maskLogin("1")).toBe("••••");
    expect(maskLogin("")).toBe("••••");
  });
});

describe("parseManualAccountInput", () => {
  test("accepts a complete form and derives a label", () => {
    const result = parseManualAccountInput({ platform: "mt5", login: " 12345678 ", server: "ICMarketsSC-Demo" });
    expect(result).toEqual({
      ok: true,
      value: { label: "MT5 ••••5678", platform: "MT5", login: "12345678", server: "ICMarketsSC-Demo" },
    });
  });

  test("keeps a sanitised label", () => {
    const result = parseManualAccountInput({
      label: "  Challenge <100k>  ",
      platform: "MT4",
      login: "1001",
      server: "FTMO-Server",
    });
    expect(result.ok && result.value.label).toBe("Challenge 100k");
  });

  test("points at the first invalid field", () => {
    expect(parseManualAccountInput({ platform: "x", login: "1", server: "Srv-1" })).toMatchObject({
      ok: false,
      field: "platform",
    });
    expect(parseManualAccountInput({ platform: "MT5", login: "abc", server: "Srv-1" })).toMatchObject({
      ok: false,
      field: "login",
    });
    expect(parseManualAccountInput({ platform: "MT5", login: "1234", server: "!!" })).toMatchObject({
      ok: false,
      field: "server",
    });
  });

  test("never carries a password", () => {
    const result = parseManualAccountInput({
      platform: "MT5",
      login: "1234",
      server: "Srv-1",
      password: "hunter2",
    } as Parameters<typeof parseManualAccountInput>[0]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    if (result.ok) expect(Object.keys(result.value).sort()).toEqual(["label", "login", "platform", "server"]);
  });
});

describe("createManualAccountId", () => {
  test("produces ids the workspace accepts, and they differ", () => {
    const ids = new Set(Array.from({ length: 200 }, () => createManualAccountId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{6,64}$/);

    const kept = sanitizeWorkspace({
      metatrader: {
        manualAccounts: [{ id: [...ids][0], label: "a", platform: "MT5", login: "123456", server: "Srv-1" }],
      },
    });
    expect(kept.metatrader.manualAccounts).toHaveLength(1);
  });

  test("still works without crypto.getRandomValues", () => {
    vi.stubGlobal("crypto", undefined);
    expect(createManualAccountId()).toMatch(/^m[0-9a-f]{18}$/);
  });
});

describe("validateCustomTerminalUrl", () => {
  test("accepts an https address and normalises it", () => {
    const result = validateCustomTerminalUrl("  https://webtrader.example-broker.com/terminal?lang=en ");
    expect(result).toEqual({ ok: true, url: "https://webtrader.example-broker.com/terminal?lang=en" });
  });

  test.each([
    ["http", "http://webtrader.example-broker.com/"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>1</script>"],
    ["ftp", "ftp://files.example.com/"],
    ["credentials", "https://user:pass@webtrader.example-broker.com/"],
    ["user only", "https://user@webtrader.example-broker.com/"],
    ["localhost", "https://localhost:3000/"],
    ["localhost subdomain", "https://app.localhost/"],
    [".local", "https://printer.local/"],
    [".internal", "https://svc.internal/"],
    ["ipv4", "https://203.0.113.9/"],
    ["ipv6", "https://[2001:db8::1]/"],
    ["single label", "https://intranet/"],
    ["not a url", "webtrader"],
  ])("rejects %s", (_name, value) => {
    expect(validateCustomTerminalUrl(value).ok).toBe(false);
  });

  test("rejects empty, non-string and over-long values", () => {
    expect(validateCustomTerminalUrl("").ok).toBe(false);
    expect(validateCustomTerminalUrl("   ").ok).toBe(false);
    expect(validateCustomTerminalUrl(undefined).ok).toBe(false);
    expect(validateCustomTerminalUrl(`https://a.example.com/${"x".repeat(500)}`).ok).toBe(false);
  });

  test("never points back to this site", () => {
    expect(validateCustomTerminalUrl("https://app.wsa.test/terminal", "https://app.wsa.test").ok).toBe(false);
    expect(validateCustomTerminalUrl("https://other.example.com/", "https://app.wsa.test").ok).toBe(true);
  });
});

describe("buildMetaTraderUrl", () => {
  test("classic terminal: the account's own server and platform, login and language", () => {
    const result = buildMetaTraderUrl({
      source: "classic",
      platform: "MT5",
      login: "12345678",
      server: "ICMarketsSC-Demo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(`${url.origin}${url.pathname}`).toBe(CLASSIC_TERMINAL_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      servers: "ICMarketsSC-Demo",
      trade_server: "ICMarketsSC-Demo",
      login: "12345678",
      startup_version: "5",
      startup_mode: "no_autologin",
      lang: "en",
    });
    // neither the undocumented `version` nor the "offer every broker" switch
    expect(url.searchParams.has("version")).toBe(false);
    expect(url.searchParams.has("demo_all_servers")).toBe(false);
    expect(result.host).toBe("metatraderweb.app");
    expect(result.prefilled).toBe(true);
    expect(result.serverNotPreselected).toBe(false);
  });

  test("classic terminal: MT4 asks for version 4", () => {
    const result = buildMetaTraderUrl({ source: "classic", platform: "MT4", login: "1001", server: "Srv-1" });
    expect(result.ok && new URL(result.url).searchParams.get("startup_version")).toBe("4");
  });

  test("classic terminal: it does not reconnect to the account used last unless asked to", () => {
    const safe = buildMetaTraderUrl({ source: "classic", platform: "MT5", login: "1001", server: "Srv-1" });
    expect(safe.ok && new URL(safe.url).searchParams.get("startup_mode")).toBe("no_autologin");
    const auto = buildMetaTraderUrl({ source: "classic", platform: "MT5", login: "1001", server: "Srv-1", autoLogin: true });
    expect(auto.ok && new URL(auto.url).searchParams.has("startup_mode")).toBe(false);
  });

  test("classic terminal: server names with spaces are written as %20", () => {
    const result = buildMetaTraderUrl({ source: "classic", platform: "MT5", login: "1001", server: "XM.COM-MT5 3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain("trade_server=XM.COM-MT5%203");
    expect(result.url).toContain("servers=XM.COM-MT5%203");
    expect(result.url).not.toContain("+");
    expect(new URL(result.url).searchParams.get("trade_server")).toBe("XM.COM-MT5 3");
  });

  test("classic terminal: without a server name every supported broker server is offered", () => {
    const result = buildMetaTraderUrl({ source: "classic", platform: "MT5", login: "1001" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const params = new URL(result.url).searchParams;
    expect(params.get("demo_all_servers")).toBe("1");
    expect(params.has("servers")).toBe(false);
    expect(params.has("trade_server")).toBe(false);
    expect(result.serverNotPreselected).toBe(true);
  });

  test("without a login nothing is pre-filled", () => {
    const result = buildMetaTraderUrl({ source: "classic", platform: "MT5" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prefilled).toBe(false);
    expect(new URL(result.url).searchParams.has("login")).toBe(false);
    expect(new URL(result.url).searchParams.has("trade_server")).toBe(false);
  });

  test("an invalid login or server is left out instead of being put in the address", () => {
    const result = buildMetaTraderUrl({
      source: "classic",
      platform: "MT5",
      login: "12;rm",
      server: "<script>",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const params = new URL(result.url).searchParams;
    expect(params.has("login")).toBe(false);
    expect(params.has("trade_server")).toBe(false);
    expect(params.has("servers")).toBe(false);
    expect(result.url).not.toContain("script");
  });

  test("language: two lowercase letters or English", () => {
    const german = buildMetaTraderUrl({ source: "classic", platform: "MT5", lang: "de" });
    const odd = buildMetaTraderUrl({ source: "classic", platform: "MT5", lang: "english" });
    expect(german.ok && new URL(german.url).searchParams.get("lang")).toBe("de");
    expect(odd.ok && new URL(odd.url).searchParams.get("lang")).toBe("en");
  });

  test("new terminal: MT5 only, login and dark mode; MetaQuotes' own server is all it offers", () => {
    const result = buildMetaTraderUrl({
      source: "modern",
      platform: "MT5",
      login: "5001",
      server: "MetaQuotes-Demo",
      dark: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(`${url.origin}${url.pathname}`).toBe(MODERN_TERMINAL_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({ login: "5001", lang: "en", "theme-mode": "1" });
    expect(result.serverNotPreselected).toBe(false);
    expect(result.prefilled).toBe(true);

    const light = buildMetaTraderUrl({ source: "modern", platform: "MT5", login: "5001" });
    expect(light.ok && new URL(light.url).searchParams.has("theme-mode")).toBe(false);
  });

  test("new terminal refuses MT4 accounts and broker servers, and points to the classic terminal", () => {
    const mt4 = buildMetaTraderUrl({ source: "modern", platform: "MT4", login: "5001" });
    expect(mt4).toMatchObject({ ok: false, switchTo: "classic" });
    expect(!mt4.ok && mt4.reason).toMatch(/MetaTrader 5/);

    const broker = buildMetaTraderUrl({ source: "modern", platform: "MT5", login: "5001", server: "ICMarketsSC-Live" });
    expect(broker).toMatchObject({ ok: false, switchTo: "classic" });
    expect(!broker.ok && broker.reason).toContain("ICMarketsSC-Live");

    // an account without a stored server can still be opened (the user picks it there)
    expect(buildMetaTraderUrl({ source: "modern", platform: "MT5", login: "5001" }).ok).toBe(true);
  });

  test("custom terminal: validated address plus login, server and platform, existing query kept", () => {
    const result = buildMetaTraderUrl({
      source: "custom",
      customUrl: "https://webtrader.example-broker.com/web?brand=x",
      platform: "MT5",
      login: "777",
      server: "Example-Live",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(url.host).toBe("webtrader.example-broker.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      brand: "x",
      login: "777",
      trade_server: "Example-Live",
      startup_version: "5",
      startup_mode: "no_autologin",
    });

    const auto = buildMetaTraderUrl({
      source: "custom",
      customUrl: "https://webtrader.example-broker.com/web",
      platform: "MT4",
      login: "777",
      autoLogin: true,
    });
    expect(auto.ok).toBe(true);
    if (!auto.ok) return;
    expect(Object.fromEntries(new URL(auto.url).searchParams)).toEqual({ login: "777", startup_version: "4" });
  });

  test("custom terminal: no address, an unsafe address, or this very site -> error", () => {
    expect(buildMetaTraderUrl({ source: "custom", platform: "MT5" }).ok).toBe(false);
    expect(buildMetaTraderUrl({ source: "custom", customUrl: "http://x.example.com", platform: "MT5" }).ok).toBe(false);
    expect(
      buildMetaTraderUrl({
        source: "custom",
        customUrl: "https://app.wsa.test/x",
        platform: "MT5",
        ownOrigin: "https://app.wsa.test",
      }).ok,
    ).toBe(false);
  });

  test("no address ever contains a password parameter", () => {
    for (const source of ["auto", "classic", "modern", "custom"] as const) {
      const result = buildMetaTraderUrl({
        source,
        customUrl: "https://webtrader.example-broker.com/",
        brokerTerminalUrl: "https://webtrader.example-broker.com/",
        platform: "MT5",
        login: "1234",
        server: source === "modern" ? "MetaQuotes-Demo" : "Srv-1",
        dark: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.url.toLowerCase()).not.toMatch(/pass|pwd|secret|token/);
    }
  });
});

describe("buildMetaTraderUrl - automatic source", () => {
  const OWN = "https://app.wsa.test";

  test("the broker's own terminal gets the login, the server and the platform", () => {
    const result = buildMetaTraderUrl({
      source: "auto",
      platform: "MT5",
      login: "12345678",
      server: "ICMarketsSC-Demo",
      brokerTerminalUrl: "https://webtrader.icmarkets.com/",
      ownOrigin: OWN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(url.host).toBe("webtrader.icmarkets.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      login: "12345678",
      trade_server: "ICMarketsSC-Demo",
      startup_version: "5",
      startup_mode: "no_autologin",
    });
    expect(result.kind).toBe("broker");
    expect(result.prefilled).toBe(true);
    expect(result.host).toBe("webtrader.icmarkets.com");
  });

  test("an address the broker already uses with parameters keeps them", () => {
    const result = buildMetaTraderUrl({
      source: "auto",
      platform: "MT4",
      login: "1001",
      server: "Srv-Live",
      brokerTerminalUrl: "https://mt4.example-broker.com/terminal?brand=x",
      autoLogin: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.fromEntries(new URL(result.url).searchParams)).toEqual({
      brand: "x",
      login: "1001",
      trade_server: "Srv-Live",
      startup_version: "4",
    });
  });

  test("the broker's terminal wins over MetaQuotes' shared one, also for MT4", () => {
    const result = buildMetaTraderUrl({
      source: "auto",
      platform: "MT4",
      login: "1001",
      server: "Pepperstone-Live",
      brokerTerminalUrl: "https://webtrader.pepperstone.com/",
    });
    expect(result.ok && result.host).toBe("webtrader.pepperstone.com");
    expect(result.ok && result.kind).toBe("broker");
  });

  test("MT5 without a known broker terminal: no MetaQuotes fallback, the reason says what is missing", () => {
    const result = buildMetaTraderUrl({ source: "auto", platform: "MT5", login: "1001", server: "ICMarketsSC-Demo" });
    expect(result).toMatchObject({ ok: false, needsBrokerTerminal: true });
    expect(!result.ok && result.reason).toMatch(/MetaTrader 5 web terminal/);
    // it is not sent to MetaQuotes' demo-only terminal
    expect(!result.ok && result.switchTo).toBeUndefined();
  });

  test("MT4 without a known broker terminal opens MetaQuotes' shared MT4 terminal on the account's own server", () => {
    const result = buildMetaTraderUrl({ source: "auto", platform: "MT4", login: "1001", server: "Alpari-Demo" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(`${url.origin}${url.pathname}`).toBe(CLASSIC_TERMINAL_URL);
    expect(url.searchParams.get("trade_server")).toBe("Alpari-Demo");
    expect(url.searchParams.get("startup_version")).toBe("4");
    expect(url.searchParams.get("startup_mode")).toBe("no_autologin");
    expect(result.kind).toBe("metaquotes");
  });

  test("MetaQuotes' own servers open MetaQuotes' own terminals", () => {
    const mt5 = buildMetaTraderUrl({ source: "auto", platform: "MT5", login: "5001", server: "MetaQuotes-Demo" });
    expect(mt5.ok && new URL(mt5.url).host).toBe("web.metatrader.app");
    const mt4 = buildMetaTraderUrl({ source: "auto", platform: "MT4", login: "5001", server: "MetaQuotes-Demo" });
    expect(mt4.ok && new URL(mt4.url).host).toBe("metatraderweb.app");
  });

  test.each([
    ["http://webtrader.icmarkets.com/"],
    ["https://127.0.0.1/terminal"],
    ["https://localhost/"],
    ["https://user:pw@webtrader.icmarkets.com/"],
    ["https://app.wsa.test/terminal"],
    ["javascript:alert(1)"],
    ["not a url"],
  ])("an unusable terminal address (%s) is ignored, never opened", (address) => {
    const mt5 = buildMetaTraderUrl({
      source: "auto",
      platform: "MT5",
      login: "1001",
      server: "ICMarketsSC-Demo",
      brokerTerminalUrl: address,
      ownOrigin: OWN,
    });
    expect(mt5).toMatchObject({ ok: false, needsBrokerTerminal: true });
    // MT4 falls back to the shared terminal instead of the unusable address
    const mt4 = buildMetaTraderUrl({
      source: "auto",
      platform: "MT4",
      login: "1001",
      server: "ICMarketsSC-Demo",
      brokerTerminalUrl: address,
      ownOrigin: OWN,
    });
    expect(mt4.ok && new URL(mt4.url).host).toBe("metatraderweb.app");
  });

  test("without a login the form simply opens empty", () => {
    const result = buildMetaTraderUrl({
      source: "auto",
      platform: "MT5",
      server: "ICMarketsSC-Demo",
      brokerTerminalUrl: "https://webtrader.icmarkets.com/",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prefilled).toBe(false);
    expect(new URL(result.url).searchParams.has("login")).toBe(false);
  });

  test("an invalid login or server is left out of the address", () => {
    const result = buildMetaTraderUrl({
      source: "auto",
      platform: "MT5",
      login: "12;rm -rf",
      server: "<script>",
      brokerTerminalUrl: "https://webtrader.icmarkets.com/",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const params = new URL(result.url).searchParams;
    expect(params.has("login")).toBe(false);
    expect(params.has("trade_server")).toBe(false);
    expect(result.url).not.toContain("script");
  });
});
