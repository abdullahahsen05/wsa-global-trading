"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EmptyState,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { BookOpenCheck, CheckCircle2 } from "lucide-react";
import type { AcademyWebinarDto } from "@/lib/domain/types";

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

const STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  SCHEDULED: "accent",
  LIVE: "lime",
  COMPLETED: "muted",
  CANCELLED: "danger",
};

function formatDT(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function WebinarsPage() {
  const qc = useQueryClient();

  const { data: webinars = [], isLoading, isError, error } = useQuery<AcademyWebinarDto[]>({
    queryKey: ["academy-webinars"],
    queryFn: () => apiFetch("/api/academy/webinars"),
  });

  const joinMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/academy/webinars/${id}/join`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy-webinars"] }),
  });

  const upcoming = webinars.filter((w) => w.status === "SCHEDULED" || w.status === "LIVE");
  const past = webinars.filter((w) => w.status === "COMPLETED");

  return (
    <WorkspacePage
      eyebrow="Learning Center"
      title="Live Webinars"
      description="Join live trading sessions and watch replays at your own pace"
    >
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-[4px] bg-panel" />)}
        </div>
      ) : isError ? (
        <Panel>
          <p className="text-sm text-danger">{error instanceof Error ? error.message : "Failed to load webinars."}</p>
        </Panel>
      ) : (
        <>
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted">Upcoming</h2>
            {upcoming.length === 0 ? (
              <EmptyState title="No upcoming webinars" description="Check back soon for live sessions." icon={BookOpenCheck} />
            ) : (
              <div className="space-y-3">
                {upcoming.map((w) => (
                  <Panel key={w.id} className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={STATUS_TONE[w.status] ?? "muted"}>{w.status}</StatusPill>
                        {w.courseTitle ? <StatusPill tone="muted">{w.courseTitle}</StatusPill> : null}
                      </div>
                      <h3 className="mt-2 text-base font-semibold text-foreground">{w.title}</h3>
                      {w.description ? <p className="mt-1 text-sm text-muted line-clamp-2">{w.description}</p> : null}
                      <p className="mt-2 text-xs text-muted">{formatDT(w.startTime)}{w.timezone ? ` · ${w.timezone}` : ""}</p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {w.attended ? (
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-accent-2">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Registered
                        </span>
                      ) : null}
                      {w.joinUrl ? (
                        <a
                          href={w.joinUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => joinMutation.mutate(w.id)}
                          className="btn-dark btn-active text-sm"
                        >
                          Join session
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={() => joinMutation.mutate(w.id)}
                          disabled={w.attended || joinMutation.isPending}
                          className="btn-dark disabled:opacity-50"
                        >
                          {w.attended ? "Registered" : "Register"}
                        </button>
                      )}
                    </div>
                  </Panel>
                ))}
              </div>
            )}
          </section>

          {past.length > 0 ? (
            <section className="mt-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted">Replays</h2>
              <div className="space-y-3">
                {past.map((w) => (
                  <Panel key={w.id} className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone="muted">COMPLETED</StatusPill>
                        {w.courseTitle ? <StatusPill tone="muted">{w.courseTitle}</StatusPill> : null}
                      </div>
                      <h3 className="mt-2 text-base font-semibold text-foreground">{w.title}</h3>
                      <p className="mt-1 text-xs text-muted">{formatDT(w.startTime)}</p>
                    </div>
                    {w.replayUrl ? (
                      <a href={w.replayUrl} target="_blank" rel="noreferrer" className="btn-dark text-sm">
                        Watch replay
                      </a>
                    ) : (
                      <span className="text-xs text-muted">Replay coming soon</span>
                    )}
                  </Panel>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </WorkspacePage>
  );
}
