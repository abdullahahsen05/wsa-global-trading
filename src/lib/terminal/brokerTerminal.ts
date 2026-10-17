/**
 * Finding a broker's own MetaTrader web terminal (pure, no I/O - safe in the
 * browser, in route handlers and in tests).
 *
 * Why this exists. MetaQuotes closed its shared MetaTrader 5 web terminal
 * (August 2023): "each web terminal is assigned to a specific broker and is
 * located on its domain", and the public MetaQuotes site only offers a demo. So
 * an MT5 account can only be opened in the web terminal the BROKER hosts, and
 * until now every trader had to find that address and paste it in. The platform
 * now works it out itself:
 *
 *   server name  ->  who owns it (API2Trade's broker directory: company + website)
 *               ->  candidate web-terminal addresses on that company's own domain
 *               ->  each candidate is fetched and must look like a MetaTrader
 *                   web terminal, on the same domain, embeddable or not.
 *
 * This file holds the rules (names, domains, candidate lists, what a page must
 * look like, whether it may be framed, which addresses are public); the network
 * and the cache live in `brokerWebTerminalService.ts`.
 *
 * Safety rules that are encoded here and tested:
 *  - a candidate is always on the registrable domain of the broker (taken from
 *    the broker directory, or guessed from the server name and then required to
 *    contain the brand) - never on an address a user typed in;
 *  - https only, host names only (no IP literals), never a private / reserved
 *    address.
 */

import {
  isMetaQuotesServer,
  sanitizeServer,
  type MetaTraderPlatform,
} from "@/lib/terminal/metatrader";

/** Where a terminal address came from. */
export type BrokerTerminalSource = "ADMIN" | "DISCOVERED" | "SAVED";

export type BrokerTerminalStatus =
  /** an address was found (`url` is set) */
  | "FOUND"
  /** looked, nothing usable found */
  | "NOT_FOUND"
  /** an administrator switched the automatic address off for this broker */
  | "BLOCKED"
  /** could not look right now (busy, no broker directory, timeout) - try again later */
  | "UNAVAILABLE"
  /** MetaQuotes' own servers: nothing to look for */
  | "NOT_NEEDED";

/** What `POST /api/terminal/metatrader/resolve` answers. */
export interface BrokerTerminalInfo {
  serverKey: string | null;
  status: BrokerTerminalStatus;
  /** the broker's own web terminal; https, without query or fragment */
  url: string | null;
  host: string | null;
  source: BrokerTerminalSource | null;
  /** false: the page forbids being shown inside another page - open it in a new tab */
  embeddable: boolean;
  brokerName: string | null;
  /** ISO time of the last look */
  checkedAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The broker part of a trade-server name, lower case: `ICMarketsSC-Demo` ->
 * `icmarketssc`, `Exness-MT5Real10` -> `exness`, `XM.COM-MT5 3` -> `xmcom`.
 * It is the key under which a broker's web terminal is remembered.
 */
export function serverKeyOf(server: unknown): string | null {
  const clean = sanitizeServer(server);
  if (!clean) return null;
  const key = clean
    .split(/[-\s]/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return key.length >= 2 ? key.slice(0, 40) : null;
}

/** True for a key as `serverKeyOf` makes it (used where a key comes from outside). */
export function isServerKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{2,40}$/.test(value);
}

/**
 * The key a broker's web terminal is stored under: the broker part of the server
 * name and the platform (`ICMarketsSC-Live01` on MT5 -> `icmarketssc:mt5`). MT4
 * and MT5 of one broker run on different terminals, so the platform is part of it.
 */
export function brokerTerminalKey(server: unknown, platform: MetaTraderPlatform): string | null {
  const key = serverKeyOf(server);
  return key ? `${key}:${platform.toLowerCase()}` : null;
}

/** True for a key as `brokerTerminalKey` makes it (used where a key comes from outside). */
export function isBrokerTerminalKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{2,40}:mt[45]$/.test(value);
}

/** Words that only say which legal entity / region a server belongs to; a brand can stay at 2 characters without them (`xmglobal` -> `xm`). */
const LONG_SUFFIX = /(global|international|intl|limited|ltd|llc|inc|group|holdings|com)$/;
/** Region codes: removing them must leave at least 3 characters (`icmarketssc` -> `icmarkets`). */
const SHORT_SUFFIX = /(sc|eu|uk|au|za|cy|ae|vu|bvi|sey|asia|africa)$/;

/**
 * The names a broker's domain may contain, longest first: `icmarketssc` ->
 * `icmarketssc`, `icmarkets`; `xmglobal` -> `xmglobal`, `xm`. Entity and region
 * suffixes are removed one by one; a brand is never cut down to its first letters.
 */
