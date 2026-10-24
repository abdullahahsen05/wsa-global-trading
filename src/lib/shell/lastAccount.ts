/**
 * The trading account this browser looked at last, per person - so the dashboard can ask for that account's trades,
 * risk rules, statistics and chart at the same moment it asks for the account list, instead of after it.
 *
 * It is a guess, never an authority: every request still goes through the server's own owner check, a wrong guess
 * (the account was removed, another person signed in) only costs the requests that were sent for it, and the page
 * always switches to the account the list really says. Nothing here is a credential: an account id, per person.
 */
export const LAST_ACCOUNT_KEY = "wsa.lastAccount.v1";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLastAccount(raw: string | null, userId: string): string | null {
  if (!raw || !userId) return null;
  try {
    const value = JSON.parse(raw) as { u?: unknown; a?: unknown } | null;
    if (!value || typeof value !== "object") return null;
    if (value.u !== userId) return null;
    return typeof value.a === "string" && ACCOUNT_ID.test(value.a) ? value.a : null;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The account this person looked at last in this browser, or null. */
export function readLastAccount(userId: string): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return parseLastAccount(store.getItem(LAST_ACCOUNT_KEY), userId);
  } catch {
    return null;
  }
}

export function rememberLastAccount(userId: string, accountId: string): void {
  const store = storage();
  if (!store || !userId || !ACCOUNT_ID.test(accountId)) return;
  try {
    if (parseLastAccount(store.getItem(LAST_ACCOUNT_KEY), userId) === accountId) return;
    store.setItem(LAST_ACCOUNT_KEY, JSON.stringify({ u: userId, a: accountId }));
  } catch {
    // a full or blocked storage: the guess is a courtesy
  }
}

export function forgetLastAccount(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    // nothing to do
  }
}
