/**
 * MetaTrader web terminal helpers (pure, no I/O - safe in the browser, in route
 * handlers and in tests).
 *
 * What is (and is not) possible - verified against the public MetaQuotes pages:
 *  - `https://metatraderweb.app/trade` (the classic multi-broker WebTrader) and
 *    `https://web.metatrader.app/terminal` (the new terminal) send no
 *    `X-Frame-Options` / `frame-ancestors`, so they can be embedded in an iframe.
 *  - The classic terminal documents these address parameters (MQL5 article 3024):
 *    `servers` (the servers offered in the sign-in form), `trade_server` (the
 *    server selected in it - the terminal then opens the MT4 or the MT5 version
 *    that belongs to that server), `login`, `startup_version` (4 or 5, only for
 *    the very first start - afterwards the terminal follows the account used
 *    last), `startup_mode=no_autologin` (do NOT reconnect to the account used
 *    last) and `demo_all_servers=1` (offer every supported broker server).
 *    There is NO address parameter for the password, so the password is typed once
 *    inside the terminal (its "Save password" box keeps it in the browser).
 *    Nothing here ever handles a password.
 *  - Why MetaQuotes' default server used to come up: the terminal creates a
 *    MetaQuotes-Demo account on its first start and, unless told otherwise,
 *    reconnects to the account it used last - it never looked at `login` /
 *    `trade_server`. The address built here therefore always carries the
 *    account's own server and platform and switches that reconnection off.
 *  - The new terminal hosted by MetaQuotes only knows the MetaQuotes-Demo server;
 *    real broker servers are served by the classic terminal or by a deployment the
 *    broker itself hosts (the "custom URL" source).
 *  - A broker whose server is not in MetaQuotes' directory cannot be opened in the
 *    classic terminal at all; its own WebTrader address is the only way in.
 *  - UPDATE (MetaQuotes' own pages, 2023): the shared MetaTrader 5 web terminal was
 *    closed on 1 August 2023. "Each web terminal is assigned to a specific broker
 *    and is located on its domain" - an MT5 account can only be opened in the web
 *    terminal its broker hosts, and the classic address above only still serves
 *    MT4. That is why the traders used to be asked for an address. The "auto"
 *    source removes the question: `brokerWebTerminalService` finds the broker's
 *    terminal from the account's server (see `brokerTerminal.ts`) and this file only
 *    puts the login number, server and platform on that address.
 */

import type { AccountStatus } from "@/lib/domain/types";

export type MetaTraderPlatform = "MT4" | "MT5";
export type MetaTraderSource = "auto" | "classic" | "modern" | "custom";

export const CLASSIC_TERMINAL_URL = "https://metatraderweb.app/trade";
export const MODERN_TERMINAL_URL = "https://web.metatrader.app/terminal";

export const META_TRADER_SOURCES: ReadonlyArray<{
  id: MetaTraderSource;
  label: string;
  description: string;
}> = [
  {
    id: "auto",
    label: "Automatic (recommended)",
    description:
      "Opens your broker's own web terminal. The platform finds its address from your account's server - nothing to look up or enter.",
  },
  {
    id: "classic",
    label: "MetaTrader 4 Web (MetaQuotes)",
    description:
      "MetaQuotes' shared MT4 web terminal, for MT4 brokers on MetaQuotes' list. MetaQuotes closed the shared MT5 version in 2023 - MT5 accounts use the broker's own terminal.",
  },
  {
    id: "modern",
    label: "MetaTrader 5 Web (MetaQuotes demo)",
    description:
      "MetaQuotes' new MT5 terminal. Its public site only offers the MetaQuotes-Demo server - broker accounts open in the broker's own terminal (Automatic).",
  },
  {
    id: "custom",
    label: "Enter an address myself",
    description: "Only needed when Automatic cannot find your broker's terminal: the WebTrader address your broker gave you (https only).",
  },
];

export function isMetaTraderPlatform(value: unknown): value is MetaTraderPlatform {
  return value === "MT4" || value === "MT5";
}

export function isMetaTraderSource(value: unknown): value is MetaTraderSource {
  return value === "auto" || value === "classic" || value === "modern" || value === "custom";
}

