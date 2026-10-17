import { describe, expect, test } from "vitest";
import {
  MIN_TERMINAL_SCORE,
  analyzeTerminalPage,
  brandTokens,
  brokerTerminalKey,
  cleanTerminalUrl,
  domainMatchesBrand,
  domainOfUrl,
  extractTerminalLinks,
  frameAllowed,
  guessedBrokerDomains,
  isBrokerTerminalKey,
  isDedicatedTerminalHost,
  isPublicIp,
  isServerKey,
  needsBrokerTerminal,
  registrableDomain,
  scoreTerminalCandidate,
  serverKeyOf,
  terminalHostCandidates,
} from "@/lib/terminal/brokerTerminal";

describe("server names -> the broker's key", () => {
  test.each([
    ["ICMarketsSC-Demo", "icmarketssc"],
    ["ICMarketsSC-Live01", "icmarketssc"],
    ["Exness-MT5Real10", "exness"],
    ["XM.COM-MT5 3", "xmcom"],
    ["FTMO-Server3", "ftmo"],
    ["Pepperstone-Demo", "pepperstone"],
    ["  Alpari  Demo ", "alpari"],
  ])("%s -> %s", (server, key) => {
    expect(serverKeyOf(server)).toBe(key);
  });

  test.each([[""], ["   "], ["-"], ["A"], [42], [null], [undefined], ["<script>"], ["x"]])(
    "%j has no key",
    (server) => {
      expect(serverKeyOf(server)).toBeNull();
    },
  );

  test("the key and the platform make the storage key; MT4 and MT5 of one broker are two terminals", () => {
    expect(brokerTerminalKey("ICMarketsSC-Demo", "MT5")).toBe("icmarketssc:mt5");
    expect(brokerTerminalKey("ICMarketsSC-Demo", "MT4")).toBe("icmarketssc:mt4");
    expect(brokerTerminalKey("", "MT5")).toBeNull();
  });

  test("keys that come from outside are checked", () => {
    expect(isServerKey("icmarketssc")).toBe(true);
    expect(isServerKey("IC-Markets")).toBe(false);
    expect(isServerKey("a")).toBe(false);
    expect(isServerKey(5)).toBe(false);

    expect(isBrokerTerminalKey("icmarketssc:mt5")).toBe(true);
    expect(isBrokerTerminalKey("exness:mt4")).toBe(true);
    expect(isBrokerTerminalKey("exness:mt6")).toBe(false);
    expect(isBrokerTerminalKey("exness")).toBe(false);
    expect(isBrokerTerminalKey("EXNESS:mt5")).toBe(false);
    expect(isBrokerTerminalKey("exness:mt5:extra")).toBe(false);
    expect(isBrokerTerminalKey("../admin:mt5")).toBe(false);
    expect(isBrokerTerminalKey(null)).toBe(false);
  });

  test("MetaQuotes' own servers need no broker terminal", () => {
    expect(needsBrokerTerminal("MetaQuotes-Demo")).toBe(false);
    expect(needsBrokerTerminal("metaquotes-demo")).toBe(false);
    expect(needsBrokerTerminal("ICMarketsSC-Demo")).toBe(true);
    expect(needsBrokerTerminal("")).toBe(false);
  });
});

