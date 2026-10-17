if (typeof window !== "undefined") {
  throw new Error("[wsa] brokerWebTerminalService is server-only.");
}

import { lookup } from "node:dns/promises";
import { Api2TradeClient, loadApi2TradeConfig } from "@/lib/broker/api2TradeClient";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MIN_TERMINAL_SCORE,
  analyzeTerminalPage,
  cleanTerminalUrl,
  domainMatchesBrand,
  domainOfUrl,
  extractTerminalLinks,
  frameAllowed,
  guessedBrokerDomains,
  isDedicatedTerminalHost,
  isPublicIp,
  registrableDomain,
  scoreTerminalCandidate,
  serverKeyOf,
  terminalHostCandidates,
  type BrokerTerminalInfo,
  type BrokerTerminalSource,
} from "@/lib/terminal/brokerTerminal";
import { isMetaQuotesServer, type MetaTraderPlatform } from "@/lib/terminal/metatrader";

// ─────────────────────────────────────────────────────────────────────────────
// A broker's own MetaTrader web terminal, found by the platform.
//
// MT5 web terminals run on the BROKER's domain (MetaQuotes closed the shared one),
// so the address of the terminal depends on the account's server. This service
// works it out once per broker + platform and remembers it:
//
//   1. a row in `broker_web_terminals` (migration 059, optional): an
//      administrator's override, or an earlier automatic finding;
//   2. otherwise the broker directory of API2Trade says which company owns the
//      server and what its website is; the terminal is looked for on that
//      company's domain (links of its site that say "WebTrader" / "Web
//      Terminal", and the usual host names such as webtrader.<domain>);
//   3. every candidate is fetched and must look like a MetaTrader web terminal;
//      the best one is stored.
//
// Safety: addresses are never taken from the request - only the server name (and,
// for a platform account, the broker name stored with it) goes in, and a domain
// comes from the broker directory or is guessed from the brand. Fetching is
// https only, public addresses only (DNS answers are checked), redirects stay on
// the broker's domain, bodies are cut at 300 kB, every look has a deadline, and
// the number of looks running at once and per user is limited. Nothing a page says
// is returned to the browser - only the address that was chosen.
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchedPage {
  /** the address after redirects */
  url: string;
  status: number;
  text: string;
  xFrameOptions: string | null;
  contentSecurityPolicy: string | null;
}

export interface DiscoveryDeps {
  now(): number;
  /** The company that owns `server` in the broker directory (name + website), or null. */
  lookupCompany(server: string, brokerName: string | null): Promise<{ name: string | null; website: string | null } | null>;
  /** True when the host name resolves, and only to public addresses. */
  hostResolves(host: string): Promise<boolean>;
  /** One page of the public web (see the safety rules above); null when it could not be read. */
  fetchPage(url: string, domain: string): Promise<FetchedPage | null>;
}

export interface DiscoveryResult {
  url: string;
  embeddable: boolean;
  brokerName: string | null;
}

const MAX_CANDIDATES = 8;
const FETCH_GROUP = 3;
const MAX_DOMAINS = 2;

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Looks for the web terminal of the broker that owns `server`. Pure with respect
 * to the network and the clock: everything outside goes through `deps`.
 */
