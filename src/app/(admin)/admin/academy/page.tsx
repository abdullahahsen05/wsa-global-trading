"use client";

import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  GhostButton,
  InlineStatusStrip,
  PageActionGroup,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { BookOpenCheck } from "lucide-react";
import type {
  AcademyCourseDto,
  AcademyModuleDto,
  AcademyLessonDto,
  AcademyWebinarDto,
  AcademyProgressSummaryDto,
} from "@/lib/domain/types";

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

type Analytics = {
  totalCourses: number;
  publishedCourses: number;
  totalLessons: number;
  publishedLessons: number;
  totalCompletions: number;
  totalQuestions: number;
  openQuestions: number;
  upcomingWebinars: number;
};

type Tab = "courses" | "lessons" | "webinars" | "progress";

const STATUS_TONE: Record<string, "lime" | "accent" | "muted"> = {
  PUBLISHED: "lime",
  DRAFT: "accent",
  ARCHIVED: "muted",
};

const fieldCls = "h-10 w-full rounded-[4px] border border-line bg-background px-3 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10";
const textareaCls = "min-h-24 w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/10";
const selectCls = "h-10 w-full rounded-[4px] border border-line bg-background px-3 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10";
const labelCls = "block text-xs font-semibold uppercase tracking-[0.18em] text-muted mb-1.5";

