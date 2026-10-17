/**
 * The loop of ONE live stream (one master account) in the copy worker.
 *
 * The worker used to have a single loop that visited every stream in turn and awaited
 * each one's copy execution, so a slow follower order of strategy A delayed the
 * detection and the copying of strategy B. Now every stream has its own pump:
 *
 *  - `step()` runs, then the pump rests `intervalMs`, then `step()` runs again;
 *  - `wake()` cuts the rest short (the broker's order stream reported a change, so
 *    there is no reason to wait for the next tick); wakes that arrive while a step is
 *    running are merged into exactly one more step right after it;
 *  - when `step()` throws the pump stops and calls `onFailure` once - the owner closes
 *    the stream and opens it again later (this is the same "close, record, retry"
 *    behaviour as before, just per stream). The handler runs on its own, after the loop
 *    has ended, so it may call `stop()` without waiting for itself;
 *  - `stop()` ends the loop and resolves after the step in flight has finished.
 *
 * Pure: only timers. Shared with the AWS workers.
 */
export interface StreamPumpOptions {
  /** One pass over the stream. Throwing ends the pump. */
  step: () => Promise<void>;
  /** Rest between two passes when nobody wakes the pump (ms). */
  intervalMs: number;
  /** `step` threw. Called at most once; the pump has stopped by then. */
  onFailure: (error: unknown) => void | Promise<void>;
}

export class StreamPump {
  private stopped = false;
  private wakeRequested = false;
  private wakeSleep: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private failureHandling: Promise<void> | null = null;
  private steps = 0;

  constructor(private readonly options: StreamPumpOptions) {}

  /** Number of passes that have run. */
  get stepCount(): number {
    return this.steps;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.run();
  }

  /** Run the next pass now instead of after the rest. */
  wake(): void {
    if (this.stopped) return;
    this.wakeRequested = true;
    this.wakeSleep?.();
  }

  /** Ends the loop; resolves once the pass in flight has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeSleep?.();
    await this.loop;
  }

  /** Resolves when the loop has ended and, after a failure, the failure handler has finished too. */
  async settled(): Promise<void> {
    await this.loop;
    await this.failureHandling;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.wakeRequested = false;
      try {
        await this.options.step();
        this.steps += 1;
      } catch (error) {
        const wasStopped = this.stopped;
        this.stopped = true;
        if (!wasStopped) {
          this.failureHandling = Promise.resolve()
            .then(() => this.options.onFailure(error))
            .then(
              () => undefined,
              () => undefined, // the owner's handler failed; there is nobody left to tell
            );
        }
        return;
      }
      if (this.stopped) return;
      if (this.wakeRequested) continue;
      await this.rest(this.options.intervalMs);
    }
  }

  private rest(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (this.wakeSleep === done) this.wakeSleep = null;
        resolve();
      };
      this.wakeSleep = done;
      timer = setTimeout(done, Math.max(0, ms));
    });
  }
}