/** `mt5` / "MT5 " / "Mt4" -> MT4 | MT5, anything else -> null. */
export function normalizePlatform(value: unknown): MetaTraderPlatform | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return upper === "MT4" || upper === "MT5" ? upper : null;
}

/** The server MetaQuotes itself runs (`MetaQuotes-Demo`, ...) - the one the terminals fall back to. */
export function isMetaQuotesServer(value: unknown): boolean {
  return typeof value === "string" && /^metaquotes-/i.test(value.trim());
}

/**
 * Brokers very often put the platform into the server name ("Exness-MT5Real10",
 * "ICMarketsSC-MT5-2", "XM.COM-MT4 3"). Used only when the platform is not stored
 * with the account. A name without such a marker says nothing -> null. The
 * MetaQuotes servers exist for both platforms and are never guessed.
 */
export function inferPlatformFromServer(value: unknown): MetaTraderPlatform | null {
  if (typeof value !== "string") return null;
  const match = /(?:^|[^A-Za-z0-9])MT([45])(?![0-9])/i.exec(value);
  if (!match) return null;
  return match[1] === "4" ? "MT4" : "MT5";
}

/** The platform stored with the account, or - when there is none - the one the server name announces. */
export function resolveTerminalPlatform(stored: unknown, server: unknown): MetaTraderPlatform | null {
  return normalizePlatform(stored) ?? inferPlatformFromServer(server);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field sanitizers
// ─────────────────────────────────────────────────────────────────────────────

/** MetaTrader logins are plain numbers. */
export function sanitizeLogin(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{1,12}$/.test(trimmed) ? trimmed : null;
}

/**
 * Trade-server names such as "ICMarketsSC-Demo", "FTMO-Server3", "XM.COM-MT5 3".
 * Letters, digits, space and `. _ - + ( )`, 2-64 characters.
 */
export function sanitizeServer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{1,63}$/.test(trimmed) ? trimmed : null;
}

/** A short display name; control characters and angle brackets are dropped. */
export function sanitizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * "12345678" -> "••••5678". At most the last four digits and never more than half
 * of them are shown, so a short login is not given away.
 */
export function maskLogin(login: string): string {
  const digits = login.trim();
  const visible = Math.min(4, Math.floor(digits.length / 2));
  return visible > 0 ? `••••${digits.slice(-visible)}` : "••••";
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes returned by /api/terminal/metatrader/* (shared by server and browser)
// ─────────────────────────────────────────────────────────────────────────────

export type TerminalAccountUnavailableReason =
  | "NO_CREDENTIALS"
  | "UNREADABLE"
  | "ENCRYPTION_UNAVAILABLE"
  | "INCOMPLETE";

export interface MetaTraderTerminalAccount {
  accountId: string;
  accountName: string;
  brokerName: string;
  platform: MetaTraderPlatform | null;
  server: string | null;
  /** `••••5678`; null when the login could not be read */
  loginMasked: string | null;
  currency: string;
  status: AccountStatus;
  canLaunch: boolean;
  unavailableReason: TerminalAccountUnavailableReason | null;
}

