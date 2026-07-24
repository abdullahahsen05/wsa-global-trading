"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Clock3, ExternalLink, MapPin } from "lucide-react";
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
    () => events.filter((event) => type === "ALL" || event.eventType === type),
    [events, type],
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
      title="Calendar"
      description="Published market events, academy sessions, webinars, and platform notices from WSA Global."
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
            <h2 className="text-lg font-semibold text-foreground">Event schedule</h2>
            <p className="mt-1 text-sm text-muted">Times are displayed in your device timezone; each event also shows its source timezone.</p>
          </div>
          <div className="w-full sm:w-56">
            <SelectField label="Event type" value={type} onChange={(event) => setType(event.target.value as typeof type)}>
              <option value="ALL">All events</option>
              <option value="ECONOMIC">Economic</option>
              <option value="WEBINAR">Webinars</option>
              <option value="ACADEMY">Academy</option>
              <option value="PLATFORM">Platform</option>
              <option value="OTHER">Other</option>
            </SelectField>
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
            <div className="space-y-7">
              {groups.map(([date, dayEvents]) => (
                <section key={date}>
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CalendarDays className="h-4 w-4 text-accent" />
                    {date}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {dayEvents.map((event) => (
                      <article key={event.id} className="rounded-[4px] border border-line bg-background p-4 transition hover:border-accent/30">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <StatusPill tone={typeTone[event.eventType]}>{event.eventType}</StatusPill>
                            <h3 className="mt-3 text-base font-semibold text-foreground">{event.title}</h3>
                          </div>
                          {event.eventType === "ECONOMIC" ? <StatusPill tone={event.impact === "HIGH" ? "danger" : event.impact === "MEDIUM" ? "accent" : "muted"}>{event.currency} · {event.impact}</StatusPill> : null}
                        </div>
                        {event.description ? <p className="mt-2 text-sm leading-6 text-muted">{event.description}</p> : null}
                        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted">
                          <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{new Date(event.eventTime).toLocaleString()}{event.endTime ? ` - ${new Date(event.endTime).toLocaleString()}` : ""} · {event.timezone}</span>
                          {event.locationUrl ? (
                            <a href={event.locationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">
                              <MapPin className="h-3.5 w-3.5" /> Open location <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </Panel>
    </WorkspacePage>
  );
}
