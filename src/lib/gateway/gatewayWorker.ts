if (typeof window !== "undefined") {
  throw new Error("[wsa] gatewayWorker is server-only.");
}

/**
 * Trade gateway - the loop that runs on the AWS side.
 *
 * The web app (Vercel) never talks to the MetaTrader bridge for a person's WSA Trade
 * panel. It writes a COMMAND row (open / close / modify / cancel / close all / read)
 * and this loop - inside the copy worker, which already holds the warm broker sessions
 * and the keep-alive connections - picks it up, runs it through the shared executor and
 * writes the answer back. It also keeps the live picture (figures, positions, pending
 * orders, prices) of every account somebody is looking at fresh, about once a second.
 *
 *  - commands:   claimed in batches (FOR UPDATE SKIP LOCKED), one chain per account so a
 *                modify never overtakes the open it belongs to, accounts in parallel;
 *  - reads (STATE / SYMBOLS) run on a chain of their own: a slow symbol list of an account
 *                never holds up an order on it, and never takes the slot of one;
 *  - an order that waited past its expiry is NOT sent (the person was already told);
 *  - an order is never run twice: a RUNNING command whose worker died becomes FAILED
 *                (WORKER_LOST) in the sweep, it is never started again;
 *  - the answer of a command that already ran is stored with retries - the order exists -
 *                and outside the account's chain, so the next order does not wait for it;
 *  - right after an order the picture of the account is read again (and kept fresh at a
 *                faster pace for a few seconds), so the panel shows the result at once;
 *  - without migration 060 the loop sleeps and asks again after a minute;
 *  - with migration 062 (and `longPollMs` > 0) a command is not WAITED FOR by asking again and again: the
 *                claim waits inside the database and returns the moment a command is written. Two such
 *                calls run half a window apart so there is no gap between one call and the next. Without
 *                062 (or when the database refuses the long call) it polls exactly as before;
 *  - the heartbeat carries what the worker knows about itself - the round trip to the database, how late its
 *                event loop runs, whether it waits inside the database - so the web panel can say where a
 *                delay comes from.
 *
 * No Next / React imports: runs inside the AWS worker.
 */

import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import { KeyedChains } from "@/lib/copy/keyedChains";
import { GatewayNotInstalledError, LONG_POLL_TROUBLE_PAUSE_MS, LongPollUnavailableError } from "./gatewayDb";
import type { ClaimedCommand, GatewayStore, WatchedAccount } from "./gatewayStore";
import {
  ORDER_COMMAND_KINDS,
  parseTradeCommand,
  TradeCommandError,
  type CommandTiming,
  type GatewayTradingState,
  type ParsedTradeCommand,
  type TradeCommandOutcome,
} from "./tradeCommands";
import { describeCommandError, executeTradeCommand, readGatewayState } from "./tradeExecutor";

export interface GatewayWorkerOptions {
  store: GatewayStore;
  adapter: BrokerAdapter;
  workerId: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  /** command poll while somebody is looking / when nothing has happened for a minute */
  pollMs?: number;
  idlePollMs?: number;
  /**
   * How long one claim may WAIT inside the database for a command to arrive (migration 062). 0 = poll as
   * before. The store must offer `claimWait`; if the database has no such function the worker polls.
   */
  longPollMs?: number;
  /** how often the picture of a watched account is renewed */
  stateRefreshMs?: number;
  /** how often it is renewed in the few seconds after an order on that account */
  hotRefreshMs?: number;
  /** how often the list of watched accounts is read (a small indexed table - twice a second is cheap) */
  watchListMs?: number;
  heartbeatMs?: number;
  sweepMs?: number;
  /** commands running at the same time (different accounts) */
  commandConcurrency?: number;
  /** reads (STATE / SYMBOLS commands) running at the same time; they never use the slots of the orders */
  readConcurrency?: number;
  /** watched accounts being refreshed at the same time */
  stateConcurrency?: number;
  claimBatch?: number;
}

