"use client";

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ExternalLink } from "lucide-react";
import { EmptyState, InlineStatusStrip, Panel, WorkspacePage } from "@/components/app/WorkspaceUI";
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

const dateKey = (iso: string) => new Date(iso).toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const shortDateLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
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

const impactBlockClass: Record<CalendarEvent["impact"], string> = {
  HIGH: "bg-danger",
  MEDIUM: "bg-accent",
  LOW: "bg-muted",
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
  const filteredHighImpact = filtered.filter((event) => event.impact === "HIGH").length;

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
            <h2 className="text-lg font-semibold text-foreground">Calendar</h2>
            <p className="mt-1 text-sm text-muted">ForexFactory-style macro calendar using FRED releases and WSA events.</p>
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

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-t-[4px] border border-line bg-panel-strong px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
            <span className="text-accent">{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span>Today: {shortDateLabel(new Date(now).toISOString()).replace(/^[^,]+,?\s*/, "")}</span>
            <span className="rounded-[3px] border border-line bg-background px-2 py-1">Filter</span>
            <span className="rounded-[3px] border border-line bg-background px-2 py-1">FRED + WSA</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{filtered.length} events</span>
            <span className="text-danger">{filteredHighImpact} high impact</span>
          </div>
        </div>

        <div>
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
            <div className="overflow-x-auto border-x border-b border-line">
              <table className="w-full min-w-[1120px] table-fixed border-collapse text-left text-[12px]">
                <thead className="bg-[#111417] text-[10px] uppercase tracking-[0.16em] text-muted">
                  <tr>
                    <th className="w-[112px] border-b border-line px-2 py-2">Date</th>
                    <th className="w-[84px] border-b border-line px-2 py-2">Time</th>
                    <th className="w-[78px] border-b border-line px-2 py-2">Currency</th>
                    <th className="w-[82px] border-b border-line px-2 py-2">Impact</th>
                    <th className="border-b border-line px-2 py-2">Event</th>
                    <th className="w-[66px] border-b border-line px-2 py-2 text-center">Alerts</th>
                    <th className="w-[70px] border-b border-line px-2 py-2 text-center">Detail</th>
                    <th className="w-[96px] border-b border-line px-2 py-2 text-right">Actual</th>
                    <th className="w-[96px] border-b border-line px-2 py-2 text-right">Forecast</th>
                    <th className="w-[96px] border-b border-line px-2 py-2 text-right">Previous</th>
                    <th className="w-[70px] border-b border-line px-2 py-2 text-center">Graph</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(([date, dayEvents]) => (
                    <Fragment key={date}>
                      <tr className="bg-background/80">
                        <td colSpan={11} className="border-b border-line px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-accent">
                          <span className="inline-flex items-center gap-2">
                            <CalendarDays className="h-3.5 w-3.5" />
                            {compactDayLabel(dayEvents[0]?.eventTime ?? new Date().toISOString(), now)}
                          </span>
                          <span className="ml-3 text-muted">{dayEvents.length} events</span>
                        </td>
                      </tr>
                      {dayEvents.map((event, index) => {
                        const timeLabel =
                          event.source === "FRED"
                            ? "All Day"
                            : new Date(event.eventTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                        const dotCount = impactDots[event.impact];
                        return (
                          <tr key={event.id} className="group bg-panel/35 transition hover:bg-accent/[0.05]">
                            <td className="border-b border-line px-2 py-2 align-middle font-semibold text-muted">
                              {index === 0 ? shortDateLabel(event.eventTime) : ""}
                            </td>
                            <td className="border-b border-line px-2 py-2 align-middle font-semibold text-foreground">{timeLabel}</td>
                            <td className="border-b border-line px-2 py-2 align-middle font-bold text-foreground">{event.currency}</td>
                            <td className="border-b border-line px-2 py-2 align-middle">
                              <div className="flex items-end gap-0.5" title={`${event.impact} impact`}>
                                {Array.from({ length: 3 }, (_, dotIndex) => (
                                  <span
                                    key={dotIndex}
                                    className={`block h-3 w-2 rounded-[1px] ${dotIndex < dotCount ? impactBlockClass[event.impact] : "bg-line"}`}
                                  />
                                ))}
                              </div>
                            </td>
                            <td className="border-b border-line px-2 py-2 align-middle">
                              <p className="truncate font-semibold text-foreground">{event.title}</p>
                              <p className="mt-0.5 truncate text-[11px] text-muted">{event.category ?? event.eventType}</p>
                            </td>
                            <td className="border-b border-line px-2 py-2 text-center align-middle">
                              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-[3px] border text-[11px] font-bold ${event.impact === "HIGH" ? "border-danger/40 text-danger" : event.impact === "MEDIUM" ? "border-accent/40 text-accent" : "border-line text-muted"}`}>
                                !
                              </span>
                            </td>
                            <td className="border-b border-line px-2 py-2 text-center align-middle">
                              {event.locationUrl ? (
                                <a href={event.locationUrl} target="_blank" rel="noreferrer" className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] border border-line bg-background font-bold text-accent hover:border-accent">
                                  i
                                </a>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                            <td className={`border-b border-line px-2 py-2 text-right align-middle font-bold ${numericTone(event.actual)}`}>{event.actual ?? "—"}</td>
                            <td className="border-b border-line px-2 py-2 text-right align-middle text-muted">{event.forecast ?? "—"}</td>
                            <td className="border-b border-line px-2 py-2 text-right align-middle text-muted">{event.previous ?? "—"}</td>
                            <td className="border-b border-line px-2 py-2 text-center align-middle">
                              {event.locationUrl ? (
                                <a href={event.locationUrl} target="_blank" rel="noreferrer" className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] border border-line bg-background text-muted hover:border-accent hover:text-accent">
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
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