export async function discoverBrokerWebTerminal(
  input: {
    server: string;
    brokerName: string | null;
    platform: MetaTraderPlatform;
    ownOrigin: string | null;
    /** epoch ms after which no new request is started */
    deadline: number;
  },
  deps: DiscoveryDeps,
): Promise<DiscoveryResult | null> {
  const key = serverKeyOf(input.server);
  if (!key) return null;
  const expired = () => deps.now() >= input.deadline;

  let company: Awaited<ReturnType<DiscoveryDeps["lookupCompany"]>> = null;
  try {
    company = await deps.lookupCompany(input.server, input.brokerName);
  } catch {
    company = null;
  }

  // Domains: the company's own website; only without one, a guess from the brand.
  const directoryDomain = company?.website ? domainOfUrl(company.website) : null;
  const domains = directoryDomain
    ? [directoryDomain]
    : guessedBrokerDomains(key).filter((domain) => domainMatchesBrand(domain, key));
  const brokerName = company?.name?.trim() || input.brokerName;

  const found: Array<{ url: string; score: number; embeddable: boolean; dedicated: boolean; depth: number }> = [];

  for (const domain of domains.slice(0, MAX_DOMAINS)) {
    if (expired()) break;

    const hosts = terminalHostCandidates(domain, input.platform);
    const [resolved, linkUrls] = await Promise.all([
      Promise.all(hosts.map(async (host) => ((await deps.hostResolves(host).catch(() => false)) ? host : null))),
      (async (): Promise<string[]> => {
        for (const home of [`https://www.${domain}/`, `https://${domain}/`]) {
          if (expired()) return [];
          const page = await deps.fetchPage(home, domain).catch(() => null);
          if (page && page.status >= 200 && page.status < 300) {
            return extractTerminalLinks(page.text, page.url, domain);
          }
        }
        return [];
      })(),
    ]);

    // links found on the broker's site first, then the usual host names; one entry per address
    const byUrl = new Map<string, { url: string; viaLink: boolean }>();
    for (const url of linkUrls) byUrl.set(url, { url, viaLink: true });
    for (const host of resolved) {
      if (host !== null && !byUrl.has(`https://${host}/`)) byUrl.set(`https://${host}/`, { url: `https://${host}/`, viaLink: false });
    }
    const candidates = [...byUrl.values()].slice(0, MAX_CANDIDATES);

    for (let index = 0; index < candidates.length; index += FETCH_GROUP) {
      if (expired()) break;
      const group = candidates.slice(index, index + FETCH_GROUP);
      const pages = await Promise.all(
        group.map(async (candidate) => ({
          candidate,
          page: await deps.fetchPage(candidate.url, domain).catch(() => null),
        })),
      );
      for (const { candidate, page } of pages) {
        if (!page || page.status < 200 || page.status >= 300) continue;
        const clean = cleanTerminalUrl(page.url);
        if (!clean || registrableDomain(new URL(clean).hostname) !== domain) continue;
        const score = scoreTerminalCandidate({
          url: clean,
          platform: input.platform,
          analysis: analyzeTerminalPage(page.text),
          viaLink: candidate.viaLink,
        });
        if (score < MIN_TERMINAL_SCORE) continue;
        const parsed = new URL(clean);
        found.push({
          url: clean,
          score,
          embeddable: frameAllowed(
            { xFrameOptions: page.xFrameOptions, contentSecurityPolicy: page.contentSecurityPolicy },
            input.ownOrigin,
          ),
          dedicated: isDedicatedTerminalHost(parsed.hostname),
          depth: parsed.pathname.split("/").filter(Boolean).length,
        });
      }
    }
    // a good answer on the first domain ends the search
    if (found.length > 0) break;
  }

  if (found.length === 0) return null;
  found.sort(
    (left, right) =>
      right.score - left.score ||
      Number(right.dedicated) - Number(left.dedicated) ||
      left.depth - right.depth ||
      left.url.localeCompare(right.url),
  );
  const best = found[0];
  return { url: best.url, embeddable: best.embeddable, brokerName: brokerName ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The real network
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_TIMEOUT_MS = 3_500;
const MAX_PAGE_BYTES = 300_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; WSA-TerminalCheck/1.0)";

async function hostIsPublic(host: string): Promise<boolean> {
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((entry) => isPublicIp(entry.address));
  } catch {
    return false;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const type = response.headers.get("content-type") ?? "";
  if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) return "";
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let received = 0;
  let text = "";
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return text;
}

async function fetchPublicPage(url: string, domain: string): Promise<FetchedPage | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== "443") return null;
    // a broker's page may only lead to the broker's own domain
    if (registrableDomain(parsed.hostname) !== domain) return null;
    if (!(await hostIsPublic(parsed.hostname))) return null;

    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "user-agent": USER_AGENT },
      });
    } catch {
      return null;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      void response.body?.cancel().catch(() => undefined);
      if (!location) return null;
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }

    let text = "";
    try {
      text = await readLimited(response, MAX_PAGE_BYTES);
    } catch {
      text = "";
    }
    return {
      url: current,
      status: response.status,
      text,
      xFrameOptions: response.headers.get("x-frame-options"),
      contentSecurityPolicy: response.headers.get("content-security-policy"),
    };
  }
  return null;
}