// ── Create Course Dialog ──────────────────────────────────────
function CreateCourseDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ slug: "", title: "", shortDescription: "", difficulty: "", estimatedMinutes: "", status: "DRAFT" });
  const [err, setErr] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/admin/academy/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: form.slug,
          title: form.title,
          shortDescription: form.shortDescription || undefined,
          difficulty: form.difficulty || undefined,
          estimatedMinutes: form.estimatedMinutes ? parseInt(form.estimatedMinutes) : undefined,
          status: form.status,
        }),
      }),
    onSuccess: () => { setOpen(false); setForm({ slug: "", title: "", shortDescription: "", difficulty: "", estimatedMinutes: "", status: "DRAFT" }); onCreated(); },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <PrimaryButton type="button"><Plus className="mr-1.5 h-4 w-4 inline-block" />New Course</PrimaryButton>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 focus:outline-none">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-foreground">Create course</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="grid h-8 w-8 place-items-center rounded-full border border-line text-muted hover:text-foreground"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErr(""); mutation.mutate(); }} className="space-y-4">
            <div>
              <label className={labelCls}>Slug *</label>
              <input required value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))} placeholder="forex-fundamentals" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Title *</label>
              <input required value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Course title" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Short description</label>
              <textarea value={form.shortDescription} onChange={(e) => setForm((f) => ({ ...f, shortDescription: e.target.value }))} rows={2} className={textareaCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Difficulty</label>
                <select value={form.difficulty} onChange={(e) => setForm((f) => ({ ...f, difficulty: e.target.value }))} className={selectCls}>
                  <option value="">None</option>
                  <option value="BEGINNER">Beginner</option>
                  <option value="INTERMEDIATE">Intermediate</option>
                  <option value="ADVANCED">Advanced</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Est. minutes</label>
                <input type="number" min={1} value={form.estimatedMinutes} onChange={(e) => setForm((f) => ({ ...f, estimatedMinutes: e.target.value }))} placeholder="60" className={fieldCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={selectCls}>
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED">Published</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
            {err ? <p className="text-xs text-danger">{err}</p> : null}
            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close asChild><GhostButton type="button">Cancel</GhostButton></Dialog.Close>
              <PrimaryButton type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : "Create course"}</PrimaryButton>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Edit Course Status Dialog ─────────────────────────────────
function EditCourseDialog({ course, onUpdated }: { course: AcademyCourseDto; onUpdated: () => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(course.status);
  const [err, setErr] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/admin/academy/courses/${course.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => { setOpen(false); onUpdated(); },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="text-xs text-accent hover:underline">Edit</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 focus:outline-none">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-foreground">Edit: {course.title}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="grid h-8 w-8 place-items-center rounded-full border border-line text-muted hover:text-foreground"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as AcademyCourseDto["status"])} className={selectCls}>
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED">Published</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
            {err ? <p className="text-xs text-danger">{err}</p> : null}
            <div className="flex justify-end gap-3">
              <Dialog.Close asChild><GhostButton type="button">Cancel</GhostButton></Dialog.Close>
              <PrimaryButton type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</PrimaryButton>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Create Lesson Dialog ──────────────────────────────────────
function CreateLessonDialog({ courses, onCreated }: { courses: AcademyCourseDto[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ courseId: "", moduleId: "", slug: "", title: "", lessonType: "VIDEO", videoUrl: "", embedUrl: "", durationMinutes: "", sortOrder: "0", status: "DRAFT" });
  const [err, setErr] = useState("");

  const { data: courseModules = [], isFetching: modulesFetching } = useQuery<AcademyModuleDto[]>({
    queryKey: ["admin-lesson-dialog-modules", form.courseId],
    queryFn: () => apiFetch(`/api/admin/academy/modules?courseId=${form.courseId}`),
    enabled: Boolean(form.courseId),
  });

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/admin/academy/lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: form.courseId,
          moduleId: form.moduleId,
          slug: form.slug,
          title: form.title,
          lessonType: form.lessonType,
          videoUrl: form.videoUrl || undefined,
          embedUrl: form.embedUrl || undefined,
          durationMinutes: form.durationMinutes ? parseInt(form.durationMinutes) : undefined,
          sortOrder: parseInt(form.sortOrder || "0"),
          status: form.status,
        }),
      }),
    onSuccess: () => { setOpen(false); setForm({ courseId: "", moduleId: "", slug: "", title: "", lessonType: "VIDEO", videoUrl: "", embedUrl: "", durationMinutes: "", sortOrder: "0", status: "DRAFT" }); onCreated(); },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <PrimaryButton type="button"><Plus className="mr-1.5 h-4 w-4 inline-block" />New Lesson</PrimaryButton>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 focus:outline-none max-h-[90vh] invisible-scrollbar overflow-y-auto">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-foreground">Create lesson</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="grid h-8 w-8 place-items-center rounded-full border border-line text-muted hover:text-foreground"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErr(""); mutation.mutate(); }} className="space-y-4">
            <div>
              <label className={labelCls}>Course *</label>
              <select required value={form.courseId} onChange={(e) => setForm((f) => ({ ...f, courseId: e.target.value, moduleId: "" }))} className={selectCls}>
                <option value="">Select course…</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Module *</label>
              <select
                required
                disabled={!form.courseId || modulesFetching}
                value={form.moduleId}
                onChange={(e) => setForm((f) => ({ ...f, moduleId: e.target.value }))}
                className={selectCls}
              >
                <option value="">
                  {!form.courseId ? "Select a course first…" : modulesFetching ? "Loading modules…" : courseModules.length === 0 ? "No modules — create one first" : "Select module…"}
                </option>
                {courseModules.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Slug *</label>
                <input required value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))} placeholder="intro-to-forex" className={fieldCls} />
              </div>
              <div>
                <label className={labelCls}>Type</label>
                <select value={form.lessonType} onChange={(e) => setForm((f) => ({ ...f, lessonType: e.target.value }))} className={selectCls}>
                  <option value="VIDEO">Video</option>
                  <option value="TEXT">Text</option>
                  <option value="RESOURCE">Resource</option>
                  <option value="WEBINAR_REPLAY">Webinar Replay</option>
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>Title *</label>
              <input required value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Lesson title" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Video URL</label>
              <input type="url" value={form.videoUrl} onChange={(e) => setForm((f) => ({ ...f, videoUrl: e.target.value }))} placeholder="https://youtube.com/watch?v=…" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Embed URL</label>
              <input type="url" value={form.embedUrl} onChange={(e) => setForm((f) => ({ ...f, embedUrl: e.target.value }))} placeholder="https://www.youtube.com/embed/…" className={fieldCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Duration (min)</label>
                <input type="number" min={1} value={form.durationMinutes} onChange={(e) => setForm((f) => ({ ...f, durationMinutes: e.target.value }))} className={fieldCls} />
              </div>
              <div>
                <label className={labelCls}>Sort order</label>
                <input type="number" min={0} value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))} className={fieldCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={selectCls}>
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED">Published</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
            {err ? <p className="text-xs text-danger">{err}</p> : null}
            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close asChild><GhostButton type="button">Cancel</GhostButton></Dialog.Close>
              <PrimaryButton type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : "Create lesson"}</PrimaryButton>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Create Webinar Dialog ─────────────────────────────────────
