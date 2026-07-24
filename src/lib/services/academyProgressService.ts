import { createAdminClient } from "@/lib/supabase/admin";
import type {
  AcademyProgressLabel,
  AcademyProgressSummaryDto,
  CourseProgressDto,
  MyAcademyProgressDto,
} from "@/lib/domain/types";

export function getAcademyProgressLabel(percent: number): AcademyProgressLabel {
  if (percent >= 80) return "EXCELLENT";
  if (percent >= 40) return "GOOD";
  return "BAD";
}

function completionPercent(completed: number, total: number): number {
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

export async function getMyAcademyProgress(userId: string): Promise<MyAcademyProgressDto> {
  const supabase = createAdminClient();
  const [{ data: courses }, { data: lessons }, { data: progress }] = await Promise.all([
    supabase.from("academy_courses").select("id, title, slug").eq("status", "PUBLISHED").order("title"),
    supabase.from("academy_lessons").select("id, course_id").eq("status", "PUBLISHED"),
    supabase
      .from("academy_lesson_progress")
      .select("course_id, lesson_id, status, last_watched_at")
      .eq("user_id", userId),
  ]);

  const lessonCount = new Map<string, number>();
  for (const lesson of lessons ?? []) lessonCount.set(lesson.course_id, (lessonCount.get(lesson.course_id) ?? 0) + 1);

  const completed = new Map<string, number>();
  const lastActivity = new Map<string, string>();
  for (const row of progress ?? []) {
    if (row.status === "COMPLETED") completed.set(row.course_id, (completed.get(row.course_id) ?? 0) + 1);
    const prior = lastActivity.get(row.course_id);
    if (!prior || row.last_watched_at > prior) lastActivity.set(row.course_id, row.last_watched_at);
  }

  const courseRows: AcademyProgressSummaryDto[] = (courses ?? []).map((course) => {
    const totalLessons = lessonCount.get(course.id) ?? 0;
    const completedLessons = completed.get(course.id) ?? 0;
    const percent = completionPercent(completedLessons, totalLessons);
    return {
      userId,
      traderName: null,
      traderEmail: null,
      courseId: course.id,
      courseTitle: course.title,
      courseSlug: course.slug,
      completedLessons,
      totalLessons,
      completionPercent: percent,
      label: getAcademyProgressLabel(percent),
      lastActivityAt: lastActivity.get(course.id) ?? null,
    };
  });
  const totalLessons = courseRows.reduce((sum, row) => sum + row.totalLessons, 0);
  const completedLessons = courseRows.reduce((sum, row) => sum + row.completedLessons, 0);
  const percent = completionPercent(completedLessons, totalLessons);
  return {
    completionPercent: percent,
    label: getAcademyProgressLabel(percent),
    completedLessons,
    totalLessons,
    courses: courseRows,
  };
}

export async function listAcademyProgressForAdmin(): Promise<AcademyProgressSummaryDto[]> {
  const supabase = createAdminClient();
  const [{ data: lessons }, { data: progress, error }] = await Promise.all([
    supabase.from("academy_lessons").select("course_id").eq("status", "PUBLISHED"),
    supabase
      .from("academy_lesson_progress")
      .select("user_id, course_id, status, last_watched_at, profiles!inner(full_name, email, role), academy_courses!inner(title, slug)")
      .eq("profiles.role", "TRADER")
      .limit(10_000),
  ]);
  if (error) throw new Error(`Failed to load academy progress: ${error.message}`);

  const lessonCount = new Map<string, number>();
  for (const lesson of lessons ?? []) lessonCount.set(lesson.course_id, (lessonCount.get(lesson.course_id) ?? 0) + 1);

  type Group = {
    userId: string;
    courseId: string;
    name: string | null;
    email: string | null;
    title: string;
    slug: string;
    completed: number;
    lastActivityAt: string | null;
  };
  const groups = new Map<string, Group>();
  for (const row of progress ?? []) {
    const profile = row.profiles as unknown as { full_name: string | null; email: string | null };
    const course = row.academy_courses as unknown as { title: string; slug: string };
    const key = `${row.user_id}:${row.course_id}`;
    const group = groups.get(key) ?? {
      userId: row.user_id,
      courseId: row.course_id,
      name: profile.full_name,
      email: profile.email,
      title: course.title,
      slug: course.slug,
      completed: 0,
      lastActivityAt: null,
    };
    if (row.status === "COMPLETED") group.completed += 1;
    if (!group.lastActivityAt || row.last_watched_at > group.lastActivityAt) group.lastActivityAt = row.last_watched_at;
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map((group) => {
      const totalLessons = lessonCount.get(group.courseId) ?? 0;
      const percent = completionPercent(group.completed, totalLessons);
      return {
        userId: group.userId,
        traderName: group.name,
        traderEmail: group.email,
        courseId: group.courseId,
        courseTitle: group.title,
        courseSlug: group.slug,
        completedLessons: group.completed,
        totalLessons,
        completionPercent: percent,
        label: getAcademyProgressLabel(percent),
        lastActivityAt: group.lastActivityAt,
      };
    })
    .sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));
}

