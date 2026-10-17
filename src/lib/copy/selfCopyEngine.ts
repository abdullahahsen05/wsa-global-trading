/**
 * The self-copy engine: one position event of a source account (OPEN, MODIFY, CLOSE) is copied
 * to the follower accounts of the person's routes.
 *
 * Everything the engine needs from the outside comes through `SelfCopyStore` (database) and the
 * broker adapter, so the whole flow is covered by unit tests with in-memory fakes. Shared with the
 * AWS workers: no Next, React or `server-only` imports.
 *
 * What it guarantees:
 *  - every position on every route ends in an activity row - copied, skipped (with the reason) or
 *    failed - so "it does nothing" can always be explained;
 *  - one order per (route, source position): the copy link is reserved BEFORE the order is sent and
 *    a timed-out order is never sent again by itself;
 *  - the routes of one event run in parallel; the order of OPEN -> MODIFY -> CLOSE of one ticket is
 *    the caller's job (the worker chains events per ticket);
 *  - nothing here waits for a convenience (the follower's symbol list gets a few hundred
 *    milliseconds, then the order goes out with the names it already knows).
 */

import {
  BROKER_EXEC_ERROR,
  BrokerExecutionError,
  type BrokerAdapter,
  type BrokerExecutionResult,
} from "@/lib/broker/BrokerAdapter";
import {
  effectiveSlippage,
  pointFromDigits,
  protectiveLevels,
  resolveFollowerSymbols,
  type FollowerSymbolResolution,
  type ProtectiveLevels,
} from "@/lib/copy/calibration";
import { SYMBOL_LIST_BUDGET_MS, symbolsWithin } from "@/lib/copy/followerSymbols";
import { calculateFollowerLot, roundToStep, type LotResult } from "@/lib/copy/lotScaling";
import { runPool } from "@/lib/copy/pool";
import { copyModeToScalingMode, reverseFollowerSide } from "@/lib/copy/settings";
import {
  evaluateSelfCopyGates,
  isExistingForRoute,
  readSelfCopySettings,
  type SelfCopyGateInput,
  type SelfCopyGateResult,
  type SelfCopyPlatformFacts,
  type SelfCopySettings,
} from "@/lib/copy/selfCopyDecision";

// ── types ────────────────────────────────────────────────────────────────────

export interface SelfCopyPositionEvent {
  sourceAccountId: string;
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  sourcePositionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  previousVolume?: number | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** MODIFY: the levels before the change, when known (an unchanged level is not sent again) */
  previousStopLoss?: number | null;
  previousTakeProfit?: number | null;
  /** OPEN: the position was already open when the stream started */
  existing?: boolean;
  /** when the change reached this process (epoch ms) */
  detectedAt?: number | null;
  /** when the trade opened at the source's broker (epoch ms) */
  openedAt?: number | null;
}

export type SelfCopyRouteStatus = "LIVE" | "PAUSED" | "ARCHIVED";

export interface SelfCopyRoute {
  id: string;
  traderId: string;
  sourceAccountId: string;
  followerAccountId: string;
  status: SelfCopyRouteStatus;
  settings: SelfCopySettings;
  createdAt: string;
}

export type SelfCopyLinkStatus = "PENDING" | "OPEN" | "CLOSING" | "CLOSED" | "FAILED";

export interface SelfCopyLink {
  id: string;
  routeId: string;
  traderId: string;
  sourceAccountId: string;
  followerAccountId: string;
  sourcePositionId: string;
  followerPositionId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  copiedVolume: number;
  status: SelfCopyLinkStatus;
  errorCode: string | null;
}

