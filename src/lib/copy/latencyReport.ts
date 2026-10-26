/** Read-only correlation of broker-synced master and follower trade timestamps. */
export interface MasterTradeStamp {
  id: string;
  master_account_id: string;
  master_trade_id: string;
  created_at: string;
}

export interface CopyLinkStamp {
  source_event_id: string;
  follower_account_id: string;
  follower_position_id: string | null;
}

export interface BrokerTradeStamp {
  trading_account_id: string;
  external_trade_id: string | null;
  opened_at: string;
}

export interface LatencyDistribution {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  worstMs: number | null;
}

export interface FollowerLatencyReport {
  followerAccountId: string;
  links: number;
  matchedBrokerTrades: number;
  missingMasterEvent: number;
  missingMasterTrade: number;
  missingFollowerTrade: number;
  invalidOrSkewedTimestamps: number;
  sourceToFollower: LatencyDistribution;
}

function asEpoch(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.UTC(2000, 0, 1) ? parsed : null;
}

export function latencyDistribution(samples: readonly number[]): LatencyDistribution {
  const sorted = samples.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return {
    count: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    worstMs: sorted.at(-1) ?? null,
  };
}

/** Missing/clock-skewed matches reduce coverage; they never become zero-latency samples. */
export function summarizeBrokerTradeLatency(
  events: readonly MasterTradeStamp[],
  links: readonly CopyLinkStamp[],
  trades: readonly BrokerTradeStamp[],
): FollowerLatencyReport[] {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const tradeByAccountAndTicket = new Map(
    trades.filter((trade) => trade.external_trade_id).map((trade) => [
      `${trade.trading_account_id}:${trade.external_trade_id}`,
      trade,
    ]),
  );
  const byFollower = new Map<string, { report: FollowerLatencyReport; samples: number[] }>();
  for (const link of links) {
    let entry = byFollower.get(link.follower_account_id);
    if (!entry) {
      entry = {
        report: {
          followerAccountId: link.follower_account_id,
          links: 0,
          matchedBrokerTrades: 0,
          missingMasterEvent: 0,
          missingMasterTrade: 0,
          missingFollowerTrade: 0,
          invalidOrSkewedTimestamps: 0,
          sourceToFollower: latencyDistribution([]),
        },
        samples: [],
      };
      byFollower.set(link.follower_account_id, entry);
    }
    const { report, samples } = entry;
    report.links += 1;
    const event = eventById.get(link.source_event_id);
    if (!event) { report.missingMasterEvent += 1; continue; }
    const masterTrade = tradeByAccountAndTicket.get(`${event.master_account_id}:${event.master_trade_id}`);
    if (!masterTrade) { report.missingMasterTrade += 1; continue; }
    const followerTrade = link.follower_position_id
      ? tradeByAccountAndTicket.get(`${link.follower_account_id}:${link.follower_position_id}`)
      : null;
    if (!followerTrade) { report.missingFollowerTrade += 1; continue; }
    const masterAt = asEpoch(masterTrade.opened_at);
    const followerAt = asEpoch(followerTrade.opened_at);
    // These are independent broker clocks. An impossible order is flagged, not rounded to zero.
    const delta = masterAt !== null && followerAt !== null ? followerAt - masterAt : NaN;
    if (!Number.isFinite(delta) || delta < 0 || delta > 600_000) {
      report.invalidOrSkewedTimestamps += 1;
      continue;
    }
    samples.push(delta);
    report.matchedBrokerTrades += 1;
  }
  for (const entry of byFollower.values()) entry.report.sourceToFollower = latencyDistribution(entry.samples);
  return [...byFollower.values()].map(({ report }) => report).sort((a, b) => a.followerAccountId.localeCompare(b.followerAccountId));
}