function pickWebsite(record: Record<string, unknown>): string | null {
  for (const key of ["website", "site", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function directoryQueries(server: string, brokerName: string | null): string[] {
  const segment = server.split(/[-\s]/)[0]?.trim() ?? "";
  const queries = [brokerName?.trim() ?? "", segment, segment.replace(/([a-z])([A-Z])/g, "$1 $2")]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query) => query.length >= 2 && query.length <= 60);
  return dedupe(queries).slice(0, 3);
}

/** The company that owns the server in API2Trade's broker directory. */
async function lookupCompanyViaApi2Trade(
  server: string,
  brokerName: string | null,
): Promise<{ name: string | null; website: string | null } | null> {
  const config = loadApi2TradeConfig();
  if (!config) return null;
  const key = serverKeyOf(server);
  if (!key) return null;
  const client = new Api2TradeClient(config);
  const wanted = server.trim().toLowerCase();

  let brandMatch: { name: string | null; website: string | null } | null = null;
  for (const query of directoryQueries(server, brokerName)) {
    let companies: Awaited<ReturnType<Api2TradeClient["searchBroker"]>>;
    try {
      companies = await client.searchBroker(query);
    } catch {
      continue;
    }
    for (const company of companies) {
      const website = pickWebsite(company as unknown as Record<string, unknown>);
      const name = company.companyName?.trim() || null;
      const ownsServer = (company.results ?? []).some((entry) => entry.name?.trim().toLowerCase() === wanted);
      // the company that lists this very server is the owner
      if (ownsServer) return { name, website };
      const domain = website ? domainOfUrl(website) : null;
      if (!brandMatch && domain && domainMatchesBrand(domain, key)) brandMatch = { name, website };
    }
  }
  // no company lists the server (older name, renamed): a website that carries the brand will do
  return brandMatch;
}

export const realDiscoveryDeps: DiscoveryDeps = {
  now: () => Date.now(),
  lookupCompany: lookupCompanyViaApi2Trade,
  hostResolves: hostIsPublic,
  fetchPage: fetchPublicPage,
};

// ─────────────────────────────────────────────────────────────────────────────
// Remembering what was found
// ─────────────────────────────────────────────────────────────────────────────

const TABLE = "broker_web_terminals";
const FOUND_FRESH_MS = 14 * 24 * 60 * 60_000;
const NOT_FOUND_FRESH_MS = 6 * 60 * 60_000;
const UNAVAILABLE_FRESH_MS = 2 * 60_000;
const TABLE_RECHECK_MS = 10 * 60_000;
const DISCOVERY_BUDGET_MS = 8_000;
const MAX_PARALLEL_DISCOVERIES = 4;
const REFRESHES_PER_HOUR = 5;
const MAX_MEMORY_ENTRIES = 500;

interface Entry {
  storageKey: string;
  url: string | null;
  embeddable: boolean;
  brokerName: string | null;
  source: BrokerTerminalSource | null;
  /** epoch ms */
  checkedAt: number;
  unavailable?: boolean;
}

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const refreshLog = new Map<string, number[]>();
/** after a failed look at a broker whose older address is still shown: do not look again before this time (epoch ms) */
const retryAfter = new Map<string, number>();
let activeDiscoveries = 0;
let tableMissingUntil = 0;

/** Test helper: forget everything learned in this process. */
export function resetBrokerWebTerminalState(): void {
  memory.clear();
  inflight.clear();
  refreshLog.clear();
  retryAfter.clear();
  activeDiscoveries = 0;
  tableMissingUntil = 0;
}

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /could not find the table|relation .* does not exist/i.test(error.message ?? "");
}

type AdminDb = ReturnType<typeof createAdminClient>;