describe("brand names", () => {
  test("legal-entity and region suffixes are removed one by one, a brand is never cut to its first letters", () => {
    expect(brandTokens("icmarketssc")).toEqual(["icmarketssc", "icmarkets"]);
    expect(brandTokens("xmglobal")).toEqual(["xmglobal", "xm"]);
    expect(brandTokens("exness")).toEqual(["exness"]);
    expect(brandTokens("xmcom")).toEqual(["xmcom", "xm"]);
    expect(brandTokens("pepperstone")).toEqual(["pepperstone"]);
    // "ic" would match unrelated domains: "markets" is part of the name, not a suffix
    expect(brandTokens("icmarketssc")).not.toContain("ic");
    // a region code never leaves fewer than three characters
    expect(brandTokens("fxeu")).toEqual(["fxeu"]);
    expect(brandTokens("a")).toEqual([]);
  });

  test("domains are guessed from the brand, the shortest sensible name first", () => {
    expect(guessedBrokerDomains("icmarketssc")).toEqual(["icmarkets.com", "icmarketssc.com"]);
    expect(guessedBrokerDomains("xmglobal")).toEqual(["xm.com", "xmglobal.com"]);
    expect(guessedBrokerDomains("exness")).toEqual(["exness.com"]);
  });

  test("a domain has to carry the broker's name", () => {
    expect(domainMatchesBrand("icmarkets.com", "icmarketssc")).toBe(true);
    expect(domainMatchesBrand("icmarkets.com.au", "icmarketssc")).toBe(true);
    expect(domainMatchesBrand("exness.com", "exness")).toBe(true);
    expect(domainMatchesBrand("exnessgroup.com", "exness")).toBe(true);
    expect(domainMatchesBrand("xm.com", "xmglobal")).toBe(true);
    // somebody else's domain, or a look-alike without the brand
    expect(domainMatchesBrand("ic.com", "icmarketssc")).toBe(false);
    expect(domainMatchesBrand("example.com", "exness")).toBe(false);
    expect(domainMatchesBrand("evil.com", "icmarketssc")).toBe(false);
    expect(domainMatchesBrand("x.com", "xmglobal")).toBe(false);
  });
});

describe("domains", () => {
  test.each([
    ["webtrader.icmarkets.com", "icmarkets.com"],
    ["icmarkets.com", "icmarkets.com"],
    ["WWW.IcMarkets.com.", "icmarkets.com"],
    ["webtrader.icmarkets.com.au", "icmarkets.com.au"],
    ["trade.broker.co.uk", "broker.co.uk"],
    ["a.b.c.exness.com", "exness.com"],
  ])("%s -> %s", (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  test("an IP address or a single label has no registrable domain", () => {
    expect(registrableDomain("192.168.1.10")).toBeNull();
    expect(registrableDomain("10.0.0.1")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("")).toBeNull();
  });

  test("the domain of a website as the broker directory writes it", () => {
    expect(domainOfUrl("https://www.icmarkets.com/global/en")).toBe("icmarkets.com");
    expect(domainOfUrl("http://exness.com")).toBe("exness.com");
    expect(domainOfUrl("exness.com/en")).toBe("exness.com");
    expect(domainOfUrl("ftp://exness.com")).toBeNull();
    expect(domainOfUrl("")).toBeNull();
    expect(domainOfUrl("not a url at all")).toBeNull();
    expect(domainOfUrl(12)).toBeNull();
    expect(domainOfUrl("https://127.0.0.1/")).toBeNull();
  });

  test("usual host names, most likely first, per platform", () => {
    const mt5 = terminalHostCandidates("icmarkets.com", "MT5");
    expect(mt5[0]).toBe("webtrader.icmarkets.com");
    expect(mt5).toContain("mt5.icmarkets.com");
    expect(mt5).not.toContain("mt4.icmarkets.com");
    const mt4 = terminalHostCandidates("icmarkets.com", "MT4");
    expect(mt4).toContain("mt4.icmarkets.com");
    expect(mt4).not.toContain("mt5.icmarkets.com");
    // every candidate stays on the broker's domain
    for (const host of [...mt5, ...mt4]) expect(registrableDomain(host)).toBe("icmarkets.com");
  });

  test("dedicated terminal hosts", () => {
    expect(isDedicatedTerminalHost("webtrader.icmarkets.com")).toBe(true);
    expect(isDedicatedTerminalHost("mt5.exness.com")).toBe(true);
    expect(isDedicatedTerminalHost("mt5web.broker.com")).toBe(true);
    expect(isDedicatedTerminalHost("terminal.broker.com")).toBe(true);
    expect(isDedicatedTerminalHost("www.broker.com")).toBe(false);
    expect(isDedicatedTerminalHost("web.broker.com")).toBe(false);
  });
});

describe("public addresses only", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.10",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "192.0.2.1",
    "198.51.100.7",
    "203.0.113.9",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not an address",
    "999.1.1.1",
  ])("%s is not public", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  test.each(["8.8.8.8", "104.18.2.3", "172.32.0.1", "100.63.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"])(
    "%s is public",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );
});

