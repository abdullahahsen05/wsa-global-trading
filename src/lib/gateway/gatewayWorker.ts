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
 *  - an order that waited past its expiry is NOT sent (the person was already told);
 *  - an order is never run twice: a RUNNING command whose worker died becomes FAILED
 *                (WORKER_LOST) in the sweep, it is never started again;
 *  - the answer of a command that already ran is stored with retries - the order exists;
 *  - without migration 060 the loop sleeps and asks again after a minute.
 *
 * No Next / React imports: runs inside the AWS worker.
 */

import type { BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import { KeyedChains } from "@/lib/copy/keyedChains";
import { GatewayNotInstalledError } from "./gatewayDb";
import type { ClaimedCommand, GatewayStore, WatchedAccount } from "./gatewayStore";
import {
  ORDER_COMMAND_KINDS,
  parseTradeCommand,
  TradeCommandError,
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
  /** how often the picture of a watched account is renewed */
  stateRefreshMs?: number;
  /** how often the list of watched accounts is read (a small indexed table - twice a second is cheap) */
  watchListMs?: number;
  heartbeatMs?: number;
  sweepMs?: number;
  /** commands running at the same time (different accounts) */
  commandConcurrency?: number;
  /** watched accounts being refreshed at the same time */
  stateConcurrency?: number;
  claimBatch?: number;
}

const NOT_INSTALLED_RECHECK_MS = 60_000;
const ACTIVE_WINDOW_MS = 60_000;
const OWNER_CACHE_MS = 10 * 60_000;
const OWNER_CACHE_MAX = 2000;
const STATE_FAILURE_PAUSE_MS = 3_000;
const WATCH_TICK_MS = 250;
const STORE_RETRY_PAUSES_MS = [150, 400];
const NOT_SENT_MESSAGE = "The command waited too long, so it was NOT sent to the broker.";

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
  private readonly stateRefreshMs: number;
  private readonly watchListMs: number;
  private readonly heartbeatMs: number;
  private readonly sweepMs: number;
  private readonly claimBatch: number;

  private readonly commandChains: KeyedChains;
  private readonly stateChains: KeyedChains;
  private readonly owners = new Map<string, { userId: string; at: number }>();
  private readonly stateBusy = new Set<string>();
  private readonly nextStateAt = new Map<string, number>();
  private readonly stateFailureLoggedAt = new Map<string, number>();

  private running = false;
  private startedAt = new Date(0);
  private notInstalledUntil = 0;
  private notInstalledLogged = false;
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
    this.idlePollMs = Math.max(this.pollMs, options.idlePollMs ?? 750);
    this.stateRefreshMs = Math.max(250, options.stateRefreshMs ?? 1_000);
    this.watchListMs = Math.max(250, options.watchListMs ?? 500);
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 5_000);
    this.sweepMs = Math.max(5_000, options.sweepMs ?? 60_000);
    this.claimBatch = Math.max(1, Math.min(50, options.claimBatch ?? 10));
    this.commandChains = new KeyedChains(Math.max(1, options.commandConcurrency ?? 8));
    this.stateChains = new KeyedChains(Math.max(1, options.stateConcurrency ?? 6));
  }

  // ── life cycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date(this.now());
    this.loops = [this.commandLoop(), this.watchLoop(), this.housekeepingLoop()];
  }

  /** Stops the loops, lets running commands finish (up to ten seconds) and takes the worker off the heartbeat. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const wakeUp of [...this.sleepers]) wakeUp();
    await waitAtMost(Promise.allSettled(this.loops), 2_000);
    await waitAtMost(this.commandChains.idle(), 10_000);
    await this.store.retire(this.workerId).catch(() => undefined);
  }

  /** Resolves when no command is running or queued (tests, shutdown). */
  async idle(): Promise<void> {
    await this.commandChains.idle();
    await this.stateChains.idle();
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

  private async commandLoop(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.pollCommandsOnce();
      } catch (error) {
        this.warn(`[trade-gateway] polling for commands failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      if (!this.running) break;
      const busy = claimed > 0 || this.watchedList.length > 0 || this.now() - this.lastActivityAt < ACTIVE_WINDOW_MS;
      await this.sleep(claimed >= this.claimBatch ? 0 : busy ? this.pollMs : this.idlePollMs);
    }
  }

  /** One claim round. Returns how many commands were taken. */
  async pollCommandsOnce(): Promise<number> {
    if (this.now() < this.notInstalledUntil) return 0;
    let claimed: ClaimedCommand[];
    try {
      claimed = await this.store.claim(this.workerId, this.claimBatch);
    } catch (error) {
      if (this.noteNotInstalled(error)) return 0;
      throw error;
    }
    for (const command of claimed) {
      this.lastActivityAt = this.now();
      void this.commandChains.run(
        command.accountId,
        () => this.process(command),
        (error) => this.warn(`[trade-gateway] command ${shortId(command.id)} crashed: ${error instanceof Error ? error.message : "unknown error"}`),
      );
    }
    return claimed.length;
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
    if (this.owners.size >= OWNER_CACHE_MAX) this.owners.clear();
    this.owners.set(command.accountId, { userId: owner.userId, at: now });
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

    let parsed: ParsedTradeCommand;
    let outcome: TradeCommandOutcome;
    try {
      parsed = parseTradeCommand(command.kind, command.payload);
      // An order that waited past its expiry is not sent: the person was already told it did not go through.
      if (ORDER_COMMAND_KINDS.has(parsed.kind) && startedAt > Date.parse(command.expiresAt)) {
        throw new TradeCommandError("NOT_SENT", NOT_SENT_MESSAGE, 504);
      }
      await this.assertOwner(command);
      outcome = await executeTradeCommand(this.adapter, command.accountId, parsed);
    } catch (error) {
      const failure = describeCommandError(error);
      this.commandsFailed += 1;
      this.log(`[trade-gateway] ${label} failed in ${this.now() - startedAt}ms (queue ${queueMs}ms): ${failure.code} - ${failure.message}`);
      await this.withRetries(() => this.store.fail(command.id, failure)).catch((storeError) => {
        this.warn(`[trade-gateway] could not store the failure of ${shortId(command.id)}: ${storeError instanceof Error ? storeError.message : "unknown error"}`);
      });
      return;
    }

    // The command has run: from here on only the answer must be stored - it is never run again.
    const runMs = this.now() - startedAt;
    this.commandsRun += 1;
    if (parsed.kind === "SYMBOLS" && outcome.symbols) {
      await this.store.saveSymbols(command.accountId, outcome.symbols, new Date(this.now())).catch((storeError) => {
        if (!this.noteNotInstalled(storeError)) {
          this.warn(`[trade-gateway] could not store the symbols: ${storeError instanceof Error ? storeError.message : "unknown error"}`);
        }
      });
    }
    if (ORDER_COMMAND_KINDS.has(parsed.kind)) this.nextStateAt.delete(command.accountId);
    await this.withRetries(() => this.store.complete(command.id, { ...outcome, timing: { queueMs, runMs } })).catch((storeError) => {
      this.warn(`[trade-gateway] ${label} ran but its answer could not be stored: ${storeError instanceof Error ? storeError.message : "unknown error"}`);
    });
    if (parsed.kind !== "STATE") this.log(`[trade-gateway] ${label} done in ${runMs}ms (queue ${queueMs}ms)`);
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
      if (this.stateBusy.has(entry.accountId)) continue;
      if ((this.nextStateAt.get(entry.accountId) ?? 0) > now) continue;
      this.stateBusy.add(entry.accountId);
      started += 1;
      void this.stateChains.run(
        entry.accountId,
        () => this.refreshOne(entry),
        (error) => this.warn(`[trade-gateway] refresh of ${shortId(entry.accountId)} crashed: ${error instanceof Error ? error.message : "unknown error"}`),
      );
    }
    if (this.nextStateAt.size > 1000) {
      const live = new Set(this.watchedList.map((entry) => entry.accountId));
      for (const key of this.nextStateAt.keys()) if (!live.has(key)) this.nextStateAt.delete(key);
    }
    return started;
  }

  private async refreshOne(entry: WatchedAccount): Promise<void> {
    try {
      const state = await readGatewayState(this.adapter, entry.accountId, entry.symbols);
      await this.store.saveState(entry.accountId, state, null, new Date(this.now()));
      this.nextStateAt.set(entry.accountId, this.now() + this.stateRefreshMs);
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
    await this.store.heartbeat(
      this.workerId,
      this.startedAt,
      {
        executionAvailable: this.adapter.executionAvailable(),
        pollMs: this.pollMs,
        watching: this.watchedList.length,
        commandsRun: this.commandsRun,
        commandsFailed: this.commandsFailed,
      },
      new Date(this.now()),
    );
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
