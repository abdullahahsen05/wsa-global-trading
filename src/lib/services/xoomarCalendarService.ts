import type { EconomicEventDto, EconomicImpact } from "@/lib/services/economicCalendarService";

const XOOMAR_CALENDAR_URL = "https://xoomar.com/api/markets/calendar";
const XOOMAR_CALENDAR_PAGE = "https://xoomar.com/markets/calendar";

type XoomarImportance = "high" | "med" | "low";

interface XoomarCalendarRow {
  source?: string;
  eventName?: string;
  importance?: XoomarImportance;
  scheduledAt?: string;
  periodLabel?: string | null;
  previous?: string | null;
  forecast?: string | null;
  actual?: string | null;
  unit?: string | null;
}

interface XoomarCalendarResponse {
  data?: XoomarCalendarRow[];
  updatedAt?: string;
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function impactFromImportance(importance?: XoomarImportance): EconomicImpact {
  if (importance === "high") return "HIGH";
  if (importance === "med") return "MEDIUM";
  return "LOW";
}

function xoomarEventId(row: XoomarCalendarRow): string {
  const eventKey = `${row.source ?? "agency"}-${row.scheduledAt ?? "unknown"}-${row.eventName ?? "release"}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `xoomar-${eventKey}`;
}

function mapXoomarEvent(row: XoomarCalendarRow, updatedAt: string): EconomicEventDto | null {
  if (!row.eventName || !row.scheduledAt || Number.isNaN(new Date(row.scheduledAt).getTime())) return null;

  const unit = row.unit?.trim();
  const period = row.periodLabel?.trim();
  const source = row.source?.trim().toUpperCase() || "AGENCY";
  const descriptionParts = [
    period ? `Reference period: ${period}.` : null,
    unit ? `Unit: ${unit}.` : null,
    `Published from the ${source} release schedule via Xoomar.`,
  ].filter(Boolean);

  return {
    id: xoomarEventId(row),
    title: row.eventName,
    countryCode: "US",
    currency: "USD",
    impact: impactFromImportance(row.importance),
    eventTime: new Date(row.scheduledAt).toISOString(),
    endTime: null,
    timezone: "UTC",
    eventType: "ECONOMIC",
    locationUrl: XOOMAR_CALENDAR_PAGE,
    status: "PUBLISHED",
    audience: "ALL",
    actual: row.actual?.trim() || null,
    forecast: row.forecast?.trim() || null,
    previous: row.previous?.trim() || null,
    source: "XOOMAR",
    description: descriptionParts.join(" "),
    category: period || source,
    createdAt: updatedAt,
    updatedAt,
  };
}

/**
 * Fetches Xoomar's agency-scheduled U.S. macro calendar. The key is optional
 * for the provider, but remains server-only when configured to raise the
 * platform-wide request limit. Never call this directly from a browser.
 */
export async function fetchXoomarEconomicEvents(params?: {
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<EconomicEventDto[]> {
  const query = new URLSearchParams();
  if (params?.from) query.set("from", toDateOnly(params.from));
  if (params?.to) query.set("to", toDateOnly(params.to));

  const headers = new Headers({ Accept: "application/json" });
  if (process.env.XOOMAR_API_KEY) headers.set("X-API-Key", process.env.XOOMAR_API_KEY);

  const response = await fetch(`${XOOMAR_CALENDAR_URL}${query.size ? `?${query.toString()}` : ""}`, {
    headers,
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    throw new Error(`Xoomar calendar request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as XoomarCalendarResponse;
  const updatedAt = !payload.updatedAt || Number.isNaN(new Date(payload.updatedAt).getTime())
    ? new Date().toISOString()
    : new Date(payload.updatedAt).toISOString();
  const unique = new Map<string, EconomicEventDto>();

  for (const row of payload.data ?? []) {
    const event = mapXoomarEvent(row, updatedAt);
    if (event) unique.set(event.id, event);
  }

  return Array.from(unique.values())
    .sort((left, right) => new Date(left.eventTime).getTime() - new Date(right.eventTime).getTime())
    .slice(0, params?.limit ?? 200);
}