const NOT_INSTALLED_RECHECK_MS = 60_000;
const ACTIVE_WINDOW_MS = 60_000;
const OWNER_CACHE_MS = 10 * 60_000;
const OWNER_CACHE_MAX = 2000;
/** An owner this old is looked up again in the background while somebody watches the account. */
const OWNER_PREFETCH_AFTER_MS = OWNER_CACHE_MS / 2;
const STATE_FAILURE_PAUSE_MS = 3_000;
const WATCH_TICK_MS = 250;
/** After an order the picture of its account is renewed faster for this long. */
const HOT_WINDOW_MS = 4_000;
/** A picture this young (and taken after the last order on the account) is good enough to read levels from. */
const RECENT_PICTURE_MAX_AGE_MS = 1_500;
const STORE_RETRY_PAUSES_MS = [150, 400];
const NOT_SENT_MESSAGE = "The command waited too long, so it was NOT sent to the broker.";
/** The longest wait inside the database one claim may ask for. */
const LONG_POLL_MAX_MS = 3_000;
/** A database without the wait function is asked again after this long (the migration may have been applied meanwhile). */
const LONG_POLL_MISSING_RECHECK_MS = 5 * 60_000;
/** This many failed waits in a row, and the worker polls for a while. */
const LONG_POLL_MAX_FAILURES = 3;
/** The sampling rate of the event-loop monitor; what it reports is this plus the lateness. */
const LAG_RESOLUTION_MS = 10;
/** How many database round trips are remembered for the median. */
const DB_SAMPLES = 7;

/** What one round of claiming brought. */
interface ClaimRound {
  claimed: number;
  /** the call waited inside the database (long poll) */
  waited: boolean;
  tookMs: number;
}
/** Commands that only read: they must never wait behind (or in front of) an order. */
const READ_KINDS: ReadonlySet<string> = new Set(["STATE", "SYMBOLS"]);

