"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ExternalLink } from "lucide-react";
import { EmptyState, InlineStatusStrip, Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { SelectField } from "@/components/app/FormFields";
import { queryKeys } from "@/lib/data/queryKeys";

type CalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  eventTime: string;
  endTime: string | null;
  timezone: string;
  eventType: "ECONOMIC" | "WEBINAR" | "ACADEMY" | "PLATFORM" | "OTHER";
  locationUrl: string | null;
  currency: string;
  impact: "LOW" | "MEDIUM" | "HIGH";
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  source: string | null;
  category: string | null;
};

const typeTone: Record<CalendarEvent["eventType"], "lime" | "accent" | "danger" | "muted"> = {
  ECONOMIC: "danger",
  WEBINAR: "accent",
  ACADEMY: "lime",
  PLATFORM: "muted",
  OTHER: "muted",
};

const dateKey = (iso: string) => new Date(iso).toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const compactDayLabel = (iso: string, now: number) => {
  const eventDate = new Date(iso);
  const today = new Date(now);
  const sameDay =
    eventDate.getFullYear() === today.getFullYear() &&
    eventDate.getMonth() === today.getMonth() &&
    eventDate.getDate() === today.getDate();

  const label = eventDate.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return sameDay ? `Today: ${label}` : label;
};

const impactClass: Record<CalendarEvent["impact"], string> = {
  HIGH: "border-danger/35 bg-danger/15 text-danger",
  MEDIUM: "border-accent/35 bg-accent/12 text-accent",
  LOW: "border-line bg-panel-strong text-muted",
};

const impactDots: Record<CalendarEvent["impact"], number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function numericTone(value: string | null): string {
  if (!value) return "text-muted";
  if (value.trim().startsWith("-")) return "text-danger";
  return "text-accent-2";
}