export interface SelfCopyLinkPatch {
  status?: SelfCopyLinkStatus;
  symbol?: string;
  side?: "BUY" | "SELL";
  followerPositionId?: string | null;
  followerOrderId?: string | null;
  copiedVolume?: number;
  openedAt?: string;
  closedAt?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface SelfCopyFollowerFacts {
  sourceStatus: string | null;
  followerStatus: string | null;
  riskBlocked: boolean;
  riskMessage: string | null;
  openCopies: number;
  sourceBalance: number | null;
  sourceEquity: number | null;
  followerBalance: number | null;
  followerEquity: number | null;
  dailyLossPercent: number | null;
  drawdownPercent: number | null;
}

export type SelfCopyActivityOutcome = "COPIED" | "SKIPPED" | "FAILED";

export interface SelfCopyActivity {
  routeId: string;
  traderId: string;
  sourceAccountId: string;
  followerAccountId: string;
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  sourcePositionId: string;
  outcome: SelfCopyActivityOutcome;
  /** a gate code (`SelfCopyCode`), `OPENED` / `MODIFIED` / `PARTIAL_CLOSED` / `CLOSED`, or the broker's error code */
  code: string;
  /** one sentence a person can read */
  message: string;
  symbol: string;
  followerSymbol: string | null;
  side: "BUY" | "SELL" | null;
  sourceVolume: number | null;
  copiedVolume: number | null;
  /** from the moment the change was noticed to the broker's answer (copies) or the decision (skips) */
  latencyMs: number | null;
  timings: Record<string, number> | null;
}

export type SelfCopyPlatform = Omit<SelfCopyPlatformFacts, "executionAvailable"> & { maxSlippagePoints: number | null };

/** What the engine needs from the database. */
export interface SelfCopyStore {
  platform(): Promise<SelfCopyPlatform>;
  /** the routes of the source that are live or paused (never archived) */
  routesForSource(sourceAccountId: string): Promise<SelfCopyRoute[]>;
  followerFacts(route: SelfCopyRoute): Promise<SelfCopyFollowerFacts>;
  findLink(routeId: string, sourcePositionId: string): Promise<SelfCopyLink | null>;
  /** Reserves the link of a new copy. `duplicate` = somebody else reserved it first. */
  reserveLink(input: {
    routeId: string;
    traderId: string;
    sourceAccountId: string;
    followerAccountId: string;
    sourcePositionId: string;
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
  }): Promise<{ link: SelfCopyLink } | { duplicate: true }>;
  /** Writes a change to a link; tries again by itself and throws when it cannot be saved. */
  updateLink(id: string, patch: SelfCopyLinkPatch): Promise<void>;
  /** The open copies of one source position that have a follower ticket. */
  openLinks(sourceAccountId: string, sourcePositionId: string): Promise<SelfCopyLink[]>;
  /** Marks the open copies of one source position as being closed and returns them (one atomic statement). */
  claimClose(
    sourceAccountId: string,
    sourcePositionId: string,
  ): Promise<{ claimed: SelfCopyLink[]; withoutTicket: SelfCopyLink[] }>;
  /** Every source position that still has an open copy. */
  openSourcePositionIds(sourceAccountId: string): Promise<string[]>;
  /** Stores one line of activity. Must not block or throw. */
  record(activity: SelfCopyActivity): void;
}

export interface SelfCopyDeps {
  adapter: BrokerAdapter;
  store: SelfCopyStore;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface SelfCopySummary {
  attempted: number;
  success: number;
  failed: number;
  skipped: number;
}

// ── small helpers ────────────────────────────────────────────────────────────

/** Most routes handled at the same time for one event. */
const ROUTE_CONCURRENCY = 16;
const CLOSE_RETRY_DELAYS_MS: readonly number[] = [150, 450];
/** Never try more spellings of one symbol than this. */
const MAX_SYMBOL_ATTEMPTS = 4;

const UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  BROKER_EXEC_ERROR.PROVIDER_TIMEOUT,
  "ORDER_UNCERTAIN",
  "WORKER_LOST",
  "LINK_NOT_RECORDED",
]);

export function isUncertainFailure(code: string | null | undefined): boolean {
  return typeof code === "string" && UNCERTAIN_CODES.has(code);
}

