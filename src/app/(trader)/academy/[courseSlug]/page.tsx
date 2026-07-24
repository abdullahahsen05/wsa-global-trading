"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  EmptyState,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { BookOpenCheck, CheckCircle2 } from "lucide-react";
import type { AcademyCourseDto, AcademyModuleDto, CourseProgressDto, AcademyLessonSummaryDto } from "@/lib/domain/types";

type PageData = {
  course: AcademyCourseDto;
  modules: AcademyModuleDto[];
  progress: CourseProgressDto;
};

const LESSON_TYPE_LABEL: Record<string, string> = {
  VIDEO: "Video",
  TEXT: "Reading",
  RESOURCE: "Resource",
  WEBINAR_REPLAY: "Replay",
};

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

function LessonRow({ lesson, courseSlug }: { lesson: AcademyLessonSummaryDto; courseSlug: string }) {
  const isComplete = lesson.progressStatus === "COMPLETED";
  const isStarted = lesson.progressStatus === "IN_PROGRESS";

  return (
    <Link
      href={`/academy/${courseSlug}/lessons/${lesson.slug}`}
      className="flex items-center gap-3 rounded-[4px] border border-line bg-background px-4 py-3 transition-colors hover:border-accent/40 hover:bg-panel"
    >
      <span className="shrink-0">
        {isComplete ? (
          <CheckCircle2 className="h-4 w-4 text-accent-2" />
        ) : (
          <div className={`h-4 w-4 rounded-full border-2 ${isStarted ? "border-accent" : "border-line"}`} />
        )}
      </span>
      <span className="flex-1 text-sm font-semibold text-foreground">{lesson.title}</span>
      <div className="flex items-center gap-2 shrink-0">
        <StatusPill tone="muted">{LESSON_TYPE_LABEL[lesson.lessonType] ?? lesson.lessonType}</StatusPill>
        {lesson.durationMinutes ? (
          <span className="text-xs text-muted">{lesson.durationMinutes}m</span>
        ) : null}
        <span className="text-xs text-muted">›</span>
      </div>
    </Link>
  );
}

function ModuleAccordion({ mod, courseSlug }: { mod: AcademyModuleDto; courseSlug: string }) {
  const [open, setOpen] = useState(true);
  const completed = mod.lessons.filter((l) => l.progressStatus === "COMPLETED").length;

  return (
    <div className="rounded-[4px] border border-line bg-panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div>
          <p className="text-sm font-semibold text-foreground">{mod.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            {completed}/{mod.lessons.length} lessons completed
          </p>
        </div>
        <span className={`inline-block text-sm text-muted transition-transform duration-200 ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open ? (
        <div className="space-y-2 px-4 pb-4">
          {mod.lessons.length === 0 ? (
            <p className="text-sm text-muted px-1">No lessons in this module yet.</p>
          ) : (
            mod.lessons.map((lesson) => (
              <LessonRow key={lesson.id} lesson={lesson} courseSlug={courseSlug} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function CoursePage({ params }: { params: Promise<{ courseSlug: string }> }) {
  const { courseSlug } = use(params);

  const { data, isLoading, isError, error } = useQuery<PageData>({
    queryKey: ["academy-course", courseSlug],
    queryFn: () => apiFetch(`/api/academy/courses/${courseSlug}`),
  });

  if (isLoading) {
    return (
      <WorkspacePage eyebrow="Academy" title="Loading…" description="">
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-[4px] bg-panel" />)}
        </div>
      </WorkspacePage>
    );
  }

  if (isError || !data) {
    return (
      <WorkspacePage eyebrow="Academy" title="Error" description="">
        <Panel>
          <p className="text-sm text-danger">{error instanceof Error ? error.message : "Course not found."}</p>
        </Panel>
      </WorkspacePage>
    );
  }

  const { course, modules, progress } = data;
  const totalLessons = modules.reduce((s, m) => s + m.lessons.length, 0);

  return (
    <WorkspacePage
      eyebrow="Academy"
      title={course.title}
      description={course.shortDescription ?? ""}
      action={
        <Link href="/academy" className="btn-dark text-sm">
          ← All courses
        </Link>
      }
    >
      {/* Course header stats */}
      <Panel className="mb-5">
        <div className="flex flex-wrap items-center gap-4">
          {course.difficulty ? (
            <StatusPill tone={course.difficulty === "BEGINNER" ? "lime" : course.difficulty === "ADVANCED" ? "danger" : "accent"}>
              {course.difficulty}
            </StatusPill>
          ) : null}
          <span className="text-sm text-muted">{modules.length} modules · {totalLessons} lessons</span>
          {course.estimatedMinutes ? (
            <span className="text-sm text-muted">{Math.round(course.estimatedMinutes / 60)}h {course.estimatedMinutes % 60}m</span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-panel-strong">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress.progressPercent}%` }} />
            </div>
            <span className="text-xs font-semibold text-muted">{progress.progressPercent}%</span>
          </div>
        </div>
        {course.description ? (
          <p className="mt-3 text-sm text-muted leading-6 whitespace-pre-line">{course.description}</p>
        ) : null}
        {progress.lastLessonSlug ? (
          <div className="mt-4">
            <Link
              href={`/academy/${courseSlug}/lessons/${progress.lastLessonSlug}`}
              className="btn-dark btn-active inline-block text-sm"
            >
              {progress.progressPercent === 100 ? "Review last lesson" : "Continue learning"}
            </Link>
          </div>
        ) : (
          modules[0]?.lessons[0] ? (
            <div className="mt-4">
              <Link
                href={`/academy/${courseSlug}/lessons/${modules[0].lessons[0].slug}`}
                className="btn-dark btn-active inline-block text-sm"
              >
                Start course
              </Link>
            </div>
          ) : null
        )}
      </Panel>

      {/* Modules */}
      {modules.length === 0 ? (
        <EmptyState title="No modules yet" description="Content is being added to this course." icon={BookOpenCheck} />
      ) : (
        <div className="space-y-4">
          {modules.map((mod) => (
            <ModuleAccordion key={mod.id} mod={mod} courseSlug={courseSlug} />
          ))}
        </div>
      )}
    </WorkspacePage>
  );
}