export default function TraderCalendarPage() {
  const [type, setType] = useState<"ALL" | CalendarEvent["eventType"]>("ALL");
  const [impact, setImpact] = useState<"ALL" | CalendarEvent["impact"]>("ALL");
  const { data: events = [], isLoading, isError } = useQuery<CalendarEvent[]>({
    queryKey: queryKeys.economicCalendar,
    queryFn: async () => {
      const response = await fetch("/api/economic-calendar");
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load calendar");
      return json.data;
    },
  });

  const [now] = useState(() => Date.now());
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (type === "ALL" || event.eventType === type) &&
          (impact === "ALL" || event.impact === impact),
      ),
    [events, impact, type],
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();
    for (const event of filtered) {
      const key = dateKey(event.eventTime);
      grouped.set(key, [...(grouped.get(key) ?? []), event]);
    }
    return Array.from(grouped.entries());
  }, [filtered]);
  const upcoming = events.filter((event) => new Date(event.endTime ?? event.eventTime).getTime() >= now).length;
  const nextEvent = events.find((event) => new Date(event.endTime ?? event.eventTime).getTime() >= now);

  return (
    <WorkspacePage
      eyebrow="Schedule"
      title="Economic news calendar"
      description="FRED-powered macro release dates organized in a trader-friendly calendar view."
    >
      <InlineStatusStrip
        items={[
          { label: "Published events", value: events.length },
          { label: "Upcoming", value: upcoming, tone: "accent" },
          { label: "Next event", value: nextEvent ? new Date(nextEvent.eventTime).toLocaleDateString() : "None", tone: nextEvent ? "lime" : undefined },
        ]}
      />

      <Panel className="mt-5">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Market news schedule</h2>
            <p className="mt-1 text-sm text-muted">Grouped like a trading news calendar. FRED provides release dates; exact intraday times are shown when available.</p>
          </div>
          <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-2">
            <div className="min-w-[180px]">
              <SelectField label="Event type" value={type} onChange={(event) => setType(event.target.value as typeof type)}>
                <option value="ALL">All events</option>
                <option value="ECONOMIC">Economic</option>
                <option value="WEBINAR">Webinars</option>
                <option value="ACADEMY">Academy</option>
                <option value="PLATFORM">Platform</option>
                <option value="OTHER">Other</option>
              </SelectField>
            </div>
            <div className="min-w-[180px]">
              <SelectField label="Impact" value={impact} onChange={(event) => setImpact(event.target.value as typeof impact)}>
                <option value="ALL">All impact</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </SelectField>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-line bg-background px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
            <span className="text-accent">{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span>Calendar stream</span>
            <span className="rounded-[4px] border border-line bg-panel px-2 py-1">FRED + WSA</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger" /> High</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-accent" /> Medium</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-muted" /> Low</span>
          </div>
        </div>

        <div className="mt-5">
          {isLoading ? (
            <div className="grid gap-3">
              {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-[4px] border border-line bg-background" />)}
            </div>
          ) : isError ? (
            <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-4 text-sm text-danger">
              The published calendar could not be loaded. Please try again shortly.
            </div>
          ) : groups.length === 0 ? (
            <EmptyState
              title="No published events"
              description={type === "ALL" ? "WSA Global has not published any calendar events yet." : "There are no published events for this category."}
            />
          ) : (
            <div className="space-y-6">
              {groups.map(([date, dayEvents]) => (
                <section key={date}>
                  <div className="mb-0 flex items-center justify-between gap-3 border border-line bg-panel-strong px-4 py-3 text-sm font-semibold text-foreground">
                    <span className="inline-flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-accent" />
                      {compactDayLabel(dayEvents[0]?.eventTime ?? new Date().toISOString(), now)}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">{dayEvents.length} events</span>
                  </div>
                  <div className="overflow-x-auto border-x border-b border-line">
                    <table className="w-full min-w-[1120px] table-fixed text-left text-sm">
                      <thead className="bg-background text-[10px] uppercase tracking-[0.18em] text-muted">
                        <tr>
                          <th className="w-[86px] px-3 py-3">Time</th>
                          <th className="w-[86px] px-3 py-3">Currency</th>
                          <th className="w-[90px] px-3 py-3">Impact</th>
                          <th className="px-3 py-3">Event</th>
                          <th className="w-[72px] px-3 py-3">Alert</th>
                          <th className="w-[92px] px-3 py-3">Detail</th>
                          <th className="w-[100px] px-3 py-3">Actual</th>
                          <th className="w-[100px] px-3 py-3">Forecast</th>
                          <th className="w-[100px] px-3 py-3">Previous</th>
                          <th className="w-[86px] px-3 py-3">Graph</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {dayEvents.map((event) => {
                          const timeLabel =
                            event.source === "FRED"
                              ? "All Day"
                              : new Date(event.eventTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                          const dotCount = impactDots[event.impact];
                          return (
                            <tr key={event.id} className="bg-panel/35 text-[13px] transition hover:bg-accent/[0.04]">
                              <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-muted">{timeLabel}</td>
                              <td className="whitespace-nowrap px-3 py-2.5">
                                <span className="inline-flex min-w-12 justify-center rounded-[4px] border border-line bg-background px-2 py-1 text-xs font-bold text-foreground">
                                  {event.currency}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2.5">
                                <span className={`inline-flex items-center gap-1 rounded-[4px] border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${impactClass[event.impact]}`}>
                                  {Array.from({ length: 3 }, (_, index) => (
                                    <span
                                      key={index}
                                      className={`h-2 w-1.5 rounded-[2px] ${index < dotCount ? "bg-current" : "bg-current/20"}`}
                                    />
                                  ))}
                                  {event.impact}
                                </span>
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="min-w-0">
                                  <p className="truncate font-semibold text-foreground">{event.title}</p>
                                  <p className="mt-0.5 truncate text-xs text-muted">{event.category ?? event.eventType}</p>
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2.5">
                                <span className={event.impact === "HIGH" ? "text-danger" : event.impact === "MEDIUM" ? "text-accent" : "text-muted"}>
                                  {event.impact === "HIGH" ? "Watch" : event.impact === "MEDIUM" ? "Note" : "Low"}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2.5">
                                {event.locationUrl ? (
                                  <a href={event.locationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">
                                    Detail <ExternalLink className="h-3 w-3" />
                                  </a>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                              <td className={`whitespace-nowrap px-3 py-2.5 font-semibold ${numericTone(event.actual)}`}>{event.actual ?? "—"}</td>
                              <td className="whitespace-nowrap px-3 py-2.5 text-muted">{event.forecast ?? "—"}</td>
                              <td className="whitespace-nowrap px-3 py-2.5 text-muted">{event.previous ?? "—"}</td>
                              <td className="whitespace-nowrap px-3 py-2.5">
                                {event.locationUrl ? (
                                  <a href={event.locationUrl} target="_blank" rel="noreferrer" className="font-semibold text-muted hover:text-accent">
                                    Graph
                                  </a>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel className="mt-5">
        <div className="flex items-start gap-3 text-sm leading-6 text-muted">
          <CalendarDays className="mt-1 h-4 w-4 shrink-0 text-accent" />
          <p>
            FRED release-calendar rows are date-level economic events. WSA filters the feed to macro releases and
            classifies likely impact for trading context; manual WSA events can still include exact times, actual,
            forecast, and previous values.
          </p>
        </div>
      </Panel>
    </WorkspacePage>
  );
}