export class LinkWriteError extends Error {
  constructor(
    readonly ticket: string | null,
    cause: string,
  ) {
    super(`The order was placed (broker position ${ticket ?? "unknown"}) but could not be recorded: ${cause}`);
    this.name = "LinkWriteError";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return (error instanceof Error && error.message ? error.message : fallback).slice(0, 400);
}

function errorCode(error: unknown): string {
  if (error instanceof BrokerExecutionError) return error.code;
  if (error instanceof LinkWriteError) return "LINK_NOT_RECORDED";
  return "COPY_ENGINE_ERROR";
}

/** The reasons a broker gives when it does not like the SYMBOL are worth another spelling; these are not. */
const NOT_ABOUT_THE_SYMBOL =
  /margin|money|funds|balance|market (is )?closed|session|trade (is )?disabled|trading (is )?disabled|volume|lot size|stops?|expiration|too many|requote|price changed|off quotes|read.?only|investor/i;

export function symbolMayBeWrong(error: unknown): boolean {
  if (!(error instanceof BrokerExecutionError)) return false;
  if (error.code !== BROKER_EXEC_ERROR.PROVIDER_ERROR) return false;
  return !NOT_ABOUT_THE_SYMBOL.test(error.message);
}

const ALREADY_CLOSED =
  /(position|order|ticket|trade)[^.]{0,40}(not found|does not exist|doesn'?t exist|not exist|no longer|invalid ticket)|already (been )?closed|no such (position|order|ticket)|invalid[ _]ticket/i;
const UNCHANGED = /no changes?|not changed|nothing to (change|modify)|unchanged|same (values|levels|stops)/i;

export function looksAlreadyClosed(error: unknown): boolean {
  return error instanceof Error && ALREADY_CLOSED.test(error.message);
}

export function looksUnchanged(error: unknown): boolean {
  return error instanceof Error && UNCHANGED.test(error.message);
}

/** Worth sending a close again: the bridge or the network hiccuped; a refused request is final. */
function closeWorthRetrying(error: unknown): boolean {
  if (!(error instanceof BrokerExecutionError)) return true;
  return (
    error.code === BROKER_EXEC_ERROR.PROVIDER_ERROR ||
    error.code === BROKER_EXEC_ERROR.PROVIDER_TIMEOUT ||
    error.code === BROKER_EXEC_ERROR.ACCOUNT_NOT_CONNECTED
  );
}

const NEUTRAL_FOLLOWER: SelfCopyGateInput["follower"] = {
  riskBlocked: false,
  riskMessage: null,
  openCopies: 0,
  dailyLossPercent: null,
  drawdownPercent: null,
};

function sideAfter(side: "BUY" | "SELL", reverse: boolean): "BUY" | "SELL" {
  return reverseFollowerSide(side, reverse) === "SELL" ? "SELL" : "BUY";
}

function emptySummary(): SelfCopySummary {
  return { attempted: 0, success: 0, failed: 0, skipped: 0 };
}

function count(summary: SelfCopySummary, outcome: SelfCopyActivityOutcome): void {
  if (outcome === "COPIED") {
    summary.attempted += 1;
    summary.success += 1;
  } else if (outcome === "FAILED") {
    summary.attempted += 1;
    summary.failed += 1;
  } else {
    summary.skipped += 1;
  }
}

function describeLot(lot: number): string {
  return `${Math.round(lot * 1000) / 1000}`;
}

// ── OPEN ─────────────────────────────────────────────────────────────────────

/** What the platform allows right now, as the open gates need it. */
export interface SelfCopyOpenContext {
  platform: SelfCopyPlatform;
  /** the process that would send the order may place broker orders */
  executionAvailable: boolean;
}

function platformFacts(context: SelfCopyOpenContext): SelfCopyPlatformFacts {
  const { platform } = context;
  return {
    copyEnabled: platform.copyEnabled,
    liveCopyEnabled: platform.liveCopyEnabled,
    emergencyStop: platform.emergencyStop,
    executionAvailable: context.executionAvailable,
    maxLotSize: platform.maxLotSize,
    maxCopiedOpenPositions: platform.maxCopiedOpenPositions,
    maxDailyLossPercent: platform.maxDailyLossPercent,
    maxDrawdownPercent: platform.maxDrawdownPercent,
  };
}

/** The cheap gates stopped the plan before anything was looked up. */
export interface SelfCopyPlanStopped {
  complete: false;
  verdict: SelfCopyGateResult;
}

/** Everything the engine works out for one position on one route before it reserves or sends anything. */
export interface SelfCopyPlanReady {
  complete: true;
  /** all gates; `allowed` says whether the order may go out */
  verdict: SelfCopyGateResult;
  followerSymbol: string;
  followerSide: "BUY" | "SELL";
  resolution: FollowerSymbolResolution;
  levels: ProtectiveLevels;
  lot: LotResult;
  /** the link of an earlier attempt for the same position, if there is one */
  link: SelfCopyLink | null;
  facts: SelfCopyFollowerFacts;
}

export type SelfCopyPlan = SelfCopyPlanStopped | SelfCopyPlanReady;

/**
 * Decides what would happen to one open position on one route - which symbol, which side, how
 * many lots, which stop loss and take profit, and whether any gate says no - WITHOUT reserving a
 * link or sending anything. The live copy and the "check this route" button both run it, so the
 * preview can never promise something the copy does not do.
 */
export async function planSelfCopyOpen(
  deps: SelfCopyDeps,
  context: SelfCopyOpenContext,
  route: SelfCopyRoute,
  event: SelfCopyPositionEvent,
  timings: Record<string, number> = {},
): Promise<SelfCopyPlan> {
  const { adapter, store } = deps;
  const now = deps.now ?? Date.now;
  const settings = route.settings;
  const calibration = settings.calibration;
  if (event.detectedAt) timings.queueMs = Math.max(0, now() - event.detectedAt);
  const ageMs = event.detectedAt && event.openedAt ? Math.max(0, event.detectedAt - event.openedAt) : null;
  if (ageMs !== null) timings.sourceDelayMs = ageMs;
  // a trade found in the stream's first look is old - unless it opened after this route went live
  const existing = isExistingForRoute({ existing: event.existing === true, openedAt: event.openedAt ?? null, ageMs }, settings);

  // 1. the gates that need no lookups at all
  const cheap = evaluateSelfCopyGates({
    platform: platformFacts(context),
    route: { status: route.status },
    // the symbol lists are judged once the follower's symbol is known
    settings: { ...settings, allowedSymbols: null, blockedSymbols: null },
    sourceStatus: null,
    followerStatus: null,
    follower: NEUTRAL_FOLLOWER,
    event: { symbol: event.symbol, followerSymbol: event.symbol, existing, ageMs },
    alreadyCopied: null,
    lot: null,
    levelsUnavailable: null,
  });
  if (!cheap.allowed) return { complete: false, verdict: cheap };

  // 2. what the decision needs, in one parallel round
  const factsStart = now();
  const [facts, link, symbols] = await Promise.all([
    store.followerFacts(route),
    store.findLink(route.id, event.sourcePositionId),
    calibration.autoSymbolMatch || Object.keys(settings.symbolMapping).length > 0
      ? symbolsWithin(adapter, route.followerAccountId, SYMBOL_LIST_BUDGET_MS)
      : Promise.resolve(null),
  ]);
  timings.factsMs = now() - factsStart;

  const resolution = resolveFollowerSymbols({
    sourceSymbol: event.symbol,
    mapping: settings.symbolMapping,
    followerSymbols: symbols ? symbols.map((entry) => entry.name) : null,
    autoMatch: calibration.autoSymbolMatch,
  });
  const followerSymbol = resolution.candidates[0] ?? event.symbol;
  const followerSide = sideAfter(event.side, settings.reverseCopy);

  let point = pointFromDigits(symbols?.find((entry) => entry.name === followerSymbol)?.digits ?? null);
  const scalingMode = copyModeToScalingMode(settings.copyMode);
  const needsSpecs =
    scalingMode === "RISK_PERCENT" ||
    (point === null && (calibration.stopLossPoints !== null || calibration.takeProfitPoints !== null));
  const specs =
    needsSpecs && adapter.fetchSymbolSpecifications
      ? await adapter.fetchSymbolSpecifications(route.followerAccountId, followerSymbol).catch(() => null)
      : null;
  if (point === null && specs && typeof specs.tickSize === "number" && specs.tickSize > 0) point = specs.tickSize;

  const levels = protectiveLevels({
    followerSide,
    reversed: settings.reverseCopy,
    entryPrice: event.entryPrice,
    stopLoss: event.stopLoss,
    takeProfit: event.takeProfit,
    calibration,
    point,
    // a trade that was already open may have a stop that trailed past its entry; the broker judges it
    checkSides: !existing,
  });

  const lot: LotResult = scalingMode
    ? calculateFollowerLot({
        masterLot: event.volume,
        entryPrice: event.entryPrice ?? null,
        stopLoss: levels.stopLoss,
        masterBalance: facts.sourceBalance,
        masterEquity: facts.sourceEquity,
        followerBalance: facts.followerBalance,
        followerEquity: facts.followerEquity,
        scalingMode,
        fixedLot: settings.fixedLot,
        lotMultiplier: settings.copyMode === "LOT_MULTIPLIER" ? settings.lotMultiplier : null,
        riskMultiplier: null,
        riskPercent: settings.copyMode === "RISK_PERCENT" ? settings.riskPercent : null,
        minLot: settings.minLot,
        maxLot: settings.maxLot,
        symbolSpecifications: specs
          ? {
              tickSize: specs.tickSize,
              tickValue: specs.tickValue,
              contractSize: specs.contractSize,
              volumeStep: specs.volumeStep,
              minVolume: specs.minVolume,
              maxVolume: specs.maxVolume,
              accountCurrency: specs.accountCurrency,
              profitCurrency: specs.profitCurrency,
              accountCurrencyConversionRate: specs.accountCurrencyConversionRate,
            }
          : null,
      })
    : { lot: 0, rawLot: null, normalizedLot: null, riskAmount: null, reason: "The copy mode is not supported" };

  // a failed attempt that certainly sent nothing may be tried again; one that may have reached the broker may not
  let alreadyCopied: string | null = null;
  if (link) {
    if (link.status !== "FAILED") alreadyCopied = "This position was copied already.";
    else if (isUncertainFailure(link.errorCode)) {
      alreadyCopied =
        "An earlier attempt for this trade did not get a clear answer, so it may exist at the broker. Check the follower account before copying it again.";
    }
  }

  const verdict = evaluateSelfCopyGates({
    platform: platformFacts(context),
    route: { status: route.status },
    settings,
    sourceStatus: facts.sourceStatus,
    followerStatus: facts.followerStatus,
    follower: {
      riskBlocked: facts.riskBlocked,
      riskMessage: facts.riskMessage,
      openCopies: facts.openCopies,
      dailyLossPercent: facts.dailyLossPercent,
      drawdownPercent: facts.drawdownPercent,
    },
    event: {
      symbol: event.symbol,
      followerSymbol,
      existing,
      ageMs,
    },
    alreadyCopied,
    lot: { lot: lot.lot, reason: lot.reason },
    levelsUnavailable: levels.unavailable,
  });
  return { complete: true, verdict, followerSymbol, followerSide, resolution, levels, lot, link, facts };
}

async function copyOpenOnRoute(
  deps: SelfCopyDeps,
  context: SelfCopyOpenContext,
  route: SelfCopyRoute,
  event: SelfCopyPositionEvent,
): Promise<SelfCopyActivityOutcome> {
  const { adapter, store } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const settings = route.settings;
  const calibration = settings.calibration;
  const timings: Record<string, number> = {};

  const base = {
    routeId: route.id,
    traderId: route.traderId,
    sourceAccountId: route.sourceAccountId,
    followerAccountId: route.followerAccountId,
    eventType: "OPEN" as const,
    sourcePositionId: event.sourcePositionId,
    symbol: event.symbol,
    sourceVolume: event.volume,
  };
  const skip = (
    code: string,
    message: string,
    extra: Partial<Pick<SelfCopyActivity, "followerSymbol" | "side" | "copiedVolume">> = {},
  ): SelfCopyActivityOutcome => {
    store.record({
      ...base,
      outcome: "SKIPPED",
      code,
      message,
      followerSymbol: extra.followerSymbol ?? null,
      side: extra.side ?? null,
      copiedVolume: extra.copiedVolume ?? null,
      latencyMs: null,
      timings,
    });
    deps.log?.(`[self-copy] ${route.id.slice(0, 8)} OPEN ${event.symbol} ${event.sourcePositionId}: skipped (${code}) ${message}`);
    return "SKIPPED";
  };

  let linkId: string | null = null;
  let followerSymbol: string | null = null;
  let followerSide: "BUY" | "SELL" | null = null;
  let lotValue: number | null = null;
  try {
    if (event.existing === true) {
      // Found in the stream's first look (the worker started): a trade that has been dealt with on this route
      // already is not news, and saying "already open before copying started" about a trade that WAS copied
      // would only confuse. Nothing to look up in a hurry here, so this one extra read costs nothing.
      const handled = await store.findLink(route.id, event.sourcePositionId).catch(() => null);
      if (handled) return "SKIPPED";
    }
    const plan = await planSelfCopyOpen(deps, context, route, event, timings);
    if (!plan.complete) return skip(plan.verdict.code, plan.verdict.message);
    const { resolution, levels, lot, link } = plan;
    followerSymbol = plan.followerSymbol;
    followerSide = plan.followerSide;
    lotValue = lot.lot > 0 ? lot.lot : null;
    if (!plan.verdict.allowed) {
      return skip(plan.verdict.code, plan.verdict.message, { followerSymbol, side: followerSide, copiedVolume: lotValue });
    }

    // 3. reserve the link BEFORE the order: it is what keeps one trade from being copied twice
    const reserveStart = now();
    if (link) {
      await store.updateLink(link.id, {
        status: "PENDING",
        errorCode: null,
        errorMessage: null,
        symbol: followerSymbol,
        side: followerSide,
        copiedVolume: lot.lot,
      });
      linkId = link.id;
    } else {
      const reserved = await store.reserveLink({
        routeId: route.id,
        traderId: route.traderId,
        sourceAccountId: route.sourceAccountId,
        followerAccountId: route.followerAccountId,
        sourcePositionId: event.sourcePositionId,
        symbol: followerSymbol,
        side: followerSide,
        volume: lot.lot,
      });
      if ("duplicate" in reserved) {
        return skip("ALREADY_COPIED", "This position was copied already.", { followerSymbol, side: followerSide });
      }
      linkId = reserved.link.id;
    }
    timings.reserveMs = now() - reserveStart;

    // 4. the order
    const brokerStart = now();
    const slippage = effectiveSlippage(context.platform.maxSlippagePoints, calibration.maxSlippagePoints);
    let placed: BrokerExecutionResult | null = null;
    let usedSymbol = followerSymbol;
    let lastError: unknown = null;
    for (const candidate of resolution.candidates.slice(0, MAX_SYMBOL_ATTEMPTS)) {
      try {
        placed = await adapter.openTrade({
          accountId: route.followerAccountId,
          symbol: candidate,
          side: followerSide,
          volume: lot.lot,
          stopLoss: levels.stopLoss,
          takeProfit: levels.takeProfit,
          slippage,
          comment: `wsa:self:${route.id.slice(0, 8)}`,
        });
        usedSymbol = candidate;
        break;
      } catch (error) {
        lastError = error;
        if (!symbolMayBeWrong(error)) break;
      }
    }
    timings.brokerMs = now() - brokerStart;
    if (!placed) throw lastError ?? new Error("The broker did not accept the order.");

    // 5. the ticket is what lets the close find this trade later
    const ticket = placed.brokerPositionId ?? placed.brokerOrderId ?? null;
    const linkStart = now();
    try {
      await store.updateLink(linkId, {
        status: "OPEN",
        symbol: usedSymbol,
        followerPositionId: ticket,
        followerOrderId: placed.brokerOrderId ?? null,
        copiedVolume: placed.executedVolume ?? lot.lot,
        openedAt: new Date(now()).toISOString(),
        errorCode: null,
        errorMessage: null,
      });
    } catch (error) {
      throw new LinkWriteError(ticket, errorMessage(error, "the database did not answer"));
    }
    timings.linkMs = now() - linkStart;

    const finishedAt = now();
    const latencyMs = Math.max(0, finishedAt - (event.detectedAt ?? startedAt));
    timings.totalMs = finishedAt - startedAt;
    const executed = placed.executedVolume ?? lot.lot;
    const symbolText = usedSymbol.toLowerCase() === event.symbol.toLowerCase() ? usedSymbol : `${event.symbol} as ${usedSymbol}`;
    store.record({
      ...base,
      outcome: "COPIED",
      code: "OPENED",
      message: `${followerSide} ${describeLot(executed)} lot ${symbolText} opened on the follower in ${latencyMs} ms.`,
      followerSymbol: usedSymbol,
      side: followerSide,
      copiedVolume: executed,
      latencyMs,
      timings,
    });
    deps.log?.(
      `[self-copy] ${route.id.slice(0, 8)} OPEN ${event.symbol} -> ${usedSymbol} ${followerSide} ${describeLot(executed)} lot: copied in ${latencyMs}ms ` +
        `(facts ${timings.factsMs ?? 0}ms, reserve ${timings.reserveMs ?? 0}ms, broker ${timings.brokerMs ?? 0}ms, link ${timings.linkMs ?? 0}ms)`,
    );
    return "COPIED";
  } catch (error) {
    const code = errorCode(error);
    const message = errorMessage(error, "The copy could not be placed.");
    if (linkId && !(error instanceof LinkWriteError)) {
      await store
        .updateLink(linkId, { status: "FAILED", errorCode: code, errorMessage: message })
        .catch(() => undefined);
    }
    timings.totalMs = now() - startedAt;
    store.record({
      ...base,
      outcome: "FAILED",
      code,
      message: isUncertainFailure(code) && !(error instanceof LinkWriteError)
        ? `${message} The order may still exist at the broker - check the follower account.`
        : message,
      followerSymbol,
      side: followerSide,
      copiedVolume: lotValue,
      latencyMs: Math.max(0, now() - (event.detectedAt ?? startedAt)),
      timings,
    });
    deps.log?.(`[self-copy] ${route.id.slice(0, 8)} OPEN ${event.symbol} ${event.sourcePositionId}: FAILED (${code}) ${message}`);
    return "FAILED";
  }
}

// ── MODIFY ───────────────────────────────────────────────────────────────────

const MIN_PARTIAL_LOT = 0.01;

async function modifyOnLink(
  deps: SelfCopyDeps,
  route: SelfCopyRoute | undefined,
  link: SelfCopyLink,
  event: SelfCopyPositionEvent,
): Promise<SelfCopyActivityOutcome | null> {
  const { adapter, store } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const settings = route?.settings ?? readSelfCopySettings(null);
  const calibration = settings.calibration;
  const timings: Record<string, number> = {};
  if (event.detectedAt) timings.queueMs = Math.max(0, startedAt - event.detectedAt);
  const base = {
    routeId: link.routeId,
    traderId: link.traderId,
    sourceAccountId: link.sourceAccountId,
    followerAccountId: link.followerAccountId,
    eventType: "MODIFY" as const,
    sourcePositionId: event.sourcePositionId,
    symbol: event.symbol,
    followerSymbol: link.symbol,
    side: link.side,
    sourceVolume: event.volume,
  };
  const ticket = link.followerPositionId;
  if (!ticket) return null;

  let outcome: SelfCopyActivityOutcome | null = null;
  const notes: string[] = [];
  try {
    // 1. the source closed a part of its position: the follower closes the same share
    const previousVolume = Number(event.previousVolume ?? event.volume);
    if (previousVolume > 0 && previousVolume > event.volume) {
      const share = (previousVolume - event.volume) / previousVolume;
      const amount = roundToStep(link.copiedVolume * share, MIN_PARTIAL_LOT);
      if (amount >= MIN_PARTIAL_LOT && amount < link.copiedVolume) {
        const brokerStart = now();
        await adapter.closeTrade({
          accountId: link.followerAccountId,
          brokerPositionId: ticket,
          volume: amount,
          comment: "wsa:self-copy:partial",
        });
        timings.partialMs = now() - brokerStart;
        const remaining = Math.max(0, roundToStep(link.copiedVolume - amount, MIN_PARTIAL_LOT));
        await store.updateLink(link.id, { copiedVolume: remaining });
        link = { ...link, copiedVolume: remaining };
        notes.push(`closed ${describeLot(amount)} lot of the follower's position`);
        outcome = "COPIED";
      } else {
        notes.push("the part the source closed is smaller than the smallest lot, so the follower's position was left as it is");
        outcome ??= "SKIPPED";
      }
    } else if (event.volume > previousVolume && previousVolume > 0) {
      notes.push("the source added volume to the position; the follower is not scaled in");
      outcome ??= "SKIPPED";
    }

    // 2. stop loss and take profit
    const followsStopLoss = calibration.copyStopLoss && calibration.stopLossPoints === null;
    const followsTakeProfit = calibration.copyTakeProfit && calibration.takeProfitPoints === null;
    const levelsChanged =
      event.previousStopLoss === undefined && event.previousTakeProfit === undefined
        ? previousVolume === event.volume
        : Number(event.previousStopLoss ?? 0) !== Number(event.stopLoss ?? 0) ||
          Number(event.previousTakeProfit ?? 0) !== Number(event.takeProfit ?? 0);
    if (levelsChanged && (followsStopLoss || followsTakeProfit)) {
      const wanted = protectiveLevels({
        followerSide: link.side,
        reversed: settings.reverseCopy,
        // no entry here: a stop that has moved past the entry (break-even, trailing stop) is valid on an
        // open position - the "wrong side of the entry" check is for a new order only
        entryPrice: null,
        stopLoss: event.stopLoss,
        takeProfit: event.takeProfit,
        calibration: { ...calibration, stopLossPoints: null, takeProfitPoints: null },
        point: null,
      });
      let stopLoss = wanted.stopLoss ?? 0;
      let takeProfit = wanted.takeProfit ?? 0;
      let skipLevels = false;
      if (!followsStopLoss || !followsTakeProfit) {
        // a level this route does not follow stays as the follower has it: read it first
        const state = adapter.fetchTradingState ? await adapter.fetchTradingState(link.followerAccountId).catch(() => null) : null;
        const current = state?.positions.find((position) => position.ticket === ticket) ?? null;
        if (!current) {
          skipLevels = true;
          notes.push("the follower's own stop loss / take profit could not be read, so nothing was changed");
          outcome ??= "SKIPPED";
        } else {
          if (!followsStopLoss) stopLoss = current.stopLoss ?? 0;
          if (!followsTakeProfit) takeProfit = current.takeProfit ?? 0;
          if (stopLoss === (current.stopLoss ?? 0) && takeProfit === (current.takeProfit ?? 0)) skipLevels = true;
        }
      }
      if (!skipLevels) {
        const brokerStart = now();
        try {
          await adapter.modifyTrade({
            accountId: link.followerAccountId,
            brokerPositionId: ticket,
            stopLoss,
            takeProfit,
          });
          notes.push(
            `stop loss ${stopLoss > 0 ? stopLoss : "none"}, take profit ${takeProfit > 0 ? takeProfit : "none"}`,
          );
          outcome = "COPIED";
        } catch (error) {
          if (!looksUnchanged(error)) throw error;
          notes.push("the follower already had these levels");
          outcome ??= "SKIPPED";
        }
        timings.modifyMs = now() - brokerStart;
      }
    }

    if (outcome === null) return null;
    timings.totalMs = now() - startedAt;
    const latencyMs = Math.max(0, now() - (event.detectedAt ?? startedAt));
    const code = outcome === "SKIPPED" ? "MODIFY_NOT_APPLIED" : notes.some((note) => note.startsWith("closed")) ? "PARTIAL_CLOSED" : "MODIFIED";
    deps.store.record({
      ...base,
      outcome,
      code,
      message: `${notes.join("; ")}.`.replace(/^./, (letter) => letter.toUpperCase()),
      copiedVolume: link.copiedVolume,
      latencyMs: outcome === "COPIED" ? latencyMs : null,
      timings,
    });
    deps.log?.(`[self-copy] ${link.routeId.slice(0, 8)} MODIFY ${event.symbol} ${event.sourcePositionId}: ${outcome} (${notes.join("; ")}) in ${latencyMs}ms`);
    return outcome;
  } catch (error) {
    const message = errorMessage(error, "The follower's position could not be changed.");
    await store
      .updateLink(link.id, { errorCode: errorCode(error), errorMessage: message })
      .catch(() => undefined);
    store.record({
      ...base,
      outcome: "FAILED",
      code: errorCode(error),
      message,
      copiedVolume: link.copiedVolume,
      latencyMs: Math.max(0, now() - (event.detectedAt ?? startedAt)),
      timings,
    });
    deps.log?.(`[self-copy] ${link.routeId.slice(0, 8)} MODIFY ${event.symbol} ${event.sourcePositionId}: FAILED ${message}`);
    return "FAILED";
  }
}

// ── CLOSE ────────────────────────────────────────────────────────────────────

async function closeFollower(
  deps: SelfCopyDeps,
  link: SelfCopyLink,
  ticket: string,
): Promise<{ alreadyClosed: boolean; attempts: number }> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= CLOSE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await wait(CLOSE_RETRY_DELAYS_MS[attempt - 1]);
    try {
      await deps.adapter.closeTrade({
        accountId: link.followerAccountId,
        brokerPositionId: ticket,
        comment: "wsa:self-copy:close",
      });
      return { alreadyClosed: false, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      // closing a position that is gone is what we wanted
      if (looksAlreadyClosed(error)) return { alreadyClosed: true, attempts: attempt + 1 };
      if (!closeWorthRetrying(error)) break;
    }
  }
  throw lastError ?? new Error("The position could not be closed.");
}

async function closeOnLink(
  deps: SelfCopyDeps,
  link: SelfCopyLink,
  event: SelfCopyPositionEvent,
  reason: string,
): Promise<SelfCopyActivityOutcome> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timings: Record<string, number> = {};
  if (event.detectedAt) timings.queueMs = Math.max(0, startedAt - event.detectedAt);
  const base = {
    routeId: link.routeId,
    traderId: link.traderId,
    sourceAccountId: link.sourceAccountId,
    followerAccountId: link.followerAccountId,
    eventType: "CLOSE" as const,
    sourcePositionId: event.sourcePositionId,
    symbol: event.symbol,
    followerSymbol: link.symbol,
    side: link.side,
    sourceVolume: event.volume,
  };
  const ticket = link.followerPositionId as string;
  try {
    const brokerStart = now();
    const closed = await closeFollower(deps, link, ticket);
    timings.brokerMs = now() - brokerStart;
    await store.updateLink(link.id, {
      status: "CLOSED",
      closedAt: new Date(now()).toISOString(),
      errorCode: null,
      errorMessage: null,
    });
    const finishedAt = now();
    timings.totalMs = finishedAt - startedAt;
    const latencyMs = Math.max(0, finishedAt - (event.detectedAt ?? startedAt));
    store.record({
      ...base,
      outcome: "COPIED",
      code: "CLOSED",
      message: closed.alreadyClosed
        ? `${reason} The follower's position was already closed.`
        : `${reason} The follower's ${describeLot(link.copiedVolume)} lot position was closed in ${latencyMs} ms.`,
      copiedVolume: link.copiedVolume,
      latencyMs,
      timings,
    });
    deps.log?.(`[self-copy] ${link.routeId.slice(0, 8)} CLOSE ${event.symbol} ${event.sourcePositionId}: closed in ${latencyMs}ms${closed.attempts > 1 ? ` (attempt ${closed.attempts})` : ""}`);
    return "COPIED";
  } catch (error) {
    const message = errorMessage(error, "The follower's position could not be closed.");
    // the copy is still open: put it back so the next close (or the person) can find it
    await store
      .updateLink(link.id, { status: "OPEN", errorCode: errorCode(error), errorMessage: message })
      .catch(() => undefined);
    timings.totalMs = now() - startedAt;
    store.record({
      ...base,
      outcome: "FAILED",
      code: errorCode(error),
      message: `${message} The follower's position is still open - close it by hand.`,
      copiedVolume: link.copiedVolume,
      latencyMs: Math.max(0, now() - (event.detectedAt ?? startedAt)),
      timings,
    });
    deps.log?.(`[self-copy] ${link.routeId.slice(0, 8)} CLOSE ${event.symbol} ${event.sourcePositionId}: FAILED ${message}`);
    return "FAILED";
  }
}