export async function getCourseProgress(
  userId: string,
  courseId: string
): Promise<CourseProgressDto> {
  const supabase = createAdminClient();

  const [publishedLessons, completedProgress] = await Promise.all([
    supabase
      .from("academy_lessons")
      .select("id, slug", { count: "exact" })
      .eq("course_id", courseId)
      .eq("status", "PUBLISHED"),
    supabase
      .from("academy_lesson_progress")
      .select("lesson_id, last_watched_at, updated_at")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .eq("status", "COMPLETED")
      .order("updated_at", { ascending: false }),
  ]);

  const total = (publishedLessons.data ?? []).length;
  const completedRows = completedProgress.data ?? [];
  const completed = completedRows.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Last touched (any status, IN_PROGRESS or COMPLETED)
  const { data: lastRow } = await supabase
    .from("academy_lesson_progress")
    .select("lesson_id")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .order("last_watched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastLessonId = (lastRow as { lesson_id: string } | null)?.lesson_id ?? null;

  let lastLessonSlug: string | null = null;
  let lastCourseSlug: string | null = null;

  if (lastLessonId) {
    const { data: lessonRow } = await supabase
      .from("academy_lessons")
      .select("slug, academy_courses(slug)")
      .eq("id", lastLessonId)
      .maybeSingle();
    if (lessonRow) {
      const lr = lessonRow as Record<string, unknown>;
      lastLessonSlug = lr.slug as string;
      const course = lr.academy_courses as Record<string, unknown> | null;
      lastCourseSlug = (course?.slug as string | null) ?? null;
    }
  }

  return {
    courseId,
    completedLessons: completed,
    totalLessons: total,
    progressPercent: percent,
    lastLessonId,
    lastLessonSlug,
    lastCourseSlug,
  };
}

export async function markLessonStarted(userId: string, lessonId: string): Promise<void> {
  const supabase = createAdminClient();

  // Get course_id for the lesson
  const { data: lesson } = await supabase
    .from("academy_lessons")
    .select("course_id")
    .eq("id", lessonId)
    .maybeSingle();

  if (!lesson) return;

  const courseId = (lesson as { course_id: string }).course_id;

  // Upsert — do not overwrite COMPLETED status
  const { data: existing } = await supabase
    .from("academy_lesson_progress")
    .select("id, status")
    .eq("user_id", userId)
    .eq("lesson_id", lessonId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("academy_lesson_progress")
      .update({ last_watched_at: new Date().toISOString() })
      .eq("id", (existing as { id: string }).id);
  } else {
    await supabase.from("academy_lesson_progress").insert({
      user_id: userId,
      course_id: courseId,
      lesson_id: lessonId,
      status: "IN_PROGRESS",
      last_watched_at: new Date().toISOString(),
    });
  }
}

export async function markLessonComplete(userId: string, lessonId: string): Promise<void> {
  const supabase = createAdminClient();

  const { data: lesson } = await supabase
    .from("academy_lessons")
    .select("course_id")
    .eq("id", lessonId)
    .maybeSingle();

  if (!lesson) return;

  const courseId = (lesson as { course_id: string }).course_id;
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from("academy_lesson_progress")
    .select("id")
    .eq("user_id", userId)
    .eq("lesson_id", lessonId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("academy_lesson_progress")
      .update({ status: "COMPLETED", completed_at: now, last_watched_at: now })
      .eq("id", (existing as { id: string }).id);
  } else {
    await supabase.from("academy_lesson_progress").insert({
      user_id: userId,
      course_id: courseId,
      lesson_id: lessonId,
      status: "COMPLETED",
      completed_at: now,
      last_watched_at: now,
    });
  }

  const { autoStartEligibleEvaluationsForCourse } = await import("@/lib/services/evaluationService");
  await autoStartEligibleEvaluationsForCourse(userId, courseId);
}

export async function getProgressMapForUser(
  userId: string,
  courseId: string
): Promise<Record<string, "IN_PROGRESS" | "COMPLETED">> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("academy_lesson_progress")
    .select("lesson_id, status")
    .eq("user_id", userId)
    .eq("course_id", courseId);

  const map: Record<string, "IN_PROGRESS" | "COMPLETED"> = {};
  for (const row of data ?? []) {
    const r = row as { lesson_id: string; status: string };
    map[r.lesson_id] = r.status as "IN_PROGRESS" | "COMPLETED";
  }
  return map;
}
