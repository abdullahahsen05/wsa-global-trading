"use client";

import { useQuery } from "@tanstack/react-query";
import type { UserRole } from "@/lib/domain/types";

/** The signed-in person, as `GET /api/auth/session` describes them. */
export interface SessionPayload {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED" | "PENDING";
}

/**
 * ONE query key for "who is signed in". The shell, the dashboards, the settings page and the
 * contact form all read it, so a page load asks the server once (it used to ask twice, under
 * `auth-session-shell` and `session`). The settings page invalidates it after a profile change.
 *
 * Data is `null` when the server said nobody is signed in (401 / 403) and an ERROR when it could
 * not say at all (a busy server, a rate limit, a dropped connection) - a hiccup is not a log-out.
 */
export const SESSION_QUERY_KEY = ["session"] as const;

const SESSION_STALE_MS = 60_000;

export async function fetchSessionPayload(signal?: AbortSignal): Promise<SessionPayload | null> {
  const response = await fetch("/api/auth/session", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (response.status === 401 || response.status === 403) return null;
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: SessionPayload;
    error?: { code?: string; message?: string };
  } | null;
  if (response.ok && body?.ok && body.data) return body.data;
  if (body?.ok === false && body.error?.code === "UNAUTHORIZED") return null;
  throw new Error(body?.error?.message ?? "Could not verify your session.");
}

/** Who is signed in (`null`: nobody). Shared by every caller, so it costs one request per minute at most. */
export function useSessionUser(options: { enabled?: boolean } = {}) {
  return useQuery<SessionPayload | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSessionPayload(signal),
    enabled: options.enabled ?? true,
    staleTime: SESSION_STALE_MS,
    refetchOnWindowFocus: false,
  });
}