describe("reading a page", () => {
  const terminalPage = `<html><head><title>MetaTrader 5 WebTrader | IC Markets</title></head><body>Trade with the MT5 web terminal</body></html>`;

  test("a web-terminal page announces itself in the title", () => {
    const analysis = analyzeTerminalPage(terminalPage);
    expect(analysis.strong).toBe(true);
    expect(analysis.mentions).toBe(true);
    expect(analysis.mentionsMt5).toBe(true);
    expect(analysis.mentionsMt4).toBe(false);
    expect(analysis.title).toBe("metatrader 5 webtrader | ic markets");
  });

  test("a page that never speaks of MetaTrader scores nothing", () => {
    const analysis = analyzeTerminalPage("<html><title>Welcome</title><body>Cheap domains for sale</body></html>");
    expect(analysis.mentions).toBe(false);
    expect(
      scoreTerminalCandidate({ url: "https://webtrader.example.com/", platform: "MT5", analysis, viaLink: true }),
    ).toBe(0);
  });

  test("a terminal for the other platform only is turned down", () => {
    const mt4Only = analyzeTerminalPage("<title>MetaTrader 4 WebTrader</title><p>MT4 platform</p>");
    expect(mt4Only.mentionsMt4).toBe(true);
    expect(mt4Only.mentionsMt5).toBe(false);
    expect(scoreTerminalCandidate({ url: "https://mt4.broker.com/", platform: "MT5", analysis: mt4Only, viaLink: true })).toBe(0);
    expect(
      scoreTerminalCandidate({ url: "https://mt4.broker.com/", platform: "MT4", analysis: mt4Only, viaLink: true }),
    ).toBeGreaterThanOrEqual(MIN_TERMINAL_SCORE);
  });

  test("a page for both platforms is fine for either", () => {
    const both = analyzeTerminalPage("<title>MetaTrader WebTrader</title><p>MT4 and MT5</p>");
    for (const platform of ["MT4", "MT5"] as const) {
      expect(
        scoreTerminalCandidate({ url: "https://webtrader.broker.com/", platform, analysis: both, viaLink: false }),
      ).toBeGreaterThanOrEqual(MIN_TERMINAL_SCORE);
    }
  });

  test("a dedicated host that says MetaTrader beats a generic page that only mentions it", () => {
    const strong = scoreTerminalCandidate({
      url: "https://webtrader.icmarkets.com/",
      platform: "MT5",
      analysis: analyzeTerminalPage(terminalPage),
      viaLink: false,
    });
    const weak = scoreTerminalCandidate({
      url: "https://www.icmarkets.com/about",
      platform: "MT5",
      analysis: analyzeTerminalPage("<title>About us</title><p>We offer MT5 and cTrader</p>"),
      viaLink: false,
    });
    expect(strong).toBeGreaterThanOrEqual(MIN_TERMINAL_SCORE);
    expect(weak).toBeLessThan(MIN_TERMINAL_SCORE);
    expect(strong).toBeGreaterThan(weak);
  });

  test("only the start of a huge page is read", () => {
    const html = `<title>x</title>${"a".repeat(400_000)} metatrader 5`;
    expect(analyzeTerminalPage(html).mentions).toBe(false);
  });
});

describe("links on a broker's site", () => {
  const page = `
    <a href="/platforms">Platforms</a>
    <a href="https://webtrader.icmarkets.com/?session=abc#top">Launch WebTrader</a>
    <a href="/en/mt5-web-terminal"><span>MT5</span> Web Terminal</a>
    <a href="https://evil.example.net/webtrader">WebTrader</a>
    <a href="http://webtrader.icmarkets.com/">WebTrader (http)</a>
    <a href="javascript:alert(1)">WebTrader</a>
    <a href="mailto:webtrader@icmarkets.com">WebTrader support</a>
    <a href="#webtrader">WebTrader</a>
    <a href="https://webtrader.icmarkets.com/">Launch WebTrader</a>
    <a href="https://icmarkets.com.evil.net/webtrader">WebTrader</a>`;

  test("only https links on the broker's own domain, without query or fragment, once each", () => {
    const links = extractTerminalLinks(page, "https://www.icmarkets.com/", "icmarkets.com");
    expect(links).toEqual(["https://webtrader.icmarkets.com/", "https://www.icmarkets.com/en/mt5-web-terminal"]);
  });

  test("the number of links is capped", () => {
    const many = Array.from({ length: 30 }, (_, index) => `<a href="/webtrader${index}">WebTrader ${index}</a>`).join("");
    expect(extractTerminalLinks(many, "https://www.icmarkets.com/", "icmarkets.com")).toHaveLength(8);
    expect(extractTerminalLinks(many, "https://www.icmarkets.com/", "icmarkets.com", 3)).toHaveLength(3);
  });

  test("a page without such a link gives nothing", () => {
    expect(extractTerminalLinks('<a href="/about">About</a>', "https://www.icmarkets.com/", "icmarkets.com")).toEqual([]);
    expect(extractTerminalLinks("", "https://www.icmarkets.com/", "icmarkets.com")).toEqual([]);
  });
});

