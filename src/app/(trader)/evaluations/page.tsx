"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { EmptyState, PaginationControls, Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import type { ProgramWithStatusDto } from "@/lib/services/evaluationService";

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? json.error?.code ?? "Request failed");
  return json.data as T;
}

const STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  PENDING: "muted",
  ACTIVE: "accent",
  PASSED: "lime",
  FAILED: "danger",
  EXPIRED: "danger",
  CANCELLED: "muted",
  NEEDS_REVIEW: "accent",
};

export default function EvaluationsPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);

  const { data: programs = [], isLoading, isError, error } = useQuery<ProgramWithStatusDto[]>({
    queryKey: ["evaluations-programs"],
    queryFn: () => apiFetch("/api/evaluations/programs"),
  });

  const startMutation = useMutation({
    mutationFn: (programId: string) =>
      apiFetch(`/api/evaluations/programs/${programId}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["evaluations-programs"] });
      qc.invalidateQueries({ queryKey: ["evaluations-attempts"] });
    },
  });
  const pagedPrograms = programs.slice((page - 1) * pageSize, page * pageSize);

  return (
    <WorkspacePage
      eyebrow="Certification"
      title="Evaluation Programs"
      description="Complete academy requirements and challenge yourself with a funded trader evaluation"
      action={
        <Link href="/evaluations/certificates" className="btn-dark">
          My Certificates
        </Link>
      }
    >
      {isLoading && (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading programs…</div>
      )}
      {isError && (
        <div className="py-16 text-center text-sm text-danger">{(error as Error).message}</div>
      )}
      {!isLoading && !isError && programs.length === 0 && (
        <EmptyState
          icon={undefined}
          title="No evaluation programs available"
          description="Check back later — programs will appear here when published by an admin."
        />
      )}

      <div className="space-y-4">
        {pagedPrograms.map((prog) => {
          const hasAttempt = prog.attemptId !== null;
          const locked = !prog.isUnlocked;
          const attemptStatus = prog.attemptStatus;

          return (
            <Panel key={prog.id} className="overflow-hidden">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{prog.name}</h3>
                    {locked && (
                      <span className="rounded-[4px] bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Locked
                      </span>
                    )}
                    {attemptStatus && (
                      <StatusPill tone={STATUS_TONE[attemptStatus] ?? "muted"}>
                        {attemptStatus}
                      </StatusPill>
                    )}
                  </div>

                  {prog.description && (
                    <p className="mt-1 text-xs text-muted-foreground">{prog.description}</p>
                  )}

                  <div className="mt-4 grid overflow-hidden border border-line text-xs sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      ["Balance", `$${prog.startingBalance.toLocaleString()}`],
                      ["Target", `${prog.profitTargetPercent}%`],
                      ["Max daily DD", `${prog.maxDailyDrawdownPercent}%`],
                      ["Max DD", `${prog.maxOverallDrawdownPercent}%`],
                      ["Min days", prog.minimumTradingDays],
                      ["Duration", `${prog.durationDays} days`],
                    ].map(([label, value]) => (
                      <div key={label} className="border-b border-line px-3 py-2 last:border-b-0 sm:border-r sm:last:border-r-0 lg:[&:nth-child(3n)]:border-r-0 lg:[&:nth-last-child(-n+3)]:border-b-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
                        <p className="mt-1 font-semibold text-foreground">{value}</p>
                      </div>
                    ))}
                  </div>

                  {prog.requiredCourseId && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Requires:{" "}
                      <Link href="/academy" className="underline hover:text-foreground">
                        {prog.requiredCourseName ?? "Academy Course"}
                      </Link>
                      {prog.academyProgressPercent !== null && (
                        <span className="ml-2">({prog.academyProgressPercent}% complete)</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-start gap-2 lg:justify-end">
                  {hasAttempt && prog.attemptId ? (
                    <Link
                      href={`/evaluations/${prog.attemptId}`}
                      className="rounded-[4px] bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
                    >
                      View Attempt
                    </Link>
                  ) : locked ? (
                    <button
                      disabled
                      className="cursor-not-allowed rounded-[4px] bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
                    >
                      Complete Academy First
                    </button>
                  ) : (
                    <button
                      onClick={() => startMutation.mutate(prog.id)}
                      disabled={startMutation.isPending}
                      className="rounded-[4px] bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-60"
                    >
                      {startMutation.isPending ? "Starting…" : "Start Evaluation"}
                    </button>
                  )}
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      {startMutation.isError && (
        <p className="mt-4 text-center text-xs text-danger">
          {(startMutation.error as Error).message}
        </p>
      )}

      <PaginationControls
        currentPage={page}
        totalItems={programs.length}
        pageSize={pageSize}
        pageSizeOptions={[5, 10, 20]}
        onPageChange={setPage}
        onPageSizeChange={(value) => {
          setPage(1);
          setPageSize(value);
        }}
      />
    </WorkspacePage>
  );
}
