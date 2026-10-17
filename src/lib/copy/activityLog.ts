/**
 * A write-behind queue for activity rows: the copy engine records a line for every decision
 * and must never wait for the database to do so (a copy is worth milliseconds, a log line is not).
 * Rows are written in batches a moment later; a table that does not exist (migration not applied)
 * switches the queue off for a while; a failed write is tried again with the next batch.
 *
 * Pure apart from the injected `insert` / timers. Shared with the AWS workers.
 */

export interface ActivityDbError {
  code?: string;
  message?: string;
}

export interface ActivityLogOptions<Row> {
  /** writes a batch; resolves with the database's error (or null) */
  insert: (rows: Row[]) => Promise<{ error: ActivityDbError | null }>;
  /** how long rows may wait for company before they are written */
  flushMs?: number;
  /** the queue never holds more than this (the oldest rows are dropped) */
  maxQueue?: number;
  /** how long the queue stays off after the table turned out to be missing */
  missingTableBackoffMs?: number;
  now?: () => number;
  onProblem?: (message: string) => void;
}

/** 42P01 / PGRST205: the table is missing; 42703 / PGRST204: a column is missing. */
export function isMissingSchema(error: ActivityDbError | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || error.code === "42703" || error.code === "PGRST204";
}

export class ActivityLog<Row> {
  private queue: Row[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private offUntil = 0;
  private lastProblemAt = 0;
  private readonly flushMs: number;
  private readonly maxQueue: number;
  private readonly backoffMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ActivityLogOptions<Row>) {
    this.flushMs = options.flushMs ?? 400;
    this.maxQueue = options.maxQueue ?? 500;
    this.backoffMs = options.missingTableBackoffMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** True while the table is known to be missing (rows are dropped, not queued). */
  get disabled(): boolean {
    return this.now() < this.offUntil;
  }

  get pending(): number {
    return this.queue.length;
  }

  record(row: Row): void {
    if (this.disabled) return;
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push(row);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  /** Writes what is queued. Never rejects. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) return this.flushing;
    if (this.queue.length === 0) return Promise.resolve();
    const batch = this.queue.splice(0, this.queue.length);
    this.flushing = (async () => {
      try {
        const { error } = await this.options.insert(batch);
        if (!error) return;
        if (isMissingSchema(error)) {
          this.offUntil = this.now() + this.backoffMs;
          this.problem("the activity table is missing (migration 061 is not applied); activity is only written to the log");
          return;
        }
        this.requeue(batch);
        this.problem(`activity could not be stored: ${error.message ?? error.code ?? "unknown error"}`);
      } catch (error) {
        this.requeue(batch);
        this.problem(`activity could not be stored: ${error instanceof Error ? error.message : "unknown error"}`);
      } finally {
        this.flushing = null;
        if (this.queue.length > 0 && this.timer === null && !this.disabled) {
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
          }, Math.max(this.flushMs, 1_000));
          this.timer.unref?.();
        }
      }
    })();
    return this.flushing;
  }

  /** Failed rows go back to the front, so the order stays, and the queue stays bounded. */
  private requeue(batch: Row[]): void {
    this.queue = [...batch, ...this.queue].slice(-this.maxQueue);
  }

  private problem(message: string): void {
    const at = this.now();
    if (at - this.lastProblemAt < 60_000) return;
    this.lastProblemAt = at;
    this.options.onProblem?.(message);
  }
}