export function brandTokens(key: string): string[] {
  const tokens: string[] = [];
  let current = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  while (current.length >= 2 && !tokens.includes(current)) {
    tokens.push(current);
    let next = current.replace(LONG_SUFFIX, "");
    let minimum = 2;
    if (next === current) {
      next = current.replace(SHORT_SUFFIX, "");
      minimum = 3;
    }
    if (next === current || next.length < minimum) break;
    current = next;
  }
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domains
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC_SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

/** `webtrader.icmarkets.com.au` -> `icmarkets.com.au`; null for an IP address or a single label. */
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.every((label) => /^\d+$/.test(label))) return null;
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (labels.length >= 3 && last.length === 2 && GENERIC_SECOND_LEVEL.has(second)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

/** The domain a web address is on, from the address text; null when it is not a usable https address. */
export function domainOfUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return registrableDomain(parsed.hostname);
}

/** True when the first label of `domain` carries the broker's name. */
export function domainMatchesBrand(domain: string, key: string): boolean {
  const label = domain.toLowerCase().split(".")[0].replace(/[^a-z0-9]/g, "");
  if (label.length < 2) return false;
  return brandTokens(key).some(
    (token) =>
      label === token ||
      (token.length >= 4 && (label.startsWith(token) || label.endsWith(token))) ||
      (label.length >= 4 && token.startsWith(label)),
  );
}

/** Domains guessed from the server name when the broker directory has no website: `icmarkets.com`... */
export function guessedBrokerDomains(key: string): string[] {
  const tokens = brandTokens(key).filter((token) => token.length >= 2);
  const result: string[] = [];
  // the shortest meaningful brand first: `xm.com` before `xmglobal.com`
  for (const token of [...tokens].reverse()) {
    const domain = `${token}.com`;
    if (!result.includes(domain)) result.push(domain);
  }
  return result.slice(0, 3);
}

const HOST_PREFIXES: Record<MetaTraderPlatform, ReadonlyArray<string>> = {
  MT5: [
    "webtrader",
    "mt5",
    "mt5web",
    "web",
    "trade",
    "terminal",
    "webterminal",
    "mt5-web",
    "webtrader5",
    "webtrader-mt5",
    "metatrader5",
    "trader",
    "platform",
  ],
  MT4: [
    "webtrader",
    "mt4",
    "mt4web",
    "web",
    "trade",
    "terminal",
    "webterminal",
    "mt4-web",
    "webtrader4",
    "webtrader-mt4",
    "metatrader4",
    "trader",
    "platform",
  ],
};

/** Host names a broker commonly runs its web terminal on, most likely first. */
export function terminalHostCandidates(domain: string, platform: MetaTraderPlatform): string[] {
  return HOST_PREFIXES[platform].map((prefix) => `${prefix}.${domain}`);
}