function CreateWebinarDialog({ courses, onCreated }: { courses: AcademyCourseDto[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ courseId: "", title: "", description: "", startTime: "", endTime: "", timezone: "", joinUrl: "", replayUrl: "", status: "SCHEDULED" });
  const [err, setErr] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/admin/academy/webinars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: form.courseId || null,
          title: form.title,
          description: form.description || undefined,
          startTime: new Date(form.startTime).toISOString(),
          endTime: form.endTime ? new Date(form.endTime).toISOString() : null,
          timezone: form.timezone || undefined,
          joinUrl: form.joinUrl || null,
          replayUrl: form.replayUrl || null,
          status: form.status,
        }),
      }),
    onSuccess: () => { setOpen(false); setForm({ courseId: "", title: "", description: "", startTime: "", endTime: "", timezone: "", joinUrl: "", replayUrl: "", status: "SCHEDULED" }); onCreated(); },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <PrimaryButton type="button"><Plus className="mr-1.5 h-4 w-4 inline-block" />New Webinar</PrimaryButton>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 focus:outline-none max-h-[90vh] invisible-scrollbar overflow-y-auto">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-foreground">Create webinar</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="grid h-8 w-8 place-items-center rounded-full border border-line text-muted hover:text-foreground"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErr(""); mutation.mutate(); }} className="space-y-4">
            <div>
              <label className={labelCls}>Title *</label>
              <input required value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Webinar title" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Related course</label>
              <select value={form.courseId} onChange={(e) => setForm((f) => ({ ...f, courseId: e.target.value }))} className={selectCls}>
                <option value="">None</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Description</label>
              <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} className={textareaCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Start time *</label>
                <input required type="datetime-local" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} className={fieldCls} />
              </div>
              <div>
                <label className={labelCls}>End time</label>
                <input type="datetime-local" value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} className={fieldCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Timezone</label>
              <input value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))} placeholder="UTC, America/New_York…" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Zoom / Join URL</label>
              <input type="url" value={form.joinUrl} onChange={(e) => setForm((f) => ({ ...f, joinUrl: e.target.value }))} placeholder="https://zoom.us/j/…" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Replay URL</label>
              <input type="url" value={form.replayUrl} onChange={(e) => setForm((f) => ({ ...f, replayUrl: e.target.value }))} placeholder="https://…" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={selectCls}>
                <option value="SCHEDULED">Scheduled</option>
                <option value="LIVE">Live</option>
                <option value="COMPLETED">Completed</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>
            {err ? <p className="text-xs text-danger">{err}</p> : null}
            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close asChild><GhostButton type="button">Cancel</GhostButton></Dialog.Close>
              <PrimaryButton type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : "Create webinar"}</PrimaryButton>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export default function AdminAcademyPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("courses");

  const { data: analytics } = useQuery<Analytics>({
    queryKey: ["admin-academy-analytics"],
    queryFn: () => apiFetch("/api/admin/academy/analytics"),
  });

  const { data: courses = [], isLoading: coursesLoading } = useQuery<AcademyCourseDto[]>({
    queryKey: ["admin-academy-courses"],
    queryFn: () => apiFetch("/api/admin/academy/courses"),
  });

  const { data: webinars = [], isLoading: webinarsLoading } = useQuery<AcademyWebinarDto[]>({
    queryKey: ["admin-academy-webinars"],
    queryFn: () => apiFetch("/api/admin/academy/webinars"),
  });

  const { data: progress = [], isLoading: progressLoading } = useQuery<AcademyProgressSummaryDto[]>({
    queryKey: ["admin-academy-progress"],
    queryFn: () => apiFetch("/api/admin/academy/progress"),
  });

  // Selected course for lesson view
  const [selectedCourseId, setSelectedCourseId] = useState<string>("");

  const { data: lessons = [], isLoading: lessonsLoading } = useQuery<AcademyLessonDto[]>({
    queryKey: ["admin-academy-lessons", selectedCourseId],
    queryFn: () => apiFetch(`/api/admin/academy/lessons?courseId=${selectedCourseId}`),
    enabled: Boolean(selectedCourseId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-academy-courses"] });
    qc.invalidateQueries({ queryKey: ["admin-academy-analytics"] });
    qc.invalidateQueries({ queryKey: ["admin-academy-lessons", selectedCourseId] });
    qc.invalidateQueries({ queryKey: ["admin-academy-webinars"] });
    qc.invalidateQueries({ queryKey: ["admin-academy-progress"] });
  };

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Academy"
      description="Manage courses, modules, lessons, and webinars"
      action={
        <PageActionGroup>
          {tab === "courses" && <CreateCourseDialog onCreated={refresh} />}
          {tab === "lessons" && <CreateLessonDialog courses={courses} onCreated={refresh} />}
          {tab === "webinars" && <CreateWebinarDialog courses={courses} onCreated={refresh} />}
        </PageActionGroup>
      }
    >
      <div className="mb-5">
        <InlineStatusStrip items={[
          { label: "Published courses", value: analytics?.publishedCourses ?? 0, helper: `${analytics?.totalCourses ?? 0} total`, tone: "accent" },
          { label: "Published lessons", value: analytics?.publishedLessons ?? 0, helper: `${analytics?.totalLessons ?? 0} total` },
          { label: "Completions", value: analytics?.totalCompletions ?? 0 },
          { label: "Open questions", value: analytics?.openQuestions ?? 0, helper: `${analytics?.totalQuestions ?? 0} total`, tone: analytics?.openQuestions ? "danger" : undefined },
        ]} />
      </div>

      <FilterChipRow
        chips={[
          { label: "Courses", active: tab === "courses", onClick: () => setTab("courses") },
          { label: "Lessons", active: tab === "lessons", onClick: () => setTab("lessons") },
          { label: "Webinars", active: tab === "webinars", onClick: () => setTab("webinars") },
          { label: "Trader progress", active: tab === "progress", onClick: () => setTab("progress") },
        ]}
      />

      <div className="mt-4">
        {/* Courses */}
        {tab === "courses" && (
          coursesLoading ? (
            <div className="h-32 animate-pulse rounded-[4px] bg-panel" />
          ) : courses.length === 0 ? (
            <EmptyState title="No courses yet" description="Create your first course to get started." icon={BookOpenCheck} />
          ) : (
            <DataTable
              headers={["Title", "Slug", "Difficulty", "Modules", "Lessons", "Status", ""]}
              rows={courses.map((c) => [
                <span key="t" className="font-semibold text-foreground">{c.title}</span>,
                <span key="s" className="text-muted text-xs font-mono">{c.slug}</span>,
                c.difficulty ? <StatusPill key="d" tone="muted">{c.difficulty}</StatusPill> : <span key="d" className="text-muted">—</span>,
                c.moduleCount,
                c.lessonCount,
                <StatusPill key="st" tone={STATUS_TONE[c.status] ?? "muted"}>{c.status}</StatusPill>,
                <EditCourseDialog key="e" course={c} onUpdated={refresh} />,
              ])}
            />
          )
        )}

        {/* Lessons */}
        {tab === "lessons" && (
          <div className="space-y-4">
            <Panel>
              <label className={labelCls}>Filter by course</label>
              <select value={selectedCourseId} onChange={(e) => setSelectedCourseId(e.target.value)} className={selectCls}>
                <option value="">Select a course…</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </Panel>
            {!selectedCourseId ? (
              <EmptyState title="Select a course" description="Choose a course above to view its lessons." icon={BookOpenCheck} />
            ) : lessonsLoading ? (
              <div className="h-32 animate-pulse rounded-[4px] bg-panel" />
            ) : lessons.length === 0 ? (
              <EmptyState title="No lessons" description="Create the first lesson for this course." icon={BookOpenCheck} />
            ) : (
              <DataTable
                headers={["Title", "Slug", "Type", "Duration", "Order", "Status"]}
                rows={lessons.map((l) => [
                  <span key="t" className="font-semibold text-foreground">{l.title}</span>,
                  <span key="s" className="text-muted text-xs font-mono">{l.slug}</span>,
                  <StatusPill key="type" tone="muted">{l.lessonType}</StatusPill>,
                  l.durationMinutes ? `${l.durationMinutes}m` : "—",
                  l.sortOrder,
                  <StatusPill key="st" tone={STATUS_TONE[l.status] ?? "muted"}>{l.status}</StatusPill>,
                ])}
              />
            )}
          </div>
        )}

        {/* Webinars */}
        {tab === "webinars" && (
          webinarsLoading ? (
            <div className="h-32 animate-pulse rounded-[4px] bg-panel" />
          ) : webinars.length === 0 ? (
            <EmptyState title="No webinars" description="Schedule the first webinar." icon={BookOpenCheck} />
          ) : (
            <DataTable
              headers={["Title", "Course", "Start", "Status", "Join URL"]}
              rows={webinars.map((w) => [
                <span key="t" className="font-semibold text-foreground">{w.title}</span>,
                w.courseTitle ?? "—",
                new Date(w.startTime).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
                <StatusPill key="st" tone={w.status === "LIVE" ? "lime" : w.status === "SCHEDULED" ? "accent" : w.status === "CANCELLED" ? "danger" : "muted"}>{w.status}</StatusPill>,
                w.joinUrl ? <a key="j" href={w.joinUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline truncate block max-w-[160px]">Open link</a> : "—",
              ])}
            />
          )
        )}

        {tab === "progress" && (
          progressLoading ? (
            <div className="h-32 animate-pulse rounded-[4px] bg-panel" />
          ) : progress.length === 0 ? (
            <EmptyState title="No learner activity yet" description="Trader course progress will appear after a lesson is started." icon={BookOpenCheck} />
          ) : (
            <DataTable
              headers={["Trader", "Course", "Completion", "Status", "Last activity"]}
              rows={progress.map((row) => [
                <div key="trader">
                  <p className="font-semibold text-foreground">{row.traderName ?? "Unnamed trader"}</p>
                  <p className="text-xs text-muted">{row.traderEmail ?? "No email"}</p>
                </div>,
                <span key="course" className="font-semibold text-foreground">{row.courseTitle}</span>,
                <div key="completion" className="min-w-36">
                  <div className="flex justify-between gap-3 text-xs text-muted">
                    <span>{row.completedLessons}/{row.totalLessons} lessons</span>
                    <span>{row.completionPercent}%</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-strong">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${row.completionPercent}%` }} />
                  </div>
                </div>,
                <StatusPill key="label" tone={row.label === "EXCELLENT" ? "lime" : row.label === "GOOD" ? "accent" : "danger"}>{row.label}</StatusPill>,
                <span key="activity">{row.lastActivityAt ? new Date(row.lastActivityAt).toLocaleString() : "Not started"}</span>,
              ])}
            />
          )
        )}
      </div>
    </WorkspacePage>
  );
}
