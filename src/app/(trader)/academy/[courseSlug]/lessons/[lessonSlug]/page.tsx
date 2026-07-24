"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { CheckCircle2, BookOpenCheck } from "lucide-react";
import { textareaClassName } from "@/components/app/WorkspaceUI";
import type { AcademyLessonDto } from "@/lib/domain/types";

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

function VideoEmbed({ lesson }: { lesson: AcademyLessonDto }) {
  const src = lesson.embedUrl ?? lesson.videoUrl;
  if (!src) return null;

  // YouTube/Vimeo/generic iframe embed
  const isEmbed =
    lesson.embedUrl ||
    src.includes("youtube.com/embed") ||
    src.includes("player.vimeo.com") ||
    src.includes("zoom.us/rec");

  if (isEmbed) {
    return (
      <div className="relative w-full overflow-hidden rounded-[4px]" style={{ paddingBottom: "56.25%" }}>
        <iframe
          src={src}
          className="absolute inset-0 h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          title={lesson.title}
        />
      </div>
    );
  }

  // Plain video URL
  return (
    <video
      src={src}
      controls
      className="w-full rounded-[4px] bg-black"
      style={{ maxHeight: "480px" }}
    />
  );
}

export default function LessonPage({
  params,
}: {
  params: Promise<{ courseSlug: string; lessonSlug: string }>;
}) {
  const { courseSlug, lessonSlug } = use(params);
  const qc = useQueryClient();

  const { data: lesson, isLoading, isError, error } = useQuery<AcademyLessonDto>({
    queryKey: ["academy-lesson", courseSlug, lessonSlug],
    queryFn: () => apiFetch(`/api/academy/courses/${courseSlug}/lessons/${lessonSlug}`),
  });

  // Mark started on load
  const startMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/academy/lessons/${id}/start`, { method: "POST" }),
  });

  useEffect(() => {
    if (lesson && lesson.progressStatus === null) {
      startMutation.mutate(lesson.id);
    }
    // Only run once when lesson first loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.id]);

  const completeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/academy/lessons/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["academy-lesson", courseSlug, lessonSlug] });
      qc.invalidateQueries({ queryKey: ["academy-course", courseSlug] });
    },
  });

  // Notes
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const note = noteDraft ?? lesson?.note ?? "";

  const saveNoteMutation = useMutation({
    mutationFn: (text: string) =>
      apiFetch(`/api/academy/lessons/${lesson!.id}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: text }),
      }),
    onSuccess: () => {
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 3000);
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/academy/lessons/${lesson!.id}/notes`, { method: "DELETE" }),
    onSuccess: () => {
      setNoteDraft("");
      qc.invalidateQueries({ queryKey: ["academy-lesson", courseSlug, lessonSlug] });
    },
  });

  // Q&A
  const [question, setQuestion] = useState("");
  const [questionError, setQuestionError] = useState("");

  const askMutation = useMutation({
    mutationFn: (q: string) =>
      apiFetch(`/api/academy/lessons/${lesson!.id}/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      }),
    onSuccess: () => {
      setQuestion("");
      qc.invalidateQueries({ queryKey: ["academy-lesson", courseSlug, lessonSlug] });
    },
    onError: (err: Error) => setQuestionError(err.message),
  });

  if (isLoading) {
    return (
      <WorkspacePage eyebrow="Academy" title="Loading…" description="">
        <div className="h-64 animate-pulse rounded-[4px] bg-panel" />
      </WorkspacePage>
    );
  }

  if (isError || !lesson) {
    return (
      <WorkspacePage eyebrow="Academy" title="Error" description="">
        <Panel>
          <p className="text-sm text-danger">
            {error instanceof Error ? error.message : "Lesson not found."}
          </p>
        </Panel>
      </WorkspacePage>
    );
  }

  const isComplete = lesson.progressStatus === "COMPLETED";

  return (
    <WorkspacePage
      eyebrow={`Academy · ${courseSlug.replace(/-/g, " ")}`}
      title={lesson.title}
      description={lesson.summary ?? ""}
      action={
        <Link href={`/academy/${courseSlug}`} className="btn-dark text-sm">
          ← Back to course
        </Link>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Main content */}
        <div className="space-y-5">
          {/* Video */}
          {(lesson.videoUrl || lesson.embedUrl) && (
            <Panel className="!p-0 overflow-hidden">
              <VideoEmbed lesson={lesson} />
            </Panel>
          )}

          {/* Lesson content */}
          {lesson.content ? (
            <Panel>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted">Content</h2>
              <div className="prose prose-invert max-w-none text-sm text-muted leading-7 whitespace-pre-line">
                {lesson.content}
              </div>
            </Panel>
          ) : null}

          {/* Mark complete */}
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {isComplete ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-accent-2" />
                    <span className="text-sm font-semibold text-accent-2">Lesson completed</span>
                  </>
                ) : (
                  <span className="text-sm text-muted">Mark this lesson as complete when you&apos;re done.</span>
                )}
              </div>
              {!isComplete ? (
                <button
                  type="button"
                  onClick={() => completeMutation.mutate(lesson.id)}
                  disabled={completeMutation.isPending}
                  className="btn-dark btn-active disabled:opacity-60"
                >
                  {completeMutation.isPending ? "Saving…" : "Mark complete"}
                </button>
              ) : null}
            </div>
          </Panel>

          {/* Instructor remarks */}
          {lesson.remarks.length > 0 ? (
            <Panel>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted">
                Instructor notes
              </h2>
              <div className="space-y-4">
                {lesson.remarks.map((remark) => (
                  <div
                    key={remark.id}
                    className={`rounded-[4px] border px-4 py-3 ${remark.pinned ? "border-accent/30 bg-accent/5" : "border-line bg-background"}`}
                  >
                    {remark.pinned ? (
                      <StatusPill tone="accent">Pinned</StatusPill>
                    ) : null}
                    {remark.title ? (
                      <p className="mt-1 text-sm font-semibold text-foreground">{remark.title}</p>
                    ) : null}
                    <p className="mt-1 text-sm text-muted leading-6 whitespace-pre-line">{remark.body}</p>
                    {remark.authorName ? (
                      <p className="mt-2 text-xs text-muted">— {remark.authorName}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}

          {/* Q&A */}
          <Panel>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted">
              Questions & Answers
            </h2>
            {lesson.questions.map((q) => (
              <div key={q.id} className="mb-4 rounded-[4px] border border-line bg-background px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-foreground">{q.question}</p>
                  <StatusPill tone={q.status === "ANSWERED" ? "lime" : "muted"}>{q.status}</StatusPill>
                </div>
                {q.answer ? (
                  <div className="mt-3 rounded-[4px] border-l-2 border-accent pl-3">
                    <p className="text-xs font-semibold text-accent mb-1">Instructor answer</p>
                    <p className="text-sm text-muted leading-5 whitespace-pre-line">{q.answer}</p>
                  </div>
                ) : null}
              </div>
            ))}
            <div className="mt-2 space-y-2">
              <textarea
                value={question}
                onChange={(e) => { setQuestion(e.target.value); setQuestionError(""); }}
                placeholder="Ask the instructor a question…"
                rows={3}
                className={textareaClassName}
              />
              {questionError ? <p className="text-xs text-danger">{questionError}</p> : null}
              <button
                type="button"
                disabled={question.trim().length < 5 || askMutation.isPending}
                onClick={() => { setQuestionError(""); askMutation.mutate(question.trim()); }}
                className="btn-dark disabled:opacity-60"
              >
                {askMutation.isPending ? "Submitting…" : "Submit question"}
              </button>
            </div>
          </Panel>
        </div>

        {/* Right sidebar */}
        <div className="space-y-5">
          {/* Materials */}
          {lesson.materials.length > 0 ? (
            <Panel>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted">
                Materials
              </h2>
              <ul className="space-y-2">
                {lesson.materials.map((m) => (
                  <li key={m.id}>
                    <a
                      href={m.materialUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-[4px] border border-line bg-background px-3 py-2.5 text-sm font-semibold text-foreground transition hover:border-accent/40 hover:text-accent"
                    >
                      <BookOpenCheck className="h-4 w-4 shrink-0 text-muted" />
                      <span className="truncate">{m.title}</span>
                      {m.materialType ? (
                        <StatusPill tone="muted">{m.materialType}</StatusPill>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {/* Notes */}
          <Panel>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-muted">
              My notes
            </h2>
            <p className="mb-3 text-xs text-muted">Private — only you can see these.</p>
            <textarea
              value={note}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add your personal notes here…"
              rows={6}
              className={textareaClassName}
            />
            {lesson.noteSavedAt ? (
              <p className="mt-1 text-xs text-muted">
                Last saved {new Date(lesson.noteSavedAt).toLocaleTimeString()}
              </p>
            ) : null}
            {noteSaved ? (
              <p className="mt-1 text-xs font-semibold text-accent-2">Saved!</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={saveNoteMutation.isPending || !note.trim()}
                onClick={() => saveNoteMutation.mutate(note.trim())}
                className="btn-dark btn-active flex-1 disabled:opacity-60"
              >
                {saveNoteMutation.isPending ? "Saving…" : "Save note"}
              </button>
              {note ? (
                <button
                  type="button"
                  onClick={() => deleteNoteMutation.mutate()}
                  disabled={deleteNoteMutation.isPending}
                  className="btn-dark disabled:opacity-60"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </Panel>

          {/* Lesson meta */}
          <Panel>
            <div className="space-y-2 text-xs text-muted">
              <div className="flex justify-between">
                <span>Type</span>
                <span className="font-semibold text-foreground">{lesson.lessonType}</span>
              </div>
              {lesson.durationMinutes ? (
                <div className="flex justify-between">
                  <span>Duration</span>
                  <span className="font-semibold text-foreground">{lesson.durationMinutes} min</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span>Progress</span>
                <span className={`font-semibold ${isComplete ? "text-accent-2" : "text-foreground"}`}>
                  {isComplete ? "Completed" : lesson.progressStatus === "IN_PROGRESS" ? "In progress" : "Not started"}
                </span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </WorkspacePage>
  );
}