/** ", read 80ms, session 0ms, send 312ms, 2 attempts" for the log line of a command. */
function timingSuffix(timing: Partial<CommandTiming>): string {
  const parts: string[] = [];
  if (timing.readMs !== undefined) parts.push(`read ${timing.readMs}ms`);
  if (timing.sessionMs !== undefined) parts.push(`session ${timing.sessionMs}ms`);
  if (timing.sendMs !== undefined) parts.push(`send ${timing.sendMs}ms`);
  if (timing.attempts !== undefined && timing.attempts > 1) parts.push(`${timing.attempts} attempts`);
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for `task`, but never longer than `ms`; the timer is cleared so it cannot keep a process alive. */
async function waitAtMost(task: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export class GatewayWorker {
  private readonly store: GatewayStore;
  private readonly adapter: BrokerAdapter;
  private readonly workerId: string;
  private readonly log: (message: string) => void;
  private readonly warn: (message: string) => void;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly idlePollMs: number;
  private readonly longPollMs: number;
  private readonly stateRefreshMs: number;
  private readonly hotRefreshMs: number;
  private readonly watchListMs: number;
  private readonly heartbeatMs: number;
  private readonly sweepMs: number;
  private readonly claimBatch: number;

  private readonly commandChains: KeyedChains;
  private readonly readChains: KeyedChains;
  private readonly stateChains: KeyedChains;
  private readonly owners = new Map<string, { userId: string; at: number }>();
  private readonly ownerLookupAt = new Map<string, number>();
  private readonly stateBusy = new Set<string>();
  private readonly nextStateAt = new Map<string, number>();
  private readonly stateFailureLoggedAt = new Map<string, number>();
  /** the last picture read of each watched account, and when that read began / ended */
  private readonly pictures = new Map<string, { state: GatewayTradingState; startedAt: number; finishedAt: number }>();
  /** when the last order on an account finished */
  private readonly orderDoneAt = new Map<string, number>();
  /** accounts whose picture is renewed faster until the time given */
  private readonly hotUntil = new Map<string, number>();
  /** accounts that had a read in flight when an order finished: they are read once more as soon as it ends */
  private readonly refreshAgain = new Set<string>();
  /** answers being stored (they are written outside the chain of the account) */
  private readonly answers = new Set<Promise<void>>();

  private running = false;
  private startedAt = new Date(0);
  private notInstalledUntil = 0;
  private notInstalledLogged = false;
  /** the wait inside the database is not used before this time (migration 062 missing, or the database refused it) */
  private longPollOffUntil = 0;
  private longPollFailures = 0;
  private longPollLogged = false;
  /** the last few round trips to the database (the heartbeat's write), in milliseconds */
  private readonly dbSamples: number[] = [];
  private lagMonitor: IntervalHistogram | null = null;
  private lastActivityAt = 0;
  private watchedList: WatchedAccount[] = [];
  private nextWatchListAt = 0;
  private nextSweepAt = 0;
  private readonly sleepers = new Set<() => void>();
  private loops: Array<Promise<void>> = [];
  private commandsRun = 0;
  private commandsFailed = 0;

  constructor(options: GatewayWorkerOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.workerId = options.workerId;
    this.log = options.log ?? ((message) => console.log(message));
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.now = options.now ?? Date.now;
    this.pollMs = Math.max(50, options.pollMs ?? 150);
    this.idlePollMs = Math.max(this.pollMs, options.idlePollMs ?? 400);
    this.longPollMs = Math.max(0, Math.min(LONG_POLL_MAX_MS, Math.round(options.longPollMs ?? 0)));
    this.stateRefreshMs = Math.max(250, options.stateRefreshMs ?? 1_000);
    this.hotRefreshMs = Math.max(150, options.hotRefreshMs ?? 350);
    this.watchListMs = Math.max(250, options.watchListMs ?? 500);
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 5_000);
    this.sweepMs = Math.max(5_000, options.sweepMs ?? 60_000);
    this.claimBatch = Math.max(1, Math.min(50, options.claimBatch ?? 10));
    this.commandChains = new KeyedChains(Math.max(1, options.commandConcurrency ?? 8));
    this.readChains = new KeyedChains(Math.max(1, options.readConcurrency ?? 6));
    this.stateChains = new KeyedChains(Math.max(1, options.stateConcurrency ?? 6));
  }

  // ── life cycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date(this.now());
    this.startLagMonitor();
    this.loops = [this.commandLoop(0), this.watchLoop(), this.housekeepingLoop()];
    // Two waiting calls, half a window apart: while one is on its way back to the worker and the next one is on its
    // way to the database the other is still waiting, so a command written in that gap is not left for the next call.
    if (this.longPollMs > 0 && typeof this.store.claimWait === "function") {
      this.loops.push(this.commandLoop(Math.round(this.longPollMs / 2)));
    }
  }

  /** Stops the loops, lets running commands finish (up to ten seconds) and takes the worker off the heartbeat. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const wakeUp of [...this.sleepers]) wakeUp();
    await waitAtMost(Promise.allSettled(this.loops), 2_000);
    await waitAtMost(this.settled(), 10_000);
    this.lagMonitor?.disable();
    this.lagMonitor = null;
    await this.store.retire(this.workerId).catch(() => undefined);
  }

  // ── what the worker knows about itself (reported in the heartbeat) ──────────

  private startLagMonitor(): void {
    try {
      this.lagMonitor = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
      this.lagMonitor.enable();
    } catch {
      this.lagMonitor = null; // a runtime without the monitor simply reports nothing
    }
  }

  /** How late the event loop has been running since the last look (99th percentile, ms), then starts afresh. */
  private takeLagMs(): number | undefined {
    const monitor = this.lagMonitor;
    if (!monitor) return undefined;
    const p99Ms = monitor.count > 0 ? monitor.percentile(99) / 1e6 : 0;
    monitor.reset();
    return Math.max(0, Math.round(p99Ms - LAG_RESOLUTION_MS));
  }

  private noteDbSample(ms: number): void {
    this.dbSamples.push(Math.max(0, Math.round(ms)));
    if (this.dbSamples.length > DB_SAMPLES) this.dbSamples.shift();
  }

  /** The middle of the recent round trips to the database (undefined until there is one). */
  private medianDbMs(): number | undefined {
    if (this.dbSamples.length === 0) return undefined;
    const sorted = [...this.dbSamples].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** Resolves when no command is running or queued and every answer has been stored (tests, shutdown). */
  async idle(): Promise<void> {
    do {
      await this.settled();
      await this.stateChains.idle();
    } while (
      this.commandChains.size > 0 ||
      this.readChains.size > 0 ||
      this.stateChains.size > 0 ||
      this.answers.size > 0
    );
  }

  /** The commands (orders and reads) and the stored answers, not the refreshes of the pictures. */
  private async settled(): Promise<void> {
    await Promise.all([this.commandChains.idle(), this.readChains.idle()]);
    await Promise.allSettled([...this.answers]);
  }

  /** A pause that `stop()` can cut short. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  // ── commands ───────────────────────────────────────────────────────────────

  private async commandLoop(initialDelayMs: number): Promise<void> {
    if (initialDelayMs > 0) await this.sleep(initialDelayMs);
    while (this.running) {
      let round: ClaimRound = { claimed: 0, waited: false, tookMs: 0 };
      try {
        round = await this.claimRound();
      } catch (error) {
        this.warn(`[trade-gateway] polling for commands failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      if (!this.running) break;
      if (round.claimed >= this.claimBatch) {
        await this.sleep(0);
      } else if (round.waited) {
        // The call itself waited for work, so the next one is made at once. One that came back empty far too soon
        // did not wait (it should have): it is not repeated in a tight loop.
        await this.sleep(round.claimed > 0 || round.tookMs >= this.longPollMs / 2 ? 0 : this.idlePollMs);
      } else {
        const busy = round.claimed > 0 || this.watchedList.length > 0 || this.now() - this.lastActivityAt < ACTIVE_WINDOW_MS;
        await this.sleep(busy ? this.pollMs : this.idlePollMs);
      }
    }
  }

  /** One claim round. Returns how many commands were taken. */
  async pollCommandsOnce(): Promise<number> {
    return (await this.claimRound()).claimed;
  }

  /** Is the wait inside the database in use right now? (Needs migration 062; falls back to polling when it fails.) */
  private longPollActive(): boolean {
    return this.longPollMs > 0 && typeof this.store.claimWait === "function" && this.now() >= this.longPollOffUntil;
  }

  /** The wait failed: remember it, and poll the plain way for a while. */
  private noteLongPollTrouble(error: unknown): void {
    if (error instanceof LongPollUnavailableError) {
      this.longPollOffUntil = this.now() + LONG_POLL_MISSING_RECHECK_MS;
      if (!this.longPollLogged) {
        this.longPollLogged = true;
        this.log("[trade-gateway] migration 062 is not applied - commands are picked up by polling (slower). Apply 062 to wake up at once.");
      }
      return;
    }
    this.longPollFailures += 1;
    if (this.longPollFailures >= LONG_POLL_MAX_FAILURES) {
      this.longPollFailures = 0;
      this.longPollOffUntil = this.now() + LONG_POLL_TROUBLE_PAUSE_MS;
      this.warn(`[trade-gateway] the wait inside the database failed ${LONG_POLL_MAX_FAILURES} times in a row (${error instanceof Error ? error.message : "unknown error"}) - polling for a while.`);
    }
  }

  private async claimRound(): Promise<ClaimRound> {
    if (this.now() < this.notInstalledUntil) return { claimed: 0, waited: false, tookMs: 0 };
    const startedAt = this.now();
    let claimed: ClaimedCommand[];
    let waited = false;
    try {
      if (this.longPollActive()) {
        try {
          claimed = await (this.store.claimWait as NonNullable<GatewayStore["claimWait"]>)(this.workerId, this.claimBatch, this.longPollMs);
          waited = true;
          this.longPollFailures = 0;
        } catch (error) {
          if (error instanceof GatewayNotInstalledError) throw error;
          this.noteLongPollTrouble(error);
          // this round still takes whatever is waiting, the plain way
          claimed = await this.store.claim(this.workerId, this.claimBatch);
        }
      } else {
        claimed = await this.store.claim(this.workerId, this.claimBatch);
      }
    } catch (error) {
      if (this.noteNotInstalled(error)) return { claimed: 0, waited: false, tookMs: 0 };
      throw error;
    }
    for (const command of claimed) {
      this.lastActivityAt = this.now();
      // A read (the symbol list can take seconds) has its own chain: it neither waits for an order nor makes one wait.
      const chains = READ_KINDS.has(command.kind) ? this.readChains : this.commandChains;
      void chains.run(
        command.accountId,
        () => this.process(command),
        (error) => this.warn(`[trade-gateway] command ${shortId(command.id)} crashed: ${error instanceof Error ? error.message : "unknown error"}`),
      );
    }
    return { claimed: claimed.length, waited, tookMs: this.now() - startedAt };
  }

  private noteNotInstalled(error: unknown): boolean {
    if (!(error instanceof GatewayNotInstalledError)) return false;
    this.notInstalledUntil = this.now() + NOT_INSTALLED_RECHECK_MS;
    if (!this.notInstalledLogged) {
      this.notInstalledLogged = true;
      this.log("[trade-gateway] migration 060 is not applied on this database - the gateway sleeps and checks again every minute.");
    }
    return true;
  }

  private async assertOwner(command: ClaimedCommand): Promise<void> {
    const now = this.now();
    const cached = this.owners.get(command.accountId);
    if (cached && cached.userId === command.userId && now - cached.at < OWNER_CACHE_MS) return;
    const owner = await this.store.owner(command.accountId);
    if (!owner || owner.userId !== command.userId) {
      throw new TradeCommandError("ACCOUNT_NOT_FOUND", "Trading account not found.", 404);
    }
    if (!owner.providerAccountId) {
      throw new TradeCommandError(
        "ACCOUNT_NOT_CONNECTED",
        "This account is not connected to the broker service. Reconnect it under Trading Accounts first.",
        409,
      );
    }
    this.rememberOwner(command.accountId, owner.userId, now);
  }

  private rememberOwner(accountId: string, userId: string, at: number): void {
    if (this.owners.size >= OWNER_CACHE_MAX) this.owners.clear();
    this.owners.set(accountId, { userId, at });
  }

  /**
   * Looks the owner of a watched account up in the background, so the first click on it does not
   * pay for a database read. What is stored is the real owner from the accounts table (never the
   * user the watch row names), and `assertOwner` still compares it with the user of every command.
   */
  private prefetchOwner(entry: WatchedAccount): void {
    const now = this.now();
    const cached = this.owners.get(entry.accountId);
    if (cached && now - cached.at < OWNER_PREFETCH_AFTER_MS) return;
    if (now - (this.ownerLookupAt.get(entry.accountId) ?? Number.NEGATIVE_INFINITY) < 30_000) return;
    if (this.ownerLookupAt.size >= OWNER_CACHE_MAX) this.ownerLookupAt.clear();
    this.ownerLookupAt.set(entry.accountId, now);
    void this.store
      .owner(entry.accountId)
      .then((owner) => {
        if (owner?.providerAccountId) this.rememberOwner(entry.accountId, owner.userId, this.now());
      })
      .catch(() => undefined);
  }

  private async withRetries<T>(task: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        if (attempt >= STORE_RETRY_PAUSES_MS.length) throw error;
        await pause(STORE_RETRY_PAUSES_MS[attempt]);
      }
    }
  }

  private async process(command: ClaimedCommand): Promise<void> {
    const startedAt = this.now();
    const queueMs = Math.max(0, startedAt - Date.parse(command.createdAt));
    const label = `${command.kind} ${shortId(command.accountId)}`;
    // filled in by the executor while it works: where the time of this command goes
    const timing: Partial<CommandTiming> = {};

    let parsed: ParsedTradeCommand;
    let outcome: TradeCommandOutcome;
    let touchesBroker = false;
    try {
      parsed = parseTradeCommand(command.kind, command.payload);
      // An order that waited past its expiry is not sent: the person was already told it did not go through.
      if (ORDER_COMMAND_KINDS.has(parsed.kind) && startedAt > Date.parse(command.expiresAt)) {
        throw new TradeCommandError("NOT_SENT", NOT_SENT_MESSAGE, 504);
      }
      await this.assertOwner(command);
      touchesBroker = ORDER_COMMAND_KINDS.has(parsed.kind);
      outcome = await executeTradeCommand(this.adapter, command.accountId, parsed, {
        // a modify reads the levels from the picture taken a moment ago when that picture is certain to be current
        recentState: parsed.kind === "MODIFY" ? this.recentPicture(command.accountId) : null,
        timing,
      });
    } catch (error) {
      // a refused or failed order may still have changed something: the picture is read again
      if (touchesBroker) this.orderFinished(command.accountId);
      const failure = describeCommandError(error);
      this.commandsFailed += 1;
      this.log(
        `[trade-gateway] ${label} failed in ${this.now() - startedAt}ms (queue ${queueMs}ms${timingSuffix(timing)}): ${failure.code} - ${failure.message}`,
      );
      await this.withRetries(() => this.store.fail(command.id, failure)).catch((storeError) => {
        this.warn(`[trade-gateway] could not store the failure of ${shortId(command.id)}: ${storeError instanceof Error ? storeError.message : "unknown error"}`);
      });
      return;
    }

    // The command has run: from here on only the answer must be stored - it is never run again.
    const runMs = this.now() - startedAt;
    this.commandsRun += 1;
    if (touchesBroker) this.orderFinished(command.accountId);
    if (parsed.kind !== "STATE") this.log(`[trade-gateway] ${label} done in ${runMs}ms (queue ${queueMs}ms${timingSuffix(timing)})`);
    if (parsed.kind === "SYMBOLS" && outcome.symbols) {
      await this.store.saveSymbols(command.accountId, outcome.symbols, new Date(this.now())).catch((storeError) => {
        if (!this.noteNotInstalled(storeError)) {
          this.warn(`[trade-gateway] could not store the symbols: ${storeError instanceof Error ? storeError.message : "unknown error"}`);
        }
      });
    }
    // Written outside the chain of the account: the next order on it does not wait for this round trip.
    this.storeAnswer(command, label, { ...outcome, timing: { ...timing, queueMs, runMs } });
  }

  /** Stores the answer of a command that has run - with retries, because the order exists whatever happens now. */
  private storeAnswer(command: ClaimedCommand, label: string, answer: TradeCommandOutcome): void {
    const task: Promise<void> = this.withRetries(() => this.store.complete(command.id, answer))
      .catch((storeError) => {
        this.warn(`[trade-gateway] ${label} ran but its answer could not be stored: ${storeError instanceof Error ? storeError.message : "unknown error"}`);
      })
      .finally(() => {
        this.answers.delete(task);
      });
    this.answers.add(task);
  }

  // ── what the worker knows about an account right after an order ───────────

  /** The picture of an account if it was read after the last order on it finished and is only a moment old. */
  private recentPicture(accountId: string): GatewayTradingState | null {
    const picture = this.pictures.get(accountId);
    if (!picture) return null;
    if (this.now() - picture.finishedAt > RECENT_PICTURE_MAX_AGE_MS) return null;
    // read before the last order on this account ended: it may not show what that order did
    if (picture.startedAt < (this.orderDoneAt.get(accountId) ?? 0)) return null;
    return picture.state;
  }

  /** An order on the account has just finished (or failed in a way that may have changed something). */
  private orderFinished(accountId: string): void {
    const now = this.now();
    if (this.orderDoneAt.size > 500) this.forgetOldAccounts(now);
    this.orderDoneAt.set(accountId, now);
    this.pictures.delete(accountId);
    this.hotUntil.set(accountId, now + HOT_WINDOW_MS);
    this.refreshSoon(accountId);
  }

  private forgetOldAccounts(now: number): void {
    for (const [accountId, at] of this.orderDoneAt) {
      if (now - at > 60_000) this.orderDoneAt.delete(accountId);
    }
    for (const [accountId, until] of this.hotUntil) {
      if (until < now) this.hotUntil.delete(accountId);
    }
    for (const [accountId, picture] of this.pictures) {
      if (now - picture.finishedAt > 60_000) this.pictures.delete(accountId);
    }
  }

  /** Reads the account again now instead of at the next tick - after an order the panel wants to see its result. */
  private refreshSoon(accountId: string): void {
    this.nextStateAt.delete(accountId);
    const entry = this.watchedList.find((candidate) => candidate.accountId === accountId);
    if (!entry) return; // nobody is looking at this account: there is nothing to publish
    if (this.stateBusy.has(accountId)) {
      // that read began before the order ended and may not show it: read once more as soon as it is done
      this.refreshAgain.add(accountId);
      return;
    }
    this.startRefresh(entry);
  }

  // ── live picture of the accounts somebody is looking at ────────────────────

  private async watchLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.refreshStatesOnce();
      } catch (error) {
        this.warn(`[trade-gateway] refreshing watched accounts failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      if (!this.running) break;
      await this.sleep(WATCH_TICK_MS);
    }
  }

  /** Starts a refresh for every watched account that is due. Returns how many were started. */
  async refreshStatesOnce(): Promise<number> {
    const now = this.now();
    if (now < this.notInstalledUntil) return 0;
    if (now >= this.nextWatchListAt) {
      try {
        this.watchedList = await this.store.watched(new Date(now));
      } catch (error) {
        this.watchedList = [];
        if (!this.noteNotInstalled(error)) throw error;
      }
      // read just as often when nobody is watching: the first person to open the panel must not wait for the list
      this.nextWatchListAt = now + this.watchListMs;
    }
    let started = 0;
    for (const entry of this.watchedList) {
      // the owner is looked up before the first click, not during it
      this.prefetchOwner(entry);
      if (this.stateBusy.has(entry.accountId)) continue;
      if ((this.nextStateAt.get(entry.accountId) ?? 0) > now) continue;
      started += 1;
      this.startRefresh(entry);
    }
    if (this.nextStateAt.size > 1000) {
      const live = new Set(this.watchedList.map((entry) => entry.accountId));
      for (const key of this.nextStateAt.keys()) if (!live.has(key)) this.nextStateAt.delete(key);
    }
    return started;
  }

  private startRefresh(entry: WatchedAccount): void {
    this.stateBusy.add(entry.accountId);
    void this.stateChains.run(
      entry.accountId,
      () => this.refreshOne(entry),
      (error) => this.warn(`[trade-gateway] refresh of ${shortId(entry.accountId)} crashed: ${error instanceof Error ? error.message : "unknown error"}`),
    );
  }

  /** The pause before the next read of an account: shorter in the seconds after an order on it. */
  private refreshInterval(accountId: string): number {
    const hotUntil = this.hotUntil.get(accountId);
    if (hotUntil === undefined) return this.stateRefreshMs;
    if (hotUntil <= this.now()) {
      this.hotUntil.delete(accountId);
      return this.stateRefreshMs;
    }
    return Math.min(this.stateRefreshMs, this.hotRefreshMs);
  }

  private async refreshOne(entry: WatchedAccount): Promise<void> {
    const readStartedAt = this.now();
    try {
      const state = await readGatewayState(this.adapter, entry.accountId, entry.symbols);
      // kept for a modify that comes right after: it can read the levels from here instead of asking the broker again
      this.pictures.set(entry.accountId, { state, startedAt: readStartedAt, finishedAt: this.now() });
      await this.store.saveState(entry.accountId, state, null, new Date(this.now()));
      this.nextStateAt.set(entry.accountId, this.now() + this.refreshInterval(entry.accountId));
    } catch (error) {
      const message = describeCommandError(error).message;
      this.nextStateAt.set(entry.accountId, this.now() + STATE_FAILURE_PAUSE_MS);
      const loggedAt = this.stateFailureLoggedAt.get(entry.accountId) ?? 0;
      if (this.now() - loggedAt > 60_000) {
        this.stateFailureLoggedAt.set(entry.accountId, this.now());
        this.log(`[trade-gateway] could not read account ${shortId(entry.accountId)}: ${message}`);
      }
      await this.store.saveState(entry.accountId, null, message, new Date(this.now())).catch(() => undefined);
    } finally {
      this.stateBusy.delete(entry.accountId);
      // an order finished while this read was in flight: the picture just taken may not show it - read again now
      if (this.refreshAgain.delete(entry.accountId)) {
        const current = this.watchedList.find((candidate) => candidate.accountId === entry.accountId);
        if (current) this.startRefresh(current);
      }
    }
  }

  // ── heartbeat and housekeeping ─────────────────────────────────────────────

  private async housekeepingLoop(): Promise<void> {
    while (this.running) {
      try {
        if (this.now() >= this.notInstalledUntil) {
          await this.heartbeatOnce();
          if (this.now() >= this.nextSweepAt) {
            this.nextSweepAt = this.now() + this.sweepMs;
            await this.sweepOnce();
          }
        }
      } catch (error) {
        if (!this.noteNotInstalled(error)) {
          this.warn(`[trade-gateway] housekeeping failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      if (!this.running) break;
      await this.sleep(this.heartbeatMs);
    }
  }

  async heartbeatOnce(): Promise<void> {
    // What the worker knows about itself travels with the heartbeat, so the panel's time report can say whether a
    // delay is the distance to the database (dbRttMs), a busy worker (loopLagMs) or the way commands are picked up
    // (longPoll) - without anyone logging in to the AWS box.
    const info: Record<string, unknown> = {
      executionAvailable: this.adapter.executionAvailable(),
      pollMs: this.pollMs,
      watching: this.watchedList.length,
      commandsRun: this.commandsRun,
      commandsFailed: this.commandsFailed,
      longPoll: this.longPollActive(),
    };
    const dbRttMs = this.medianDbMs();
    if (dbRttMs !== undefined) info.dbRttMs = dbRttMs;
    const loopLagMs = this.takeLagMs();
    if (loopLagMs !== undefined) info.loopLagMs = loopLagMs;

    const writeStartedAt = performance.now();
    await this.store.heartbeat(this.workerId, this.startedAt, info, new Date(this.now()));
    this.noteDbSample(performance.now() - writeStartedAt);
    if (this.notInstalledLogged) {
      this.notInstalledLogged = false;
      this.log("[trade-gateway] migration 060 found - the gateway is running.");
    }
  }

  async sweepOnce(): Promise<void> {
    const result = await this.store.sweep(new Date(this.now()));
    if (result.expired > 0 || result.lost > 0) {
      this.log(`[trade-gateway] housekeeping: ${result.expired} expired, ${result.lost} lost, ${result.purged} old rows removed`);
    }
  }
}

/** Starts a gateway worker. The caller keeps the handle and calls `stop()` on shutdown. */
export function startGatewayWorker(options: GatewayWorkerOptions): GatewayWorker {
  const worker = new GatewayWorker(options);
  worker.start();
  return worker;
}