/** Host names that are dedicated to a trading terminal (a stronger sign than a generic `web.`). */
export function isDedicatedTerminalHost(host: string): boolean {
  return /^(webtrader|mt[45]|mt[45]web|mt[45]-web|webterminal|metatrader[45]?|webtrader[45]?|webtrader-mt[45]|terminal)\./i.test(
    host,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public addresses only
// ─────────────────────────────────────────────────────────────────────────────

function ipv4Parts(ip: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

/** False for loopback, private, link-local, carrier-grade NAT, documentation, multicast and reserved addresses. */
export function isPublicIp(ip: string): boolean {
  const text = ip.trim().toLowerCase();
  const v4 = ipv4Parts(text);
  if (v4) {
    const [a, b, c] = v4;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false;
    return true;
  }
  if (!text.includes(":")) return false;
  if (text === "::" || text === "::1") return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) return isPublicIp(mapped[1]);
  const first = text.split(":")[0];
  if (first === "") return false; // other "::..." forms are not worth reasoning about
  const head = Number.parseInt(first, 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return false; // multicast
  if (head === 0x2001 && text.startsWith("2001:db8")) return false; // documentation
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a page
// ─────────────────────────────────────────────────────────────────────────────

export interface TerminalPageAnalysis {
  title: string;
  /** the title announces a web trading terminal */
  strong: boolean;
  /** the page speaks of MetaTrader / a web terminal somewhere */
  mentions: boolean;
  mentionsMt4: boolean;
  mentionsMt5: boolean;
}

const TERMINAL_WORDS = /metatrader|meta trader|\bmt[45]\b|web\s*-?\s*trader|web\s*-?\s*terminal|webplatform|web platform|metaquotes/;

/** What a fetched HTML page says about itself (the first 300 000 characters are read). */
export function analyzeTerminalPage(html: string): TerminalPageAnalysis {
  const text = html.slice(0, 300_000).toLowerCase();
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/.exec(text);
  const title = (titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const strong = /metatrader|\bmt[45]\b|web\s*-?\s*trader|web\s*-?\s*terminal|web\s*platform/.test(title);
  return {
    title,
    strong,
    mentions: strong || TERMINAL_WORDS.test(text),
    mentionsMt4: /metatrader\s*4|\bmt4\b/.test(text),
    mentionsMt5: /metatrader\s*5|\bmt5\b/.test(text),
  };
}

/**
 * How good a candidate is; a candidate needs 3 or more. A page that never speaks
 * of MetaTrader / a web terminal scores nothing (it is another product or a
 * parked domain), and one that speaks only of the OTHER platform is turned down.
 */
export function scoreTerminalCandidate(input: {
  url: string;
  platform: MetaTraderPlatform;
  analysis: TerminalPageAnalysis;
  /** found as a link on the broker's own site (instead of a guessed host name) */
  viaLink: boolean;
}): number {
  const { analysis, platform } = input;
  if (!analysis.mentions) return 0;

  const wantsMt5 = platform === "MT5";
  const matches = wantsMt5 ? analysis.mentionsMt5 : analysis.mentionsMt4;
  const other = wantsMt5 ? analysis.mentionsMt4 : analysis.mentionsMt5;
  if (other && !matches) return 0;

  let score = 1;
  if (analysis.strong) score += 2;
  if (matches) score += 1;

  let parsed: URL | null = null;
  try {
    parsed = new URL(input.url);
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (isDedicatedTerminalHost(parsed.hostname)) score += 1;
    if (/\/(terminal|trade|webtrader|web-trader|webterminal|web-terminal|platform)\b/i.test(parsed.pathname)) score += 1;
    const depth = parsed.pathname.split("/").filter(Boolean).length;
    if (depth > 3) score -= 1;
  }
  if (input.viaLink) score += 1;
  return score;
}

export const MIN_TERMINAL_SCORE = 3;

const LINK_WORDS =
  /web\s*-?\s*trader|web\s*-?\s*terminal|web\s*-?\s*platform|\bmt[45]\s*-?\s*web|metatrader\s*[45]?\s*-?\s*web|webtrader|launch\s+(?:the\s+)?(?:web|platform)|trade\s+online/i;

/**
 * Links of a broker's page that look like "WebTrader" / "Web Terminal" / "MT5
 * Web". Only https addresses on `domain` (or one of its sub-domains) are kept.
 */
export function extractTerminalLinks(html: string, baseUrl: string, domain: string, limit = 8): string[] {
  const found: string[] = [];
  const anchors = /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  const source = html.slice(0, 400_000);
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(source)) !== null) {
    const href = match[2].trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    const text = match[3].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    if (!LINK_WORDS.test(`${text} ${href}`)) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== "https:") continue;
    if (registrableDomain(absolute.hostname) !== domain) continue;
    absolute.hash = "";
    absolute.search = "";
    const clean = absolute.toString();
    if (!found.includes(clean)) found.push(clean);
    if (found.length >= limit) break;
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// May the page be shown inside another page?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `X-Frame-Options` and the `frame-ancestors` part of `Content-Security-Policy`.
 * A page without either may be framed. `ownOrigin` is this platform's origin.
 */
export function frameAllowed(
  headers: { xFrameOptions?: string | null; contentSecurityPolicy?: string | null },
  ownOrigin?: string | null,
): boolean {
  const xfo = headers.xFrameOptions?.trim().toLowerCase() ?? "";
  if (xfo) {
    if (xfo.startsWith("deny") || xfo.startsWith("sameorigin")) return false;
    const allowFrom = /^allow-from\s+(\S+)/.exec(xfo);
    if (allowFrom && (!ownOrigin || allowFrom[1].replace(/\/$/, "") !== ownOrigin.toLowerCase())) return false;
  }

  const csp = headers.contentSecurityPolicy ?? "";
  for (const policy of csp.split(",")) {
    const directive = policy
      .split(";")
      .map((part) => part.trim())
      .find((part) => /^frame-ancestors\b/i.test(part));
    if (!directive) continue;
    const sources = directive.split(/\s+/).slice(1).map((source) => source.toLowerCase());
    if (sources.length === 0 || sources.includes("'none'")) return false;
    const allowsUs = sources.some(
      (source) =>
        source === "*" ||
        source === "https:" ||
        (ownOrigin ? source === ownOrigin.toLowerCase() || source === new URL(ownOrigin).host.toLowerCase() : false),
    );
    if (!allowsUs) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Addresses that are stored and shown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An address as it is stored: https, a real host name, no credentials, no query
 * and no fragment (a session or tracking parameter has no place in a saved
 * address). Null when it is not usable.
 */
export function cleanTerminalUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return null;
  }
  if (registrableDomain(host) === null) return null;
  if (parsed.port && parsed.port !== "443") return null;
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = host;
  return parsed.toString();
}

/** MetaQuotes' own servers have no broker behind them. */
export function needsBrokerTerminal(server: unknown): boolean {
  return serverKeyOf(server) !== null && !isMetaQuotesServer(server);
}