// ── entry points ─────────────────────────────────────────────────────────────

/**
 * Copies one position event of a source account. `routes` are the live and paused routes of
 * that source when the caller already has them (the worker keeps them current); otherwise they
 * are read.
 */
export async function runSelfCopyEvent(
  deps: SelfCopyDeps,
  event: SelfCopyPositionEvent,
  options: { routes?: SelfCopyRoute[] } = {},
): Promise<SelfCopySummary> {
  const summary = emptySummary();
  const { store, adapter } = deps;

  if (event.eventType === "OPEN") {
    const routes = (options.routes ?? (await store.routesForSource(event.sourceAccountId))).filter(
      (route) => route.status === "LIVE",
    );
    if (routes.length === 0) return summary;
    const platform = await store.platform();
    const context: SelfCopyOpenContext = { platform, executionAvailable: adapter.executionAvailable() };
    await runPool(routes, ROUTE_CONCURRENCY, async (route) => {
      count(summary, await copyOpenOnRoute(deps, context, route, event));
    });
    return summary;
  }

  if (event.eventType === "MODIFY") {
    const links = await store.openLinks(event.sourceAccountId, event.sourcePositionId);
    if (links.length === 0) return summary;
    const routes = options.routes ?? (await store.routesForSource(event.sourceAccountId));
    const byId = new Map(routes.map((route) => [route.id, route]));
    await runPool(links, ROUTE_CONCURRENCY, async (link) => {
      const outcome = await modifyOnLink(deps, byId.get(link.routeId), link, event);
      if (outcome) count(summary, outcome);
    });
    return summary;
  }

  const { claimed, withoutTicket } = await store.claimClose(event.sourceAccountId, event.sourcePositionId);
  for (const link of withoutTicket) {
    store.record({
      routeId: link.routeId,
      traderId: link.traderId,
      sourceAccountId: link.sourceAccountId,
      followerAccountId: link.followerAccountId,
      eventType: "CLOSE",
      sourcePositionId: event.sourcePositionId,
      outcome: "SKIPPED",
      code: "NO_FOLLOWER_TICKET",
      message: "The copy has no broker ticket, so there is nothing to close.",
      symbol: event.symbol,
      followerSymbol: link.symbol,
      side: link.side,
      sourceVolume: event.volume,
      copiedVolume: link.copiedVolume,
      latencyMs: null,
      timings: null,
    });
    summary.skipped += 1;
  }
  await runPool(claimed, ROUTE_CONCURRENCY, async (link) => {
    count(summary, await closeOnLink(deps, link, event, "The source closed this trade."));
  });
  return summary;
}

