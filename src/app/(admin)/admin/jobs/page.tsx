"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Plus, RefreshCcw, Repeat, X } from "lucide-react";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import type { BackgroundJob, JobStatus } from "@/lib/jobs/types";
import type { JobStats } from "@/lib/services/backgroundJobService";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data;
}

const STATUS_TONE: Record<JobStatus, "lime" | "accent" | "danger" | "muted"> = {
  PENDING: "accent",
  RUNNING: "accent",
  SUCCESS: "lime",
  FAILED: "danger",
  CANCELLED: "muted",
  SKIPPED: "muted",
};

type StatusFilter = "ALL" | JobStatus;

export default function AdminJobsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [detail, setDetail] = useState<BackgroundJob | null>(null);

  const { data, isLoading, isError } = useQuery<{ jobs: BackgroundJob[]; stats: JobStats }>({
    queryKey: ["admin-jobs", statusFilter],
    queryFn: () => getJson(`/api/admin/jobs${statusFilter === "ALL" ? "" : `?status=${statusFilter}`}`),
    refetchInterval: 5000, // jobs page benefits from a light live refresh
  });

  const jobs = data?.jobs ?? [];
  const stats = data?.stats;

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["admin-jobs"] });
  }

  const action = useMutation({
    mutationFn: async ({ url, body }: { url: string; body?: unknown; label?: string }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
      return json.data;
    },
    onSuccess: (_d, vars) => {
      invalidate();
      setNotice({ type: "success", text: `Done: ${vars.label ?? "updated"}.` });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Background Jobs"
      description="Queue and process MT5 sync, copy monitoring, simulation, and gated live execution off the request path."
      action={
        <PageActionGroup>
          <GhostButton
            type="button"
            onClick={() => action.mutate({ url: "/api/admin/jobs/enqueue", body: { type: "SYNC_ALL_CONNECTED_ACCOUNTS" }, label: "queued sync all" })}
          >
            <Plus className="mr-2 inline-block h-4 w-4" /> Queue sync all
          </GhostButton>
          <GhostButton
            type="button"
            onClick={() => action.mutate({ url: "/api/admin/jobs/enqueue", body: { type: "MONITOR_ALL_ACTIVE_COPY_STRATEGIES" }, label: "queued monitor all" })}
          >
            <Repeat className="mr-2 inline-block h-4 w-4" /> Queue monitor all
          </GhostButton>
          <PrimaryButton
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate({ url: "/api/admin/jobs/run-now", body: { limit: 5 }, label: "worker run" })}
          >
            <Play className="mr-2 inline-block h-4 w-4" /> Run worker now
          </PrimaryButton>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Pending", value: isLoading ? "…" : stats?.pending ?? 0, tone: "accent" },
          { label: "Running", value: isLoading ? "…" : stats?.running ?? 0 },
          { label: "Success today", value: isLoading ? "…" : stats?.successToday ?? 0, tone: "lime" },
          { label: "Failed today", value: isLoading ? "…" : stats?.failedToday ?? 0, tone: (stats?.failedToday ?? 0) > 0 ? "danger" : undefined },
          { label: "Skipped today", value: isLoading ? "…" : stats?.skippedToday ?? 0 },
        ]}
      />

      {notice ? (
        <div
          className={`mt-5 rounded-[4px] border px-4 py-3 text-sm font-medium ${
            notice.type === "success" ? "border-accent/20 bg-accent/10 text-accent" : "border-danger/20 bg-danger/10 text-danger"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      <div className="mt-5">
        <FilterChipRow
          chips={(["ALL", "PENDING", "RUNNING", "SUCCESS", "FAILED", "SKIPPED", "CANCELLED"] as StatusFilter[]).map((s) => ({
            label: s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase(),
            active: statusFilter === s,
            onClick: () => setStatusFilter(s),
          }))}
        />
      </div>

      <div className="mt-5">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-12 rounded-[4px] border border-line bg-panel animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load jobs.
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState title="No jobs yet" description="Queue a sync or monitor job, then run the worker to process it." />
        ) : (
          <Panel className="min-w-0 overflow-hidden">
            <DataTable
              headers={["Type", "Status", "Attempts", "Created", "Last error", ""]}
              rows={jobs.map((j) => [
                <span key="t" className="text-sm font-semibold text-foreground">{j.type}</span>,
                <StatusPill key="s" tone={STATUS_TONE[j.status]}>{j.status}</StatusPill>,
                <span key="a">{j.attempts}/{j.maxAttempts}</span>,
                <span key="c">{new Date(j.createdAt).toLocaleString()}</span>,
                <span key="e" className="text-xs text-muted">{j.lastErrorCode ? `${j.lastErrorCode}` : "—"}</span>,
                <div key="x" className="flex flex-wrap justify-end gap-3">
                  <GhostButton type="button" onClick={() => setDetail(j)}>View</GhostButton>
                  {["FAILED", "CANCELLED", "SKIPPED"].includes(j.status) ? (
                    <GhostButton type="button" disabled={action.isPending} onClick={() => action.mutate({ url: `/api/admin/jobs/${j.id}/retry`, label: "retried" })}>
                      <RefreshCcw className="mr-1 inline-block h-3.5 w-3.5" /> Retry
                    </GhostButton>
                  ) : null}
                  {j.status === "PENDING" ? (
                    <GhostButton type="button" disabled={action.isPending} onClick={() => action.mutate({ url: `/api/admin/jobs/${j.id}/cancel`, label: "cancelled" })}>
                      Cancel
                    </GhostButton>
                  ) : null}
                </div>,
              ])}
            />
          </Panel>
        )}
      </div>

      {/* Job detail dialog — payload holds IDs only; result holds counts/summaries (no secrets). */}
      <Dialog.Root open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 invisible-scrollbar overflow-y-auto rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="text-xl font-semibold text-foreground">{detail?.type}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">Job {detail?.id}</Dialog.Description>
            {detail ? (
              <div className="mt-4 space-y-3 text-sm">
                <Row label="Status" value={detail.status} />
                <Row label="Attempts" value={`${detail.attempts}/${detail.maxAttempts}`} />
                <Row label="Run after" value={new Date(detail.runAfter).toLocaleString()} />
                <Row label="Started" value={detail.startedAt ? new Date(detail.startedAt).toLocaleString() : "—"} />
                <Row label="Completed" value={detail.completedAt ? new Date(detail.completedAt).toLocaleString() : "—"} />
                {detail.lastErrorCode ? <Row label="Error" value={`${detail.lastErrorCode}: ${detail.lastErrorMessage ?? ""}`} /> : null}
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Payload</p>
                  <pre className="mt-1 invisible-scrollbar overflow-x-auto rounded-[4px] border border-line bg-background p-3 text-xs text-foreground/80">{JSON.stringify(detail.payload, null, 2)}</pre>
                </div>
                {detail.result ? (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Result</p>
                    <pre className="mt-1 invisible-scrollbar overflow-x-auto rounded-[4px] border border-line bg-background p-3 text-xs text-foreground/80">{JSON.stringify(detail.result, null, 2)}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 pb-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{label}</span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}
