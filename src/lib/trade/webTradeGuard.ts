/**
 * Two cheap protections around the order routes, kept in memory of the server
 * instance (so they are best effort, not a ledger):
 *
 *  - repeat protection: a request id that was already handled returns the stored
 *    answer instead of sending a second order (double click, a retry after a
 *    dropped response);
 *  - a ceiling per user and minute, so a runaway script cannot hammer the broker.
 *
 * The panel also disables its buttons while a request is in flight; these are the
 * server-side counterpart. Pure apart from the injected clock.
 */

export interface WebTradeGuardOptions {
  /** length of the rate window */
  windowMs: number;
  /** orders / changes one user may send inside the window */
  maxPerWindow: number;
  /** how long a handled request id is remembered */
  rememberMs: number;
  /** hard cap on remembered ids (oldest dropped first) */
  maxRemembered: number;
}

export const DEFAULT_WEB_TRADE_GUARD: WebTradeGuardOptions = {
  windowMs: 60_000,
  maxPerWindow: 30,
  rememberMs: 5 * 60_000,
  maxRemembered: 2000,
};

export class WebTradeGuard<T> {
  private readonly handled = new Map<string, { value: T; at: number }>();
  private readonly sent = new Map<string, number[]>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly options: WebTradeGuardOptions = DEFAULT_WEB_TRADE_GUARD,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Marks a request id as being processed. False when the same id is already in
   * flight (a second click while the first order is still travelling to the broker).
   */
  begin(userId: string, requestId: string): boolean {
    const key = `${userId}:${requestId}`;
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  /** Always call after `begin`, success or not. */
  end(userId: string, requestId: string): void {
    this.inFlight.delete(`${userId}:${requestId}`);
  }

  /** The stored answer of a request id this user already sent, if it is still remembered. */
  recall(userId: string, requestId: string): T | undefined {
    const key = `${userId}:${requestId}`;
    const entry = this.handled.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.options.rememberMs) {
      this.handled.delete(key);
      return undefined;
    }
    return entry.value;
  }

  remember(userId: string, requestId: string, value: T): void {
    const key = `${userId}:${requestId}`;
    this.handled.delete(key);
    this.handled.set(key, { value, at: this.now() });
    while (this.handled.size > this.options.maxRemembered) {
      const oldest = this.handled.keys().next();
      if (oldest.done) break;
      this.handled.delete(oldest.value);
    }
  }

  /** Counts one more send for the user; false when the user is over the ceiling (the send is then NOT counted). */
  allow(userId: string): boolean {
    const now = this.now();
    const recent = (this.sent.get(userId) ?? []).filter((at) => now - at < this.options.windowMs);
    if (recent.length >= this.options.maxPerWindow) {
      this.sent.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(userId, recent);
    if (this.sent.size > 5000) {
      for (const [user, stamps] of this.sent) {
        if (stamps.every((at) => now - at >= this.options.windowMs)) this.sent.delete(user);
      }
    }
    return true;
  }
}
