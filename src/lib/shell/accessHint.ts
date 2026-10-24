/**
 * Whether this browser last saw the platform subscription ACTIVE for a person - so the gated pages (trades, reports,
 * analytics, accounts, risk, the terminal ...) can start drawing and asking for their own data at once instead of after
 * the access check has come back. Without it every one of those pages showed "Loading your platform access status." for
 * the length of one request and only THEN began its own requests (two round trips in a row before the first figure).
 *
 * It is a HINT for drawing, never an authority: the access check is asked every time and its answer replaces the guess
 * (a subscription that has lapsed switches the page to the locked view as soon as the answer is in), every API still
 * checks the real session, and nothing but "this person, active, at this time" is stored (no name, e-mail or token). It
 * is forgotten at log-out together with the shell hint. A hint older than `ACCESS_HINT_MAX_AGE_MS` is ignored.
 */
export const ACCESS_HINT_KEY = "wsa.access.v1";
export const ACCESS_HINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** The same person is not written again within this time. */
const ACCESS_HINT_REFRESH_MS = 30 * 60 * 1000;
const MAX_ID_LENGTH = 64;
const CLOCK_SLACK_MS = 60_000;

/** True when the stored text says "active" for exactly this person and is neither too old nor from the future. Pure. */
export function parseAccessHint(raw: string | null, userId: string | null, now: number): boolean {
  if (!raw || !userId) return false;
  try {
    const value = JSON.parse(raw) as { u?: unknown; at?: unknown } | null;
    if (!value || typeof value !== "object") return false;
    if (typeof value.u !== "string" || value.u.length === 0 || value.u.length > MAX_ID_LENGTH) return false;
    if (value.u !== userId) return false;
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
    if (now - value.at > ACCESS_HINT_MAX_AGE_MS || value.at - now > CLOCK_SLACK_MS) return false;
    return true;
  } catch {
    return false;
  }
}

export function serializeAccessHint(userId: string, now: number): string {
  return JSON.stringify({ u: userId, at: now });
}

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked storage (private window, site data off): the pages simply wait for the answer
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Whether "active" is remembered for this person (a plain boolean, so `useSyncExternalStore` sees a stable value). */
export function readRememberedAccess(userId: string | null): boolean {
  const store = storage();
  if (!store || !userId) return false;
  try {
    return parseAccessHint(store.getItem(ACCESS_HINT_KEY), userId, Date.now());
  } catch {
    return false;
  }
}

export function subscribeAccessHint(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ACCESS_HINT_KEY) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/**
 * Records what the server said: "active" is remembered (not rewritten within half an hour), anything else forgets it,
 * so a lapsed subscription is not drawn as active again on the next visit.
 */
export function rememberAccessVerdict(userId: string, active: boolean): void {
  const store = storage();
  if (!store || !userId) return;
  try {
    if (!active) {
      if (store.getItem(ACCESS_HINT_KEY) === null) return;
      store.removeItem(ACCESS_HINT_KEY);
      notify();
      return;
    }
    const now = Date.now();
    const current = store.getItem(ACCESS_HINT_KEY);
    if (parseAccessHint(current, userId, now)) {
      try {
        const written = (JSON.parse(current as string) as { at: number }).at;
        if (now - written < ACCESS_HINT_REFRESH_MS) return;
      } catch {
        // damaged: written again below
      }
    }
    store.setItem(ACCESS_HINT_KEY, serializeAccessHint(userId, now));
  } catch {
    return;
  }
  notify();
}

/** Forgets the remembered access (log-out, a sign-in page, "nobody is signed in"). */
export function forgetAccessHint(): void {
  const store = storage();
  if (!store) return;
  try {
    if (store.getItem(ACCESS_HINT_KEY) === null) return;
    store.removeItem(ACCESS_HINT_KEY);
  } catch {
    return;
  }
  notify();
}