/**
 * After the worker was away: copies whose source position is gone are closed. The live positions
 * must come from a list that was confirmed (the caller reads it twice); an empty list closes
 * everything that is open, so the caller must be sure about it.
 *
 * Pass a function to have the list read AFTER the copies were looked up: a copy made while the
 * list is being read is then not in the copies that are checked, so it can never be taken for
 * "the source closed it". With nothing to check, the list is not read at all.
 */
export async function closeVanishedPositions(
  deps: SelfCopyDeps,
  sourceAccountId: string,
  live: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
): Promise<SelfCopySummary> {
  const summary = emptySummary();
  const open = await deps.store.openSourcePositionIds(sourceAccountId);
  if (open.length === 0) return summary;
  const livePositionIds = typeof live === "function" ? await live() : live;
  for (const positionId of open) {
    if (livePositionIds.has(positionId)) continue;
    const links = await deps.store.claimClose(sourceAccountId, positionId);
    await runPool(links.claimed, ROUTE_CONCURRENCY, async (link) => {
      const outcome = await closeOnLink(
        deps,
        link,
        {
          sourceAccountId,
          eventType: "CLOSE",
          sourcePositionId: positionId,
          symbol: link.symbol,
          side: link.side,
          volume: link.copiedVolume,
        },
        "The source closed this trade while copying was not running.",
      );
      count(summary, outcome);
    });
  }
  return summary;
}
