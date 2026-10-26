/**
 * Read-only historical broker-timestamp correlation. Does not connect a broker or place orders.
 * Usage: npx tsx scripts/report-copy-latency.ts --days 7 --limit 500
 * A match requires both trades to have been synced into `trades`; coverage is always shown.
 */
import { loadEnvConfig } from "@next/env";
import {
  summarizeBrokerTradeLatency,
  type BrokerTradeStamp,
  type CopyLinkStamp,
  type MasterTradeStamp,
} from "../src/lib/copy/latencyReport";

loadEnvConfig(process.cwd());

function option(name: string, fallback: number, max: number): number {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const raw = process.argv[at + 1];
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`--${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let at = 0; at < values.length; at += size) result.push(values.slice(at, at + size));
  return result;
}

async function main(): Promise<void> {
  const days = option("days", 7, 30);
  // Supabase's default API row cap is 1,000; reserve one row to detect truncation.
  const limit = option("limit", 500, 999);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const db = createAdminClient();
  const linkResult = await db.from("copy_trade_links")
    .select("source_event_id, follower_account_id, follower_position_id")
    .gte("created_at", since)
    .not("follower_position_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (linkResult.error) throw linkResult.error;
  const truncated = (linkResult.data?.length ?? 0) > limit;
  const links = (linkResult.data ?? []).slice(0, limit) as CopyLinkStamp[];
  const eventIds = [...new Set(links.map((link) => link.source_event_id))];
  const events: MasterTradeStamp[] = [];
  for (const ids of batches(eventIds, 40)) {
    const result = await db.from("copy_master_events")
      .select("id, master_account_id, master_trade_id, created_at")
      .in("id", ids);
    if (result.error) throw result.error;
    events.push(...(result.data ?? []) as MasterTradeStamp[]);
  }
  const eventById = new Map(events.map((event) => [event.id, event]));
  const ticketsByAccount = new Map<string, Set<string>>();
  function addTicket(accountId: string, ticket: string | null | undefined): void {
    if (!ticket) return;
    const tickets = ticketsByAccount.get(accountId) ?? new Set<string>();
    tickets.add(ticket);
    ticketsByAccount.set(accountId, tickets);
  }
  for (const link of links) {
    const event = eventById.get(link.source_event_id);
    if (event) addTicket(event.master_account_id, event.master_trade_id);
    addTicket(link.follower_account_id, link.follower_position_id);
  }
  const trades: BrokerTradeStamp[] = [];
  for (const [accountId, tickets] of ticketsByAccount) {
    for (const batch of batches([...tickets], 40)) {
      const result = await db.from("trades")
        .select("trading_account_id, external_trade_id, opened_at")
        .eq("trading_account_id", accountId)
        .in("external_trade_id", batch);
      if (result.error) throw result.error;
      trades.push(...(result.data ?? []) as BrokerTradeStamp[]);
    }
  }
  const byFollower = summarizeBrokerTradeLatency(events, links, trades);
  console.log(JSON.stringify({
    interpretation: "broker-synced MT5 trade opened_at timestamps; not provider-response time or independent deal-receipt timing",
    since,
    linksInspected: links.length,
    truncated,
    matchedBrokerTrades: byFollower.reduce((sum, row) => sum + row.matchedBrokerTrades, 0),
    byFollower,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error("Read-only copy latency report failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
