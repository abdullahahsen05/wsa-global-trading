"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import {
  DataTable,
  EmptyState,
  GhostButton,
  InlineStatusStrip,
  PageActionGroup,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField, TextAreaField, TextField } from "@/components/app/FormFields";
import { queryKeys } from "@/lib/data/queryKeys";

type Impact = "LOW" | "MEDIUM" | "HIGH";

interface EventDto {
  id: string;
  title: string;
  countryCode: string | null;
  currency: string;
  impact: Impact;
  eventTime: string;
  endTime: string | null;
  timezone: string;
  eventType: "ECONOMIC" | "WEBINAR" | "ACADEMY" | "PLATFORM" | "OTHER";
  locationUrl: string | null;
  status: "DRAFT" | "PUBLISHED" | "CANCELLED";
  audience: "ALL" | "TRADER";
  description: string | null;
  forecast: string | null;
  previous: string | null;
  source: string | null;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

const EMPTY_FORM = {
  title: "",
  currency: "",
  impact: "MEDIUM" as Impact,
  eventTime: "",
  endTime: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  eventType: "ECONOMIC" as EventDto["eventType"],
  locationUrl: "",
  status: "DRAFT" as EventDto["status"],
  audience: "ALL" as EventDto["audience"],
  description: "",
  countryCode: "",
  forecast: "",
  previous: "",
  source: "",
};

export default function AdminEconomicCalendarPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: events = [], isLoading, isError } = useQuery<EventDto[]>({
    queryKey: queryKeys.economicCalendar,
    queryFn: async () => {
      const res = await fetch("/api/admin/economic-calendar");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load events");
      return json.data;
    },
  });

  function openCreate() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(e: EventDto) {
    setEditingId(e.id);
    setForm({
      title: e.title,
      currency: e.currency,
      impact: e.impact,
      eventTime: toLocalInput(e.eventTime),
      endTime: e.endTime ? toLocalInput(e.endTime) : "",
      timezone: e.timezone,
      eventType: e.eventType,
      locationUrl: e.locationUrl ?? "",
      status: e.status,
      audience: e.audience,
      description: e.description ?? "",
      countryCode: e.countryCode ?? "",
      forecast: e.forecast ?? "",
      previous: e.previous ?? "",
      source: e.source ?? "",
    });
    setFormError(null);
    setDialogOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form.title.trim() || !form.currency.trim() || !form.eventTime) {
        throw new Error("Title, currency, and date/time are required.");
      }
      const body = {
        title: form.title.trim(),
        currency: form.currency.trim().toUpperCase(),
        impact: form.impact,
        eventTime: new Date(form.eventTime).toISOString(),
        endTime: form.endTime ? new Date(form.endTime).toISOString() : null,
        timezone: form.timezone.trim() || "UTC",
        eventType: form.eventType,
        locationUrl: form.locationUrl.trim() || null,
        status: form.status,
        audience: form.audience,
        description: form.description.trim() || null,
        countryCode: form.countryCode.trim() || null,
        forecast: form.forecast.trim() || null,
        previous: form.previous.trim() || null,
        source: form.source.trim() || null,
      };
      const url = editingId ? `/api/admin/economic-calendar/${editingId}` : "/api/admin/economic-calendar";
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to save event");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.economicCalendar });
      setDialogOpen(false);
      setNotice({ type: "success", text: editingId ? "Event updated." : "Event created." });
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/economic-calendar/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to delete event");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.economicCalendar });
      setNotice({ type: "success", text: "Event deleted." });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  // Capture "now" once for the session so the count is stable across re-renders.
  const [nowTs] = useState(() => Date.now());
  const upcoming = events.filter((e) => new Date(e.eventTime).getTime() >= nowTs);
  const highImpact = events.filter((e) => e.impact === "HIGH");

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Economic Calendar"
      description="Maintain the economic events the AI assistant uses for news context on traders' active pairs."
      action={
        <PageActionGroup>
          <PrimaryButton type="button" onClick={openCreate}>
            <Plus className="mr-2 inline-block h-4 w-4" />
            Add event
          </PrimaryButton>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Total events", value: isLoading ? "…" : events.length },
          { label: "Upcoming", value: isLoading ? "…" : upcoming.length, tone: "accent" },
          { label: "High impact", value: isLoading ? "…" : highImpact.length, tone: "danger" },
        ]}
      />

      {notice ? (
        <div
          className={`mt-5 rounded-[4px] border px-4 py-3 text-sm font-medium ${
            notice.type === "success"
              ? "border-accent/20 bg-accent/10 text-accent"
              : "border-danger/20 bg-danger/10 text-danger"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      <div className="mt-5">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 rounded-[4px] border border-line bg-panel animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load economic events.
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            title="No events yet"
            description="Add economic events so the AI assistant can warn traders about upcoming news on their active currency pairs."
            action={
              <PrimaryButton type="button" onClick={openCreate}>
                <Plus className="mr-2 inline-block h-4 w-4" />
                Add event
              </PrimaryButton>
            }
          />
        ) : (
          <DataTable
            headers={["Event", "Type", "Status", "Audience", "Time (local)", ""]}
            rows={events.map((e) => [
              <div key="t" className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{e.title}</p>
                <p className="truncate text-xs text-muted">{e.currency} · {e.timezone}</p>
              </div>,
              <span key="type" className="font-semibold text-foreground">{e.eventType}</span>,
              <StatusPill key="status" tone={e.status === "PUBLISHED" ? "lime" : e.status === "CANCELLED" ? "danger" : "muted"}>{e.status}</StatusPill>,
              <span key="audience">{e.audience}</span>,
              <span key="ti">{new Date(e.eventTime).toLocaleString()}</span>,
              <div key="a" className="flex gap-2">
                <GhostButton type="button" onClick={() => openEdit(e)}>
                  <Pencil className="h-4 w-4" />
                </GhostButton>
                <GhostButton
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(e.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </GhostButton>
              </div>,
            ])}
          />
        )}
      </div>

      {/* Add / edit dialog */}
      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 invisible-scrollbar overflow-y-auto rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="text-xl font-semibold text-foreground">
              {editingId ? "Edit event" : "Add event"}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              These events power the AI assistant&apos;s news context. Times are entered in your local timezone.
            </Dialog.Description>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <TextField
                  label="Title"
                  placeholder="e.g. US Non-Farm Payrolls"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                />
              </div>
              <TextField
                label="Currency"
                placeholder="USD"
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              />
              <SelectField
                label="Impact"
                value={form.impact}
                onChange={(e) => setForm((f) => ({ ...f, impact: e.target.value as Impact }))}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </SelectField>
              <div>
                <TextField
                  label="Start date &amp; time"
                  type="datetime-local"
                  value={form.eventTime}
                  onChange={(e) => setForm((f) => ({ ...f, eventTime: e.target.value }))}
                />
              </div>
              <TextField
                label="End date &amp; time (optional)"
                type="datetime-local"
                value={form.endTime}
                onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
              />
              <TextField
                label="Timezone"
                placeholder="Europe/London"
                value={form.timezone}
                onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
              />
              <SelectField label="Event type" value={form.eventType} onChange={(e) => setForm((f) => ({ ...f, eventType: e.target.value as EventDto["eventType"] }))}>
                <option value="ECONOMIC">Economic</option>
                <option value="WEBINAR">Webinar</option>
                <option value="ACADEMY">Academy</option>
                <option value="PLATFORM">Platform</option>
                <option value="OTHER">Other</option>
              </SelectField>
              <SelectField label="Publication status" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as EventDto["status"] }))}>
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED">Published</option>
                <option value="CANCELLED">Cancelled</option>
              </SelectField>
              <SelectField label="Audience" value={form.audience} onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value as EventDto["audience"] }))}>
                <option value="ALL">All traders</option>
                <option value="TRADER">Traders</option>
              </SelectField>
              <div className="sm:col-span-2">
                <TextField
                  label="Location or meeting link (optional)"
                  type="url"
                  placeholder="https://..."
                  value={form.locationUrl}
                  onChange={(e) => setForm((f) => ({ ...f, locationUrl: e.target.value }))}
                />
              </div>
              <div className="sm:col-span-2">
                <TextAreaField
                  label="Description (optional)"
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>
              <TextField
                label="Country code (optional)"
                placeholder="US"
                value={form.countryCode}
                onChange={(e) => setForm((f) => ({ ...f, countryCode: e.target.value }))}
              />
              <TextField
                label="Source (optional)"
                placeholder="e.g. BLS"
                value={form.source}
                onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
              />
              <TextField
                label="Forecast (optional)"
                value={form.forecast}
                onChange={(e) => setForm((f) => ({ ...f, forecast: e.target.value }))}
              />
              <TextField
                label="Previous (optional)"
                value={form.previous}
                onChange={(e) => setForm((f) => ({ ...f, previous: e.target.value }))}
              />
            </div>

            {formError ? (
              <div className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
                {formError}
              </div>
            ) : null}

            <div className="mt-5 flex justify-end gap-3 border-t border-line pt-4">
              <Dialog.Close asChild>
                <GhostButton type="button">Cancel</GhostButton>
              </Dialog.Close>
              <PrimaryButton type="button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? "Saving…" : editingId ? "Save changes" : "Create event"}
              </PrimaryButton>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}