describe("may the page be shown inside ours?", () => {
  const own = "https://app.wsa.test";

  test("a page without any restriction may", () => {
    expect(frameAllowed({}, own)).toBe(true);
    expect(frameAllowed({ xFrameOptions: null, contentSecurityPolicy: null }, own)).toBe(true);
    expect(frameAllowed({ contentSecurityPolicy: "default-src 'self'; img-src *" }, own)).toBe(true);
  });

  test("X-Frame-Options deny / sameorigin forbid it", () => {
    expect(frameAllowed({ xFrameOptions: "DENY" }, own)).toBe(false);
    expect(frameAllowed({ xFrameOptions: "SAMEORIGIN" }, own)).toBe(false);
    expect(frameAllowed({ xFrameOptions: "allow-from https://other.example" }, own)).toBe(false);
    expect(frameAllowed({ xFrameOptions: `allow-from ${own}` }, own)).toBe(true);
  });

  test("frame-ancestors is read from the Content-Security-Policy", () => {
    expect(frameAllowed({ contentSecurityPolicy: "frame-ancestors 'none'" }, own)).toBe(false);
    expect(frameAllowed({ contentSecurityPolicy: "frame-ancestors 'self'" }, own)).toBe(false);
    expect(frameAllowed({ contentSecurityPolicy: "frame-ancestors" }, own)).toBe(false);
    expect(frameAllowed({ contentSecurityPolicy: "default-src 'self'; frame-ancestors *" }, own)).toBe(true);
    expect(frameAllowed({ contentSecurityPolicy: `frame-ancestors ${own}` }, own)).toBe(true);
    expect(frameAllowed({ contentSecurityPolicy: "frame-ancestors app.wsa.test" }, own)).toBe(true);
    expect(frameAllowed({ contentSecurityPolicy: "frame-ancestors https://someone-else.example" }, own)).toBe(false);
  });

  test("the strictest policy wins", () => {
    expect(frameAllowed({ xFrameOptions: "DENY", contentSecurityPolicy: "frame-ancestors *" }, own)).toBe(false);
    expect(frameAllowed({ contentSecurityPolicy: "frame-ancestors *, frame-ancestors 'none'" }, own)).toBe(false);
  });
});

describe("addresses that are stored", () => {
  test("https, a real host name, no query, no fragment", () => {
    expect(cleanTerminalUrl("https://WebTrader.IcMarkets.com/terminal?token=abc#x")).toBe("https://webtrader.icmarkets.com/terminal");
    expect(cleanTerminalUrl("  https://webtrader.icmarkets.com  ")).toBe("https://webtrader.icmarkets.com/");
    expect(cleanTerminalUrl("https://webtrader.icmarkets.com:443/")).toBe("https://webtrader.icmarkets.com/");
  });

  test.each([
    "http://webtrader.icmarkets.com/",
    "javascript:alert(1)",
    "https://user:pass@webtrader.icmarkets.com/",
    "https://localhost/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://127.0.0.1/",
    "https://192.168.1.5/terminal",
    "https://singlelabel/",
    "https://webtrader.icmarkets.com:8443/",
    "not a url",
    "",
  ])("%j is refused", (raw) => {
    expect(cleanTerminalUrl(raw)).toBeNull();
  });

  test("anything but a string is refused", () => {
    expect(cleanTerminalUrl(null)).toBeNull();
    expect(cleanTerminalUrl(undefined)).toBeNull();
    expect(cleanTerminalUrl(5)).toBeNull();
    expect(cleanTerminalUrl({})).toBeNull();
  });
});
