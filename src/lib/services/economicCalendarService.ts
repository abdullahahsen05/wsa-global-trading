import { createAdminClient } from "@/lib/supabase/admin";
import { fetchFredEconomicEvents } from "@/lib/services/fredCalendarService";

// ─────────────────────────────────────────────────────────────────────────────
// Economic Calendar Service (server-only)
//
// Reads are server-side via the admin client (the table is readable by any
// active user per RLS; using the admin client here is consistent with other
// services such as getDailyPnl). Writes are admin-gated at the route layer.
// ─────────────────────────────────────────────────────────────────────────────

export type EconomicImpact = "LOW" | "MEDIUM" | "HIGH";
export type CalendarEventStatus = "DRAFT" | "PUBLISHED" | "CANCELLED";
export type CalendarAudience = "ALL" | "TRADER";
export type CalendarEventType = "ECONOMIC" | "WEBINAR" | "ACADEMY" | "PLATFORM" | "OTHER";

export interface EconomicEventDto {
  id: string;
  title: string;
  countryCode: string | null;
  currency: string;
  impact: EconomicImpact;
  eventTime: string;
  endTime: string | null;
  timezone: string;
  eventType: CalendarEventType;
  locationUrl: string | null;
  status: CalendarEventStatus;
  audience: CalendarAudience;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  source: string | null;
  description: string | null;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventRow {
  id: string;
  title: string;
  country_code: string | null;
  currency: string;
  impact: EconomicImpact;
  event_time: string;
  end_time: string | null;
  timezone: string;
  event_type: CalendarEventType;
  location_url: string | null;
  status: CalendarEventStatus;
  audience: CalendarAudience;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  source: string | null;
  description: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  "id, title, country_code, currency, impact, event_time, end_time, timezone, event_type, location_url, status, audience, actual, forecast, previous, source, description, category, created_at, updated_at";

function mapEvent(row: EventRow): EconomicEventDto {
  return {
    id: row.id,
    title: row.title,
    countryCode: row.country_code,
    currency: row.currency,
    impact: row.impact,
    eventTime: row.event_time,
    endTime: row.end_time,
    timezone: row.timezone,
    eventType: row.event_type,
    locationUrl: row.location_url,
    status: row.status,
    audience: row.audience,
    actual: row.actual,
    forecast: row.forecast,
    previous: row.previous,
    source: row.source,
    description: row.description,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function byEventTimeAscending(left: EconomicEventDto, right: EconomicEventDto): number {
  return new Date(left.eventTime).getTime() - new Date(right.eventTime).getTime();
}

function byEventTimeDescending(left: EconomicEventDto, right: EconomicEventDto): number {
  return new Date(right.eventTime).getTime() - new Date(left.eventTime).getTime();
}

async function withFredEvents(
  manualEvents: EconomicEventDto[],
  params?: { from?: Date; to?: Date; limit?: number; sort?: "asc" | "desc" },
): Promise<EconomicEventDto[]> {
  let fredEvents: EconomicEventDto[] = [];
  try {
    fredEvents = await fetchFredEconomicEvents({
      from: params?.from,
      to: params?.to,
      limit: params?.limit,
    });
  } catch {
    fredEvents = [];
  }

  const merged = new Map<string, EconomicEventDto>();
  for (const event of fredEvents) merged.set(event.id, event);
  for (const event of manualEvents) merged.set(event.id, event);
  const list = Array.from(merged.values()).sort(
    params?.sort === "desc" ? byEventTimeDescending : byEventTimeAscending,
  );
  return list.slice(0, params?.limit ?? 200);
}

/**
 * Upcoming events for a set of currencies within a time window.
 * Used to build AI news-context for a trader's active pairs.
 */
export async function listUpcomingEvents(params: {
  currencies: string[];
  fromIso: string;
  toIso: string;
  impacts?: EconomicImpact[];
  limit?: number;
}): Promise<EconomicEventDto[]> {
  if (params.currencies.length === 0) return [];
  const supabase = createAdminClient();

  let query = supabase
    .from("economic_calendar_events")
    .select(SELECT_COLS)
    .in("currency", params.currencies)
    .eq("status", "PUBLISHED")
    .in("audience", ["ALL", "TRADER"])
    .gte("event_time", params.fromIso)
    .lte("event_time", params.toIso)
    .order("event_time", { ascending: true })
    .limit(params.limit ?? 50);

  if (params.impacts && params.impacts.length > 0) {
    query = query.in("impact", params.impacts);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch economic events: ${error.message}`);
  const manualEvents = (data ?? []).map(mapEvent);
  const from = new Date(params.fromIso);
  const to = new Date(params.toIso);
  const merged = await withFredEvents(manualEvents, {
    from,
    to,
    limit: params.limit ?? 50,
  });
  return merged.filter((event) => {
    const inCurrency = params.currencies.includes(event.currency);
    const inImpact = !params.impacts?.length || params.impacts.includes(event.impact);
    const eventTime = new Date(event.eventTime).getTime();
    return inCurrency && inImpact && eventTime >= from.getTime() && eventTime <= to.getTime();
  });
}

/**
 * Full list for the admin management page (most recent / upcoming first).
 */
export async function listEvents(limit = 200): Promise<EconomicEventDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("economic_calendar_events")
    .select(SELECT_COLS)
    .order("event_time", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to fetch economic events: ${error.message}`);
  return withFredEvents((data ?? []).map(mapEvent), { limit, sort: "desc" });
}

export async function listPublishedEvents(params?: {
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<EconomicEventDto[]> {
  const supabase = createAdminClient();
  const from = params?.from;
  const to = params?.to;
  const limit = params?.limit ?? 200;
  let query = supabase
    .from("economic_calendar_events")
    .select(SELECT_COLS)
    .eq("status", "PUBLISHED")
    .in("audience", ["ALL", "TRADER"])
    .order("event_time", { ascending: true });

  if (from) query = query.gte("event_time", from.toISOString());
  if (to) query = query.lte("event_time", to.toISOString());

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`Failed to fetch calendar events: ${error.message}`);
  const merged = await withFredEvents((data ?? []).map(mapEvent), {
    from,
    to,
    limit,
    sort: "asc",
  });

  return merged.filter((event) => {
    const eventTime = new Date(event.eventTime).getTime();
    const afterStart = !from || eventTime >= from.getTime();
    const beforeEnd = !to || eventTime <= to.getTime();
    return afterStart && beforeEnd;
  });
}

export interface EconomicEventInput {
  title: string;
  countryCode?: string | null;
  currency: string;
  impact: EconomicImpact;
  eventTime: string;
  endTime?: string | null;
  timezone?: string;
  eventType?: CalendarEventType;
  locationUrl?: string | null;
  status?: CalendarEventStatus;
  audience?: CalendarAudience;
  actual?: string | null;
  forecast?: string | null;
  previous?: string | null;
  source?: string | null;
  description?: string | null;
  category?: string | null;
}

export async function createEvent(input: EconomicEventInput, createdBy?: string): Promise<EconomicEventDto> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("economic_calendar_events")
    .insert({
      title: input.title,
      country_code: input.countryCode ?? null,
      currency: input.currency,
      impact: input.impact,
      event_time: input.eventTime,
      end_time: input.endTime ?? null,
      timezone: input.timezone ?? "UTC",
      event_type: input.eventType ?? "ECONOMIC",
      location_url: input.locationUrl ?? null,
      status: input.status ?? "DRAFT",
      audience: input.audience ?? "ALL",
      created_by: createdBy ?? null,
      actual: input.actual ?? null,
      forecast: input.forecast ?? null,
      previous: input.previous ?? null,
      source: input.source ?? null,
      description: input.description ?? null,
      category: input.category ?? null,
    })
    .select(SELECT_COLS)
    .single();
  if (error || !data) throw new Error(`Failed to create economic event: ${error?.message}`);
  return mapEvent(data);
}

export async function updateEvent(
  id: string,
  input: Partial<EconomicEventInput>,
): Promise<EconomicEventDto> {
  const supabase = createAdminClient();
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.countryCode !== undefined) patch.country_code = input.countryCode;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.impact !== undefined) patch.impact = input.impact;
  if (input.eventTime !== undefined) patch.event_time = input.eventTime;
  if (input.endTime !== undefined) patch.end_time = input.endTime;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.eventType !== undefined) patch.event_type = input.eventType;
  if (input.locationUrl !== undefined) patch.location_url = input.locationUrl;
  if (input.status !== undefined) patch.status = input.status;
  if (input.audience !== undefined) patch.audience = input.audience;
  if (input.actual !== undefined) patch.actual = input.actual;
  if (input.forecast !== undefined) patch.forecast = input.forecast;
  if (input.previous !== undefined) patch.previous = input.previous;
  if (input.source !== undefined) patch.source = input.source;
  if (input.description !== undefined) patch.description = input.description;
  if (input.category !== undefined) patch.category = input.category;

  const { data, error } = await supabase
    .from("economic_calendar_events")
    .update(patch)
    .eq("id", id)
    .select(SELECT_COLS)
    .single();
  if (error || !data) throw new Error(`Failed to update economic event: ${error?.message}`);
  return mapEvent(data);
}

export async function deleteEvent(id: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("economic_calendar_events").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete economic event: ${error.message}`);
}
