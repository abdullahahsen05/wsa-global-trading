import type { EconomicEventDto, EconomicImpact } from "@/lib/services/economicCalendarService";

const FRED_API_BASE = "https://api.stlouisfed.org/fred";
const FRED_API_KEY = process.env.FRED_API_KEY ?? "";

type FredReleaseDate = {
  release_id: number;
  release_name: string;
  release_last_updated?: string;
  date: string;
};

type FredReleaseDatesResponse = {
  release_dates?: FredReleaseDate[];
};

const HIGH_IMPACT_PATTERNS = [
  /fomc|federal open market/i,
  /gross domestic product|\bgdp\b/i,
  /employment situation|nonfarm|payroll|unemployment/i,
  /consumer price index|\bcpi\b|personal consumption expenditures|\bpce\b/i,
  /producer price index|\bppi\b/i,
  /retail sales/i,
  /industrial production/i,
  /ism|pmi/i,
  /personal income/i,
];

const MEDIUM_IMPACT_PATTERNS = [
  /housing|home sales|construction|building permits|starts/i,
  /manufacturing|durable goods|factory orders|business inventories/i,
  /trade balance|imports|exports/i,
  /job openings|jolts|claims/i,
  /interest rate|treasury|yield|federal funds|reserve/i,
  /consumer credit|consumer sentiment|confidence/i,
  /chicago fed|philadelphia fed|empire state|beige book/i,
  /monetary|money stock|commercial paper/i,
  /inflation|price|wage/i,
];

const EXCLUDED_PATTERNS = [
  /coinbase|cryptocurrenc/i,
  /dow jones|cboe|ice bofa|market statistics|stock market/i,
  /bank rate monitor/i,
  /historical overnight|ameribor/i,
  /daily treasury/i,
  /weekly treasury/i,
];

function classifyImpact(name: string): EconomicImpact | null {
  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(name))) return null;
  if (HIGH_IMPACT_PATTERNS.some((pattern) => pattern.test(name))) return "HIGH";
  if (MEDIUM_IMPACT_PATTERNS.some((pattern) => pattern.test(name))) return "MEDIUM";
  return null;
}

function inferCurrency(name: string): { currency: string; countryCode: string | null } {
  if (/euro|european|ecb/i.test(name)) return { currency: "EUR", countryCode: "EU" };
  if (/japan|japanese/i.test(name)) return { currency: "JPY", countryCode: "JP" };
  if (/canada|canadian/i.test(name)) return { currency: "CAD", countryCode: "CA" };
  if (/united kingdom|\buk\b|britain|british/i.test(name)) return { currency: "GBP", countryCode: "GB" };
  if (/switzerland|swiss/i.test(name)) return { currency: "CHF", countryCode: "CH" };
  if (/australia|australian/i.test(name)) return { currency: "AUD", countryCode: "AU" };
  if (/new zealand/i.test(name)) return { currency: "NZD", countryCode: "NZ" };
  return { currency: "USD", countryCode: "US" };
}

function categoryFor(name: string): string {
  if (/fomc|federal funds|interest rate|monetary|treasury|reserve/i.test(name)) return "Monetary policy";
  if (/consumer price|producer price|inflation|pce|price/i.test(name)) return "Inflation";
  if (/employment|unemployment|payroll|claims|job openings|jolts|wage/i.test(name)) return "Labor";
  if (/gdp|personal income|retail sales|industrial production|durable goods|factory/i.test(name)) return "Growth";
  if (/housing|home sales|construction|building permits|starts/i.test(name)) return "Housing";
  if (/trade|imports|exports/i.test(name)) return "Trade";
  return "Economic release";
}

function eventTimeFromFredDate(date: string): string {
  // FRED release-calendar rows are date-level events. Use noon UTC so sorting is stable
  // without pretending FRED supplied an exact intraday release time.
  return `${date}T12:00:00.000Z`;
}

function fredTimestampToIso(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function mapFredRelease(row: FredReleaseDate): EconomicEventDto | null {
  const impact = classifyImpact(row.release_name);
  if (!impact) return null;
  const { currency, countryCode } = inferCurrency(row.release_name);
  const now = new Date().toISOString();
  const category = categoryFor(row.release_name);

  return {
    id: `fred-${row.release_id}-${row.date}`,
    title: row.release_name,
    countryCode,
    currency,
    impact,
    eventTime: eventTimeFromFredDate(row.date),
    endTime: null,
    timezone: "UTC",
    eventType: "ECONOMIC",
    locationUrl: `https://fred.stlouisfed.org/release?rid=${row.release_id}`,
    status: "PUBLISHED",
    audience: "ALL",
    actual: null,
    forecast: null,
    previous: null,
    source: "FRED",
    description: `FRED economic release date. ${row.release_last_updated ? `Last updated by source: ${row.release_last_updated}.` : "Exact release time is not supplied by FRED."}`,
    category,
    createdAt: now,
    updatedAt: fredTimestampToIso(row.release_last_updated, now),
  };
}

function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function fetchFredEconomicEvents(params?: {
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<EconomicEventDto[]> {
  if (!FRED_API_KEY) return [];

  const from = params?.from ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const to = params?.to ?? new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
  const limit = params?.limit ?? 1000;

  const search = new URLSearchParams({
    api_key: FRED_API_KEY,
    file_type: "json",
    realtime_start: isoDateOnly(from),
    realtime_end: isoDateOnly(to),
    sort_order: "asc",
    order_by: "release_date",
    include_release_dates_with_no_data: "true",
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });

  const response = await fetch(`${FRED_API_BASE}/releases/dates?${search.toString()}`, {
    next: { revalidate: 60 * 60 },
  });

  if (!response.ok) {
    throw new Error(`FRED calendar request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as FredReleaseDatesResponse;
  const unique = new Map<string, EconomicEventDto>();
  for (const row of payload.release_dates ?? []) {
    const mapped = mapFredRelease(row);
    if (!mapped) continue;
    unique.set(mapped.id, mapped);
  }

  return Array.from(unique.values()).sort(
    (left, right) => new Date(left.eventTime).getTime() - new Date(right.eventTime).getTime(),
  );
}