interface StoredRow {
  server_key: string;
  broker_name: string | null;
  url: string | null;
  source: string | null;
  embeddable: boolean | null;
  checked_at: string | null;
}

async function readStored(db: AdminDb, storageKey: string, now: number): Promise<Entry | null> {
  if (now < tableMissingUntil) return null;
  try {
    const { data, error } = await db
      .from(TABLE)
      .select("server_key, broker_name, url, source, embeddable, checked_at")
      .eq("server_key", storageKey)
      .maybeSingle();
    if (error) {
      if (isMissingTable(error)) tableMissingUntil = now + TABLE_RECHECK_MS;
      return null;
    }
    const row = data as StoredRow | null;
    if (!row) return null;
    const checkedAt = row.checked_at ? new Date(row.checked_at).getTime() : 0;
    return {
      storageKey,
      url: row.url ? cleanTerminalUrl(row.url) : null,
      embeddable: row.embeddable !== false,
      brokerName: row.broker_name,
      source: row.source === "ADMIN" ? "ADMIN" : "DISCOVERED",
      checkedAt: Number.isFinite(checkedAt) ? checkedAt : 0,
    };
  } catch {
    return null;
  }
}

async function writeStored(db: AdminDb, entry: Entry, now: number): Promise<void> {
  if (now < tableMissingUntil) return;
  try {
    const stamp = new Date(entry.checkedAt).toISOString();
    const { error } = await db.from(TABLE).upsert(
      {
        server_key: entry.storageKey,
        broker_name: entry.brokerName,
        url: entry.url,
        source: "DISCOVERED",
        embeddable: entry.embeddable,
        checked_at: stamp,
        updated_at: stamp,
      },
      { onConflict: "server_key" },
    );
    if (error && isMissingTable(error)) tableMissingUntil = now + TABLE_RECHECK_MS;
  } catch {
    // remembering is best effort
  }
}

function freshFor(entry: Entry): number {
  if (entry.source === "ADMIN") return Number.POSITIVE_INFINITY;
  if (entry.unavailable) return UNAVAILABLE_FRESH_MS;
  return entry.url ? FOUND_FRESH_MS : NOT_FOUND_FRESH_MS;
}

function toInfo(serverKey: string | null, entry: Entry | null, status?: BrokerTerminalInfo["status"]): BrokerTerminalInfo {
  if (!entry) {
    return {
      serverKey,
      status: status ?? "NOT_FOUND",
      url: null,
      host: null,
      source: null,
      embeddable: true,
      brokerName: null,
      checkedAt: null,
    };
  }
  const derived: BrokerTerminalInfo["status"] = entry.unavailable
    ? "UNAVAILABLE"
    : entry.url
      ? "FOUND"
      : entry.source === "ADMIN"
        ? "BLOCKED"
        : "NOT_FOUND";
  return {
    serverKey,
    status: status ?? derived,
    url: entry.url,
    host: entry.url ? new URL(entry.url).host : null,
    source: entry.url ? entry.source : null,
    embeddable: entry.embeddable,
    brokerName: entry.brokerName,
    checkedAt: new Date(entry.checkedAt).toISOString(),
  };
}

function refreshAllowed(userId: string, now: number): boolean {
  const recent = (refreshLog.get(userId) ?? []).filter((time) => now - time < 60 * 60_000);
  if (recent.length >= REFRESHES_PER_HOUR) {
    refreshLog.set(userId, recent);
    return false;
  }
  recent.push(now);
  refreshLog.set(userId, recent);
  return true;
}

