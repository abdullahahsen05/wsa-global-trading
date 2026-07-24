"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { BookOpenCheck, CheckCircle2, Users } from "lucide-react";
import {
  EmptyState,
  FilterChipRow,
  PaginationControls,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import type { AcademyCourseDto, CourseProgressDto, MyAcademyProgressDto } from "@/lib/domain/types";

type CourseWithProgress = AcademyCourseDto & { progress: CourseProgressDto };

const DIFFICULTY_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  BEGINNER: "lime",
  INTERMEDIATE: "accent",
  ADVANCED: "danger",
};

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

export default function AcademyPage() {
  const [filter, setFilter] = useState<"ALL" | "BEGINNER" | "INTERMEDIATE" | "ADVANCED">("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(9);

  const { data: courses = [], isLoading, isError, error } = useQuery<CourseWithProgress[]>({
    queryKey: ["academy-courses"],
    queryFn: () => apiFetch("/api/academy/courses"),
  });

  const { data: progressSummary } = useQuery<MyAcademyProgressDto>({
    queryKey: ["academy-progress-me"],
    queryFn: () => apiFetch("/api/academy/progress"),
  });

  const filtered =
    filter === "ALL" ? courses : courses.filter((c) => c.difficulty === filter);
  const pagedCourses = filtered.slice((page - 1) * pageSize, page * pageSize);

  const resumeCourse = courses.find(
    (c) => c.progress.progressPercent > 0 && c.progress.progressPercent < 100,
  );

  return (
    <WorkspacePage
      eyebrow="Learning Center"
      title="Trading Academy"
      description="Master trading with structured courses, live webinars, and expert guidance"
      action={
        <Link href="/academy/webinars" className="btn-dark">
          <BookOpenCheck className="mr-2 inline-block h-4 w-4" />
          Live Webinars
        </Link>
      }
    >
      {progressSummary ? (
        <Panel className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Your academy progress</p>
              <div className="mt-2 flex items-end gap-3">
                <span className="text-3xl font-semibold text-foreground">{progressSummary.completionPercent}%</span>
                <StatusPill tone={progressSummary.label === "EXCELLENT" ? "lime" : progressSummary.label === "GOOD" ? "accent" : "danger"}>{progressSummary.label}</StatusPill>
              </div>
              <p className="mt-1 text-sm text-muted">{progressSummary.completedLessons} of {progressSummary.totalLessons} published lessons completed.</p>
            </div>
            <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-panel-strong">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progressSummary.completionPercent}%` }} />
            </div>
          </div>
        </Panel>
      ) : null}

      {resumeCourse ? (
        <Panel className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
              Continue learning
            </p>
            <p className="mt-1 text-base font-semibold text-foreground">{resumeCourse.title}</p>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-panel-strong">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${resumeCourse.progress.progressPercent}%` }}
                />
              </div>
              <span className="text-xs text-muted">{resumeCourse.progress.progressPercent}%</span>
            </div>
          </div>
          <Link
            href={
              resumeCourse.progress.lastLessonSlug && resumeCourse.progress.lastCourseSlug
                ? `/academy/${resumeCourse.progress.lastCourseSlug}/lessons/${resumeCourse.progress.lastLessonSlug}`
                : `/academy/${resumeCourse.slug}`
            }
            className="btn-dark btn-active"
          >
            Resume
          </Link>
        </Panel>
      ) : null}

      <FilterChipRow
        chips={[
          { label: "All", active: filter === "ALL", onClick: () => { setFilter("ALL"); setPage(1); } },
          { label: "Beginner", active: filter === "BEGINNER", onClick: () => { setFilter("BEGINNER"); setPage(1); } },
          { label: "Intermediate", active: filter === "INTERMEDIATE", onClick: () => { setFilter("INTERMEDIATE"); setPage(1); } },
          { label: "Advanced", active: filter === "ADVANCED", onClick: () => { setFilter("ADVANCED"); setPage(1); } },
        ]}
      />

      {isLoading ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-52 animate-pulse rounded-[4px] bg-panel" />)}
        </div>
      ) : isError ? (
        <Panel className="mt-4">
          <p className="text-sm text-danger">{error instanceof Error ? error.message : "Failed to load courses."}</p>
        </Panel>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No courses available"
          description="Check back soon - new courses are added regularly."
          icon={BookOpenCheck}
        />
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {pagedCourses.map((course) => (
            <Link
              key={course.id}
              href={`/academy/${course.slug}`}
              className="group flex h-full flex-col gap-3 rounded-[4px] border border-line bg-panel p-5 transition-colors hover:border-accent/40 hover:bg-panel/80"
            >
              {course.coverImageUrl ? (
                <div className="relative h-32 w-full overflow-hidden rounded-[4px]">
                  <Image
                    src={course.coverImageUrl}
                    alt={course.title}
                    fill
                    unoptimized
                    sizes="(max-width: 768px) 100vw, 33vw"
                    className="object-cover"
                  />
                </div>
              ) : (
                <div className="flex h-32 w-full items-center justify-center rounded-[4px] bg-panel-strong">
                  <BookOpenCheck className="h-10 w-10 text-muted/40" />
                </div>
              )}
              <div className="flex items-start justify-between gap-2">
                <h3 className="leading-snug text-base font-semibold text-foreground group-hover:text-accent">
                  {course.title}
                </h3>
                {course.difficulty ? (
                  <StatusPill tone={DIFFICULTY_TONE[course.difficulty] ?? "muted"}>
                    {course.difficulty}
                  </StatusPill>
                ) : null}
              </div>
              {course.shortDescription ? (
                <p className="line-clamp-2 text-sm leading-5 text-muted">{course.shortDescription}</p>
              ) : null}
              <div className="mt-auto space-y-2">
                {course.progress.progressPercent > 0 ? (
                  <div className="flex items-center gap-2">
                    {course.progress.progressPercent === 100 ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-2" />
                    ) : null}
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-panel-strong">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${course.progress.progressPercent}%` }} />
                    </div>
                    <span className="shrink-0 text-[11px] text-muted">{course.progress.progressPercent}%</span>
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <StatusPill tone={course.progress.progressPercent >= 80 ? "lime" : course.progress.progressPercent >= 40 ? "accent" : "danger"}>
                    {course.progress.progressPercent >= 80 ? "EXCELLENT" : course.progress.progressPercent >= 40 ? "GOOD" : "BAD"}
                  </StatusPill>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span>{course.moduleCount} module{course.moduleCount !== 1 ? "s" : ""}</span>
                  <span>-</span>
                  <span>{course.lessonCount} lesson{course.lessonCount !== 1 ? "s" : ""}</span>
                  {course.estimatedMinutes ? (
                    <>
                      <span>-</span>
                      <span>{Math.round(course.estimatedMinutes / 60)}h {course.estimatedMinutes % 60}m</span>
                    </>
                  ) : null}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <PaginationControls
        currentPage={page}
        totalItems={filtered.length}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(value) => {
          setPage(1);
          setPageSize(value);
        }}
      />

      <div className="mt-6 rounded-[4px] border border-accent/30 bg-accent/5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[4px] bg-accent/15">
              <Users className="h-6 w-6 text-accent" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">
                1-to-1 Professional Mentorship
              </h3>
              <p className="mt-1 max-w-lg text-sm text-muted">
                Get mentored directly by a professional trader in a private 1-on-1 programme.
                Learn advanced strategies, risk management, and live market analysis tailored to your goals.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link href="/academy/mentorship/contact" className="btn-dark">Contact mentorship team</Link>
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}