export interface MetaTraderLaunchTarget {
  accountId: string;
  accountName: string;
  brokerName: string;
  platform: MetaTraderPlatform;
  /** null when the stored server name is not a plain trade-server name - the user picks it in the form */
  server: string | null;
  login: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manually added accounts
// ─────────────────────────────────────────────────────────────────────────────

export interface ManualMetaTraderAccount {
  id: string;
  label: string;
  platform: MetaTraderPlatform;
  login: string;
  server: string;
}

export const MAX_MANUAL_ACCOUNTS = 20;

/** `m` + 18 random hex characters (the workspace accepts 6-64 letters, digits, `_` and `-`). */
export function createManualAccountId(): string {
  const bytes = new Uint8Array(9);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return `m${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type ManualAccountResult =
  | { ok: true; value: Omit<ManualMetaTraderAccount, "id"> }
  | { ok: false; field: "platform" | "login" | "server"; reason: string };

/** Validates the "add manually" form. The password is deliberately not a field. */
export function parseManualAccountInput(input: {
  label?: unknown;
  platform?: unknown;
  login?: unknown;
  server?: unknown;
}): ManualAccountResult {
  const platform = normalizePlatform(input.platform);
  if (!platform) return { ok: false, field: "platform", reason: "Choose MetaTrader 4 or MetaTrader 5." };

  const login = sanitizeLogin(input.login);
  if (!login) return { ok: false, field: "login", reason: "The login is the account number (digits only)." };

  const server = sanitizeServer(input.server);
  if (!server) {
    return {
      ok: false,
      field: "server",
      reason: "Enter the server exactly as your broker shows it, e.g. ICMarketsSC-Demo.",
    };
  }

  return {
    ok: true,
    value: { label: sanitizeLabel(input.label, `${platform} ${maskLogin(login)}`), platform, login, server },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Addresses
// ─────────────────────────────────────────────────────────────────────────────

export type CustomUrlResult = { ok: true; url: string } | { ok: false; reason: string };

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[");
}

/**
 * A broker WebTrader address that may be shown in the embedded frame: https only,
 * a real host name (no IP literal, no `localhost`, no single-label host), no
 * credentials in the address and never this site itself.
 */
export function validateCustomTerminalUrl(raw: unknown, ownOrigin?: string | null): CustomUrlResult {
  if (typeof raw !== "string") return { ok: false, reason: "Enter the address of your broker's web terminal." };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Enter the address of your broker's web terminal." };
  if (trimmed.length > 500) return { ok: false, reason: "That address is too long." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid web address. Start it with https://" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "Only https:// addresses can be opened here." };
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Remove the user name / password from the address." };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "Use your broker's public web terminal address." };
  }
  if (isIpLiteral(host) || !host.includes(".")) {
    return { ok: false, reason: "Use your broker's web terminal host name, not an IP address." };
  }
  if (ownOrigin && parsed.origin === ownOrigin) {
    return { ok: false, reason: "That address points back to this platform." };
  }
  return { ok: true, url: parsed.toString() };
}

export interface MetaTraderLaunchInput {
  source: MetaTraderSource;
  customUrl?: string | null;
  platform: MetaTraderPlatform;
  login?: string | null;
  server?: string | null;
  lang?: string;
  /** colour mode of the page the terminal is shown in */
  dark?: boolean;
  /** origin of this site - a custom address may never point back to it */
  ownOrigin?: string | null;
  /**
   * Let the terminal reconnect on its own to the account it used last (it needs a
   * password saved in the terminal). Off by default: the sign-in form then opens
   * for the account chosen here, so a session can never silently continue on
   * another account - or on MetaQuotes' own demo account.
   */
  autoLogin?: boolean;
  /**
   * The web terminal the account's broker hosts (found by the platform, or saved
   * by the user) - used by the "auto" source. Validated like a custom address.
   */
  brokerTerminalUrl?: string | null;
}

export type MetaTraderLaunchResult =
  | {
      ok: true;
      url: string;
      host: string;
      /** the sign-in form comes up with login (and server) filled in */
      prefilled: boolean;
      /** the terminal can not preselect the server - the user picks it in the form */
      serverNotPreselected: boolean;
      /** whose terminal it is: the broker's own, or one MetaQuotes hosts */
      kind?: "broker" | "metaquotes";
    }
  | {
      ok: false;
      reason: string;
      /** another web terminal that can open this account */
      switchTo?: MetaTraderSource;
      /** "auto" found no terminal of the broker (MT5 has no other web terminal) */
      needsBrokerTerminal?: boolean;
    };

type QueryPair = readonly [string, string];

/**
 * Sets (or replaces) query parameters. Spaces are written as `%20` - server names
 * such as "XM.COM-MT5 3" contain them, and not every terminal reads `+` as a space.
 * Parameters the address already had (a broker's own) are kept.
 */
function withQuery(base: URL, extra: ReadonlyArray<QueryPair>): URL {
  const replaced = new Set(extra.map(([key]) => key));
  const pairs: QueryPair[] = [];
  base.searchParams.forEach((value, key) => {
    if (!replaced.has(key)) pairs.push([key, value]);
  });
  pairs.push(...extra);
  const url = new URL(base.toString());
  url.search = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  return url;
}

/**
 * The address of the web terminal for an account. Only the login number, the
 * server name and the platform are placed in it - never a password.
 *
 * Classic terminal: the account's own server is the only one offered (`servers`)
 * and the one selected (`trade_server`), the platform is requested
 * (`startup_version`) and - unless `autoLogin` is set - the reconnection to the
 * account used last is switched off (`startup_mode=no_autologin`). Without a
 * server name, every supported broker server is offered (`demo_all_servers`).
 */
export function buildMetaTraderUrl(input: MetaTraderLaunchInput): MetaTraderLaunchResult {
  const login = input.login ? sanitizeLogin(input.login) : null;
  const server = input.server ? sanitizeServer(input.server) : null;
  const lang = input.lang && /^[a-z]{2}$/.test(input.lang) ? input.lang : "en";
  const version = input.platform === "MT4" ? "4" : "5";

  if (input.source === "modern") {
    if (input.platform === "MT4") {
      return {
        ok: false,
        reason: "The new web terminal supports MetaTrader 5 only. Use MetaTrader Web for MT4 accounts.",
        switchTo: "classic",
      };
    }
    if (server && !isMetaQuotesServer(server)) {
      return {
        ok: false,
        reason: `The new MetaQuotes terminal only offers its own demo server, not “${server}”. Use MetaTrader Web, which connects to your broker's server.`,
        switchTo: "classic",
      };
    }
    const extra: QueryPair[] = [];
    if (login) extra.push(["login", login]);
    extra.push(["lang", lang]);
    if (input.dark) extra.push(["theme-mode", "1"]);
    const url = withQuery(new URL(MODERN_TERMINAL_URL), extra);
    return { ok: true, url: url.toString(), host: url.host, prefilled: login !== null, serverNotPreselected: false };
  }

  // A web terminal the broker hosts (MT5 has no other kind): its own address plus the
  // login, server and platform. Deployments built on MetaQuotes' terminal honour
  // these; others ignore them.
  const brokerHosted = (address: string): MetaTraderLaunchResult => {
    const extra: QueryPair[] = [];
    if (login) extra.push(["login", login]);
    if (server) extra.push(["trade_server", server]);
    extra.push(["startup_version", version]);
    if (!input.autoLogin) extra.push(["startup_mode", "no_autologin"]);
    const url = withQuery(new URL(address), extra);
    return {
      ok: true,
      url: url.toString(),
      host: url.host,
      prefilled: login !== null,
      serverNotPreselected: false,
      kind: "broker",
    };
  };

  if (input.source === "custom") {
    const checked = validateCustomTerminalUrl(input.customUrl, input.ownOrigin);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    return brokerHosted(checked.url);
  }

  if (input.source === "auto") {
    // 1. the broker's own terminal, when one is known
    if (input.brokerTerminalUrl) {
      const checked = validateCustomTerminalUrl(input.brokerTerminalUrl, input.ownOrigin);
      if (checked.ok) return brokerHosted(checked.url);
    }
    // 2. MetaQuotes' own servers: their demo terminal
    if (server && isMetaQuotesServer(server)) {
      return buildMetaTraderUrl({ ...input, source: input.platform === "MT5" ? "modern" : "classic" });
    }
    // 3. MT4 without a known broker terminal: MetaQuotes' shared MT4 terminal (it
    //    lists many brokers). MT5 has no shared terminal any more.
    if (input.platform === "MT4") {
      const shared = buildMetaTraderUrl({ ...input, source: "classic" });
      return shared.ok ? { ...shared, kind: "metaquotes" } : shared;
    }
    return {
      ok: false,
      reason: "Your broker's MetaTrader 5 web terminal could not be found automatically.",
      needsBrokerTerminal: true,
    };
  }

  const extra: QueryPair[] = [];
  if (server) {
    extra.push(["servers", server], ["trade_server", server]);
  } else {
    extra.push(["demo_all_servers", "1"]);
  }
  if (login) extra.push(["login", login]);
  extra.push(["startup_version", version]);
  if (!input.autoLogin) extra.push(["startup_mode", "no_autologin"]);
  extra.push(["lang", lang]);
  const url = withQuery(new URL(CLASSIC_TERMINAL_URL), extra);
  return {
    ok: true,
    url: url.toString(),
    host: url.host,
    prefilled: login !== null,
    serverNotPreselected: server === null,
  };
}
