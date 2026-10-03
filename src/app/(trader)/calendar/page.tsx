"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, X } from "lucide-react";
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

type DateRange = "UPCOMING" | "TODAY" | "THIS_WEEK" | "NEXT_30" | "ALL";

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

function hasEventValue(value: string | null): boolean {
  return Boolean(value?.trim());
}

function comparableNumber(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*([KMB])?\s*%?$/i);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multiplier = match[2]?.toUpperCase() === "K"
    ? 1_000
    : match[2]?.toUpperCase() === "M"
      ? 1_000_000
      : match[2]?.toUpperCase() === "B"
        ? 1_000_000_000
        : 1;
  return base * multiplier;
}

function canCompareRelease(event: CalendarEvent): boolean {
  return comparableNumber(event.actual) !== null && comparableNumber(event.previous) !== null;
}

function formatEventTime(event: CalendarEvent): string {
  const timeZone = event.timezone || undefined;
  const time = new Date(event.eventTime).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
  if (timeZone === "America/Chicago") return `${time} CT`;
  if (timeZone === "UTC") return `${time} UTC`;
  return time;
}

function startOfLocalDay(timestamp: number): Date {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfLocalDay(timestamp: number): Date {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function rangeLabel(range: DateRange): string {
  if (range === "TODAY") return "Today";
  if (range === "THIS_WEEK") return "Next 7 days";
  if (range === "NEXT_30") return "Next 30 days";
  if (range === "ALL") return "All dates";
  return "Upcoming";
}

export default function TraderCalendarPage() {
  const [type, setType] = useState<"ALL" | CalendarEvent["eventType"]>("ALL");
  const [impact, setImpact] = useState<"ALL" | CalendarEvent["impact"]>("ALL");
  const [dateRange, setDateRange] = useState<DateRange>("UPCOMING");
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [graphEvent, setGraphEvent] = useState<CalendarEvent | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const calendarWindow = useMemo(() => {
    if (dateRange === "ALL") return { from: null as string | null, to: null as string | null };
    const start = startOfLocalDay(now);
    const end =
      dateRange === "TODAY"
        ? endOfLocalDay(now)
        : dateRange === "THIS_WEEK"
          ? endOfLocalDay(addDays(start, 7).getTime())
          : endOfLocalDay(addDays(start, dateRange === "NEXT_30" ? 30 : 45).getTime());

    return {
      from: start.toISOString(),
      to: end.toISOString(),
    };
  }, [dateRange, now]);
  const { data: events = [], isLoading, isError } = useQuery<CalendarEvent[]>({
    queryKey: [...queryKeys.economicCalendar, calendarWindow.from, calendarWindow.to],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "300" });
      if (calendarWindow.from) params.set("from", calendarWindow.from);
      if (calendarWindow.to) params.set("to", calendarWindow.to);
      const response = await fetch(`/api/economic-calendar?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load calendar");
      return json.data;
    },
    refetchOnWindowFocus: true,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = useMemo(
    () =>
      events
        .filter(
          (event) =>
            (type === "ALL" || event.eventType === type) &&
            (impact === "ALL" || event.impact === impact),
        )
        .sort((left, right) => new Date(left.eventTime).getTime() - new Date(right.eventTime).getTime()),
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
  const showActual = filtered.some((event) => hasEventValue(event.actual));
  const showForecast = filtered.some((event) => hasEventValue(event.forecast));
  const showPrevious = filtered.some((event) => hasEventValue(event.previous));
  const valueColumnCount = [showActual, showForecast, showPrevious].filter(Boolean).length;
  const tableColumnCount = 8 + valueColumnCount;
  const tableMinWidth =
    valueColumnCount === 0
      ? "min-w-[832px]"
      : valueColumnCount === 1
        ? "min-w-[928px]"
        : valueColumnCount === 2
          ? "min-w-[1024px]"
          : "min-w-[1120px]";

  return (
    <WorkspacePage
      eyebrow="Schedule"
      title="Economic news calendar"
      description="Live U.S. macro releases with agency-confirmed timing and published values."
    >
      <InlineStatusStrip
        items={[
          { label: "Published events", value: events.length },
          { label: "Upcoming", value: upcoming, tone: "accent" },
          { label: "Window", value: rangeLabel(dateRange), tone: "lime" },
          { label: "Next event", value: nextEvent ? new Date(nextEvent.eventTime).toLocaleDateString() : "None", tone: nextEvent ? "lime" : undefined },
        ]}
      />

      <Panel className="mt-5">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Calendar</h2>
            <p className="mt-1 text-sm text-muted">Live agency-scheduled U.S. macro releases, with values shown when published.</p>
          </div>
          <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-3">
            <div className="min-w-[180px]">
              <SelectField label="Date range" value={dateRange} onChange={(event) => setDateRange(event.target.value as DateRange)}>
                <option value="UPCOMING">Upcoming</option>
                <option value="TODAY">Today</option>
                <option value="THIS_WEEK">Next 7 days</option>
                <option value="NEXT_30">Next 30 days</option>
                <option value="ALL">All dates</option>
              </SelectField>
            </div>
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
            <span className="rounded-[3px] border border-line bg-background px-2 py-1">{rangeLabel(dateRange)}</span>
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
              description={
                type === "ALL" && impact === "ALL"
                  ? "There are no events in the selected date range yet."
                  : "There are no events matching the selected filters."
              }
            />
          ) : (
            <div className="overflow-x-auto border-x border-b border-line">
              <table className={`w-full ${tableMinWidth} table-fixed border-collapse text-left text-[12px]`}>
                <thead className="bg-[#111417] text-[10px] uppercase tracking-[0.16em] text-muted">
                  <tr>
                    <th className="w-[112px] border-b border-line px-2 py-2">Date</th>
                    <th className="w-[84px] border-b border-line px-2 py-2">Time</th>
                    <th className="w-[78px] border-b border-line px-2 py-2">Currency</th>
                    <th className="w-[82px] border-b border-line px-2 py-2">Impact</th>
                    <th className="border-b border-line px-2 py-2">Event</th>
                    <th className="w-[66px] border-b border-line px-2 py-2 text-center">Impact</th>
                    <th className="w-[76px] border-b border-line px-2 py-2 text-center">Detail</th>
                    {showActual ? <th className="w-[96px] border-b border-line px-2 py-2 text-right">Actual</th> : null}
                    {showForecast ? <th className="w-[96px] border-b border-line px-2 py-2 text-right">Forecast</th> : null}
                    {showPrevious ? <th className="w-[96px] border-b border-line px-2 py-2 text-right">Previous</th> : null}
                    <th className="w-[76px] border-b border-line px-2 py-2 text-center">Graph</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(([date, dayEvents]) => (
                    <Fragment key={date}>
                      <tr className="bg-background/80">
                        <td colSpan={tableColumnCount} className="border-b border-line px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-accent">
                          <span className="inline-flex items-center gap-2">
                            <CalendarDays className="h-3.5 w-3.5" />
                            {compactDayLabel(dayEvents[0]?.eventTime ?? new Date().toISOString(), now)}
                          </span>
                          <span className="ml-3 text-muted">{dayEvents.length} events</span>
                        </td>
                      </tr>
                      {dayEvents.map((event, index) => {
                        const timeLabel = formatEventTime(event);
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
                              <button
                                type="button"
                                onClick={() => setDetailEvent(event)}
                                className="inline-flex h-6 items-center justify-center rounded-[3px] border border-line bg-background px-2 text-[10px] font-bold uppercase tracking-[0.08em] text-accent hover:border-accent hover:text-foreground"
                              >
                                View
                              </button>
                            </td>
                            {showActual ? (
                              <td className={`border-b border-line px-2 py-2 text-right align-middle font-bold ${numericTone(event.actual)}`}>{event.actual ?? "—"}</td>
                            ) : null}
                            {showForecast ? (
                              <td className="border-b border-line px-2 py-2 text-right align-middle text-muted">{event.forecast ?? "—"}</td>
                            ) : null}
                            {showPrevious ? (
                              <td className="border-b border-line px-2 py-2 text-right align-middle text-muted">{event.previous ?? "—"}</td>
                            ) : null}
                            <td className="border-b border-line px-2 py-2 text-center align-middle">
                              <button
                                type="button"
                                onClick={() => setGraphEvent(event)}
                                disabled={!canCompareRelease(event)}
                                title={canCompareRelease(event) ? "Compare the published Actual and Previous values" : "Available after Actual and Previous values are published"}
                                className="inline-flex h-6 items-center justify-center rounded-[3px] border border-line bg-background px-2 text-[10px] font-bold uppercase tracking-[0.08em] text-muted hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-line disabled:hover:text-muted"
                              >
                                Chart
                              </button>
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

      <Dialog.Root open={Boolean(detailEvent)} onOpenChange={(open) => !open && setDetailEvent(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[6px] border border-line bg-panel p-5 shadow-[0_24px_80px_rgba(0,0,0,0.62)] focus:outline-none sm:p-6">
            <Dialog.Title className="pr-10 text-xl font-semibold text-foreground">
              {detailEvent?.title ?? "Event details"}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              {detailEvent ? `${shortDateLabel(detailEvent.eventTime)} · ${formatEventTime(detailEvent)} · ${detailEvent.currency} · ${detailEvent.impact.toLowerCase()} impact` : ""}
            </Dialog.Description>
            {detailEvent ? (
              <div className="mt-5 space-y-5">
                <div className="grid gap-px overflow-hidden rounded-[4px] border border-line bg-line sm:grid-cols-3">
                  {[
                    ["Actual", detailEvent.actual ?? "Not published"],
                    ["Previous", detailEvent.previous ?? "Not published"],
                    ["Forecast", detailEvent.forecast ?? "Not supplied"],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-background px-3 py-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{label}</p>
                      <p className={`mt-1 text-sm font-semibold ${label === "Actual" ? numericTone(detailEvent.actual) : "text-foreground"}`}>{value}</p>
                    </div>
                  ))}
                </div>
                <div className="space-y-3 rounded-[4px] border border-line bg-background p-4 text-sm leading-6 text-muted">
                  <p><span className="font-semibold text-foreground">Reference period:</span> {detailEvent.category ?? "Not supplied"}</p>
                  <p><span className="font-semibold text-foreground">Source:</span> {detailEvent.source ?? "WSA"}</p>
                  <p>{detailEvent.description ?? "No additional source detail is available for this release."}</p>
                </div>
                {detailEvent.locationUrl ? (
                  <a href={detailEvent.locationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center text-sm font-semibold text-accent hover:underline">
                    Open Xoomar calendar source
                  </a>
                ) : null}
              </div>
            ) : null}
            <Dialog.Close aria-label="Close event details" className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-[3px] border border-line bg-background text-muted hover:border-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(graphEvent)} onOpenChange={(open) => !open && setGraphEvent(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-1rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-5 shadow-[0_24px_80px_rgba(0,0,0,0.62)] focus:outline-none sm:p-6">
            <Dialog.Title className="pr-10 text-xl font-semibold text-foreground">
              {graphEvent ? `${graphEvent.title} comparison` : "Release comparison"}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              Actual versus Previous from the published agency release. This is a release comparison, not an invented history chart.
            </Dialog.Description>
            {graphEvent ? (() => {
              const actual = comparableNumber(graphEvent.actual) ?? 0;
              const previous = comparableNumber(graphEvent.previous) ?? 0;
              const maxMagnitude = Math.max(Math.abs(actual), Math.abs(previous), 1);
              const rows = [
                { label: "Actual", value: graphEvent.actual ?? "—", amount: actual, className: numericTone(graphEvent.actual).includes("danger") ? "bg-danger" : "bg-accent" },
                { label: "Previous", value: graphEvent.previous ?? "—", amount: previous, className: "bg-muted" },
              ];
              return (
                <div className="mt-6 space-y-5">
                  {rows.map((row) => (
                    <div key={row.label}>
                      <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold text-foreground">{row.label}</span>
                        <span className="font-mono text-foreground">{row.value}</span>
                      </div>
                      <div className="h-3 overflow-hidden rounded-[2px] bg-background">
                        <div className={`h-full rounded-[2px] ${row.className}`} style={{ width: `${Math.max((Math.abs(row.amount) / maxMagnitude) * 100, 3)}%` }} />
                      </div>
                    </div>
                  ))}
                  <p className="border-t border-line pt-4 text-xs leading-5 text-muted">
                    Unit: {graphEvent.description?.match(/Unit: ([^.]+)\./)?.[1] ?? "as published by the source"}.
                  </p>
                </div>
              );
            })() : null}
            <Dialog.Close aria-label="Close release comparison" className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-[3px] border border-line bg-background text-muted hover:border-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Panel className="mt-5">
        <div className="flex items-start gap-3 text-sm leading-6 text-muted">
          <CalendarDays className="mt-1 h-4 w-4 shrink-0 text-accent" />
          <p>
            Live U.S. macro events are sourced from Xoomar using agency release schedules. Actual and Previous values
            appear when published; Xoomar does not provide consensus forecasts.{" "}
            <a
              className="font-semibold text-accent hover:underline"
              href="https://xoomar.com/markets/calendar"
              target="_blank"
              rel="noreferrer"
            >
              Data: XOOMAR
            </a>
          </p>
        </div>
      </Panel>
    </WorkspacePage>
  );
}
