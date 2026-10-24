import { parseUserRole, type UserRole } from "@/lib/auth/rbac";
import { forgetAccessHint } from "@/lib/shell/accessHint";

/**
 * What the app shell remembers about the last VERIFIED session, in this browser only.
 *
 * It exists for one reason: a reload used to show a bare page until the server had answered "who are you", then
 * rebuilt the whole screen (sidebar, top bar, the page itself) - a second of nothing, then everything twice. With the
 * hint the shell draws its navigation at once and the pages start their own requests in parallel with the session check.
 *
 * It is a HINT, never a credential: it holds an id and a role (no e-mail, no name, no token), every page load asks the
 * server again and the answer replaces it, and it only decides which navigation is DRAWN - every page and every API
 * still checks the real session. It is cleared on the sign-in pages and on log-out.
 */
export interface ShellHint {
  id: string;
  role: UserRole;
}

export const SHELL_HINT_KEY = "wsa.shell.v1";
/** An older hint is ignored (the server would have said by then). */
export const SHELL_HINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The same person and role are not written again within this time. */
const SHELL_HINT_REFRESH_MS = 60 * 60 * 1000;
const MAX_ID_LENGTH = 64;
const CLOCK_SLACK_MS = 60_000;

/** The stored text as a hint, or null when it is missing, damaged, from the future or too old. Pure. */
export function parseShellHint(raw: string | null, now: number): (ShellHint & { at: number }) | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { id?: unknown; role?: unknown; at?: unknown } | null;
    if (!value || typeof value !== "object") return null;
    const role = parseUserRole(value.role);
    if (!role) return null;
    if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > MAX_ID_LENGTH) return null;
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
    if (now - value.at > SHELL_HINT_MAX_AGE_MS || value.at - now > CLOCK_SLACK_MS) return null;
    return { id: value.id, role, at: value.at };
  } catch {
    return null;
  }
}

export function serializeShellHint(hint: ShellHint, now: number): string {
  return JSON.stringify({ id: hint.id, role: hint.role, at: now });
}

type Entry = (ShellHint & { at: number }) | null;

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedEntry: Entry = null;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked storage (private window, site data off): the shell just works without the hint
  }
}

function readEntry(): Entry {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(SHELL_HINT_KEY);
  } catch {
    return null;
  }
  if (raw === cachedRaw) return cachedEntry;
  cachedRaw = raw;
  cachedEntry = parseShellHint(raw, Date.now());
  return cachedEntry;
}

/** The remembered session, as a stable object (the same one until storage changes): what `useSyncExternalStore` needs. */
export function readShellHint(): ShellHint | null {
  return readEntry();
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeShellHint(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SHELL_HINT_KEY) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Remembers the verified session (skipped when the same person and role were written less than an hour ago). */
export function rememberShellHint(hint: ShellHint): void {
  const store = storage();
  if (!store) return;
  const now = Date.now();
  const current = readEntry();
  if (current && current.id === hint.id && current.role === hint.role && now - current.at < SHELL_HINT_REFRESH_MS) return;
  try {
    store.setItem(SHELL_HINT_KEY, serializeShellHint(hint, now));
  } catch {
    return;
  }
  notify();
}

export function clearShellHint(): void {
  // (the remembered "subscription active" belongs to the remembered session: both go together)
  forgetAccessHint();
  const store = storage();
  if (!store) return;
  try {
    if (store.getItem(SHELL_HINT_KEY) === null) return;
    store.removeItem(SHELL_HINT_KEY);
  } catch {
    return;
  }
  notify();
}

/** Test helper: forget what was read. */
export function resetShellHintCache(): void {
  cachedRaw = undefined;
  cachedEntry = null;
}
