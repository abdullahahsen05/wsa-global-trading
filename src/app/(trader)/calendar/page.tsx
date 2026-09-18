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
        <div className="flex flex-wrap items-end justify-between gap-4">
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
                  <div className="mb-0 flex items-center gap-2 border border-line bg-panel-strong px-4 py-3 text-sm font-semibold text-foreground">
                    <CalendarDays className="h-4 w-4 text-accent" />
                    {date}
                  </div>
                  <div className="overflow-x-auto border-x border-b border-line">
                    <table className="w-full min-w-[980px] table-fixed text-left text-sm">
                      <thead className="bg-background text-[10px] uppercase tracking-[0.18em] text-muted">
                        <tr>
                          <th className="w-[90px] px-4 py-3">Time</th>
                          <th className="w-[95px] px-4 py-3">Currency</th>
                          <th className="w-[105px] px-4 py-3">Impact</th>
                          <th className="px-4 py-3">Event</th>
                          <th className="w-[105px] px-4 py-3">Actual</th>
                          <th className="w-[105px] px-4 py-3">Forecast</th>
                          <th className="w-[105px] px-4 py-3">Previous</th>
                          <th className="w-[120px] px-4 py-3">Source</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {dayEvents.map((event) => {
                          const timeLabel =
                            event.source === "FRED"
                              ? "Date"
                              : new Date(event.eventTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                          return (
                            <tr key={event.id} className="bg-panel/35 transition hover:bg-accent/[0.04]">
                              <td className="whitespace-nowrap px-4 py-3 font-semibold text-muted">{timeLabel}</td>
                              <td className="whitespace-nowrap px-4 py-3 font-semibold text-foreground">{event.currency}</td>
                              <td className="whitespace-nowrap px-4 py-3">
                                <StatusPill tone={event.impact === "HIGH" ? "danger" : event.impact === "MEDIUM" ? "accent" : "muted"}>{event.impact}</StatusPill>
                              </td>
                              <td className="px-4 py-3">
                                <div className="min-w-0">
                                  <p className="truncate font-semibold text-foreground">{event.title}</p>
                                  <p className="mt-1 truncate text-xs text-muted">{event.category ?? event.eventType}</p>
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-4 py-3 text-muted">{event.actual ?? "—"}</td>
                              <td className="whitespace-nowrap px-4 py-3 text-muted">{event.forecast ?? "—"}</td>
                              <td className="whitespace-nowrap px-4 py-3 text-muted">{event.previous ?? "—"}</td>
                              <td className="whitespace-nowrap px-4 py-3">
                                {event.locationUrl ? (
                                  <a href={event.locationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">
                                    {event.source ?? "Open"} <ExternalLink className="h-3 w-3" />
                                  </a>
                                ) : (
                                  <span className="text-muted">{event.source ?? "WSA"}</span>
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