function remember(entry: Entry): void {
  if (memory.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(entry.storageKey, entry);
}

export interface ResolveInput {
  userId: string;
  server: string;
  platform: MetaTraderPlatform;
  /** the broker name stored with a platform account (never taken from a manual account) */
  brokerName: string | null;
  ownOrigin: string | null;
  /** look again even though an earlier answer is still fresh (limited per user) */
  refresh?: boolean;
}

/**
 * The web terminal of the broker that owns `input.server`, for the platform
 * (MT4 / MT5) of the account. Never throws for a missing table or a network
 * problem - those give `UNAVAILABLE` / `NOT_FOUND`.
 */
export async function resolveBrokerWebTerminal(
  input: ResolveInput,
  deps: DiscoveryDeps = realDiscoveryDeps,
  db: AdminDb | null = null,
): Promise<BrokerTerminalInfo> {
  const serverKey = serverKeyOf(input.server);
  if (!serverKey) return toInfo(null, null, "NOT_FOUND");
  if (isMetaQuotesServer(input.server)) return toInfo(serverKey, null, "NOT_NEEDED");

  const now = deps.now();
  const storageKey = `${serverKey}:${input.platform.toLowerCase()}`;
  const store = db ?? createAdminClient();

  // The database is the memory shared by all instances (and the only place an
  // administrator's override lives); the process memory covers a database without
  // the table and the moments before a finding is written.
  const stored = await readStored(store, storageKey, now);
  const cached = memory.get(storageKey) ?? null;
  let known: Entry | null;
  if (stored?.source === "ADMIN") known = stored;
  else if (stored && cached) known = stored.checkedAt >= cached.checkedAt ? stored : cached;
  else known = stored ?? cached;
  if (known && known.source !== "ADMIN") remember(known);

  const wantsRefresh = input.refresh === true && known?.source !== "ADMIN" && refreshAllowed(input.userId, now);
  if (known && !wantsRefresh && now - known.checkedAt < freshFor(known)) return toInfo(serverKey, known);
  // the last look failed and an older address is still the best we have: give the broker's site a rest
  if (known?.url && !wantsRefresh && now < (retryAfter.get(storageKey) ?? 0)) return toInfo(serverKey, known);

  // one look at a time per broker, a few at a time overall
  let pending = inflight.get(storageKey);
  if (!pending) {
    if (activeDiscoveries >= MAX_PARALLEL_DISCOVERIES) {
      return known ? toInfo(serverKey, known) : toInfo(serverKey, null, "UNAVAILABLE");
    }
    activeDiscoveries += 1;
    pending = (async (): Promise<Entry> => {
      try {
        const result = await discoverBrokerWebTerminal(
          {
            server: input.server,
            brokerName: input.brokerName,
            platform: input.platform,
            ownOrigin: input.ownOrigin,
            deadline: now + DISCOVERY_BUDGET_MS,
          },
          deps,
        );
        const finishedAt = deps.now();
        if (result) {
          return {
            storageKey,
            url: result.url,
            embeddable: result.embeddable,
            brokerName: result.brokerName,
            source: "DISCOVERED",
            checkedAt: finishedAt,
          };
        }
        // out of time is not "there is none": do not remember it for hours
        const outOfTime = finishedAt >= now + DISCOVERY_BUDGET_MS;
        return {
          storageKey,
          url: null,
          embeddable: true,
          brokerName: input.brokerName,
          source: "DISCOVERED",
          checkedAt: finishedAt,
          unavailable: outOfTime,
        };
      } catch {
        return {
          storageKey,
          url: null,
          embeddable: true,
          brokerName: input.brokerName,
          source: "DISCOVERED",
          checkedAt: deps.now(),
          unavailable: true,
        };
      } finally {
        activeDiscoveries -= 1;
      }
    })();
    inflight.set(storageKey, pending);
    void pending.finally(() => inflight.delete(storageKey)).catch(() => undefined);
  }

  const fresh = await pending;
  // a look that failed must not wipe out an address found earlier
  if (fresh.unavailable && known?.url) {
    if (retryAfter.size >= MAX_MEMORY_ENTRIES) {
      const oldest = retryAfter.keys().next().value;
      if (oldest !== undefined) retryAfter.delete(oldest);
    }
    retryAfter.set(storageKey, deps.now() + UNAVAILABLE_FRESH_MS);
    return toInfo(serverKey, known);
  }
  retryAfter.delete(storageKey);
  remember(fresh);
  if (!fresh.unavailable) await writeStored(store, fresh, deps.now());
  return toInfo(serverKey, fresh);
}
