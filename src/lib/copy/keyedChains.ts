/**
 * Work that must happen in order for one key, but in parallel across keys.
 *
 * The copy worker uses one key per master position: OPEN, MODIFY and CLOSE of the same
 * ticket run one after the other (a CLOSE must never overtake the OPEN it belongs to),
 * while two different tickets - and different strategies - never wait for each other.
 * Before this, the single loop of the worker awaited every copy execution, so one slow
 * broker call delayed the next trade of EVERY strategy.
 *
 *  - `run()` never rejects: an error goes to `onError` (or is dropped), so a queued
 *    task can never leave an unhandled rejection or break the chain behind it;
 *  - `maxConcurrent` caps how many tasks run at once across all keys (FIFO);
 *  - finished keys are forgotten, so the map does not grow.
 *
 * Pure: no Node APIs. Shared with the AWS workers.
 */
export class KeyedChains {
  private readonly tails = new Map<string, Promise<void>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = Number.POSITIVE_INFINITY) {
    this.maxConcurrent = Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : Number.POSITIVE_INFINITY;
  }

  /** Number of keys that have queued or running work. */
  get size(): number {
    return this.tails.size;
  }

  /** Number of tasks running right now. */
  get running(): number {
    return this.active;
  }

  /** Tasks waiting for a slot across all keys (not just the first task of each key). */
  get queuedForSlot(): number {
    return this.waiting.length;
  }

  get capacity(): number {
    return this.maxConcurrent;
  }

  /**
   * Queues `task` behind everything queued earlier under `key`. The returned promise
   * resolves when this task has finished (successfully or not) and never rejects.
   */
  run(key: string, task: () => Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current: Promise<void> = previous.then(async () => {
      await this.acquire();
      try {
        await task();
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          // an error handler must not break the chain either
        }
      } finally {
        this.release();
      }
    });
    this.tails.set(key, current);
    void current.then(() => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    });
    return current;
  }

  /** Resolves when everything queued so far (and whatever that queues in turn) has finished. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }
}
