import type { UserRole } from "@/lib/auth/rbac";
import { AI_ERROR, AiError } from "@/lib/ai/types";
import { listTradingAccounts } from "@/lib/services/tradingAccountService";
import { listTrades } from "@/lib/services/tradeService";
import { getDailyPnl } from "@/lib/services/tradeService";
import { listRiskEvents } from "@/lib/services/riskService";
import { getAnalyticsSummary } from "@/lib/services/analyticsService";
import { listUpcomingEvents, type EconomicEventDto } from "@/lib/services/economicCalendarService";
import { currenciesFromSymbols } from "@/lib/ai/symbols";
import type { AnalyticsSummary, TradeDto, TraderAccountSummary } from "@/lib/domain/types";
import { isLiveConnectedAccount } from "@/lib/accounts/lifecycle";

// ─────────────────────────────────────────────────────────────────────────────
// AI Assistant — trader context builder (server-only)
//
// Builds an AUTHORITATIVE, self-scoped JSON context for the logged-in trader.
// Security guarantees:
//   • Frontend-supplied numbers are never trusted — all data is fetched fresh.
//   • All account/trade/risk reads are scoped to the user's OWN data by forcing
//     role='TRADER' into the services (which filter by user_id), so even an
//     ADMIN using the trader assistant only sees their own accounts — never
//     platform-wide data or another user's data.
//   • If an accountId is supplied that the user does not own, we throw FORBIDDEN.
//   • Broker credentials, keys, tokens and other users' PII are never included.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_OPEN_TRADES = 50;
const MAX_RECENT_CLOSED = 20;
const MAX_RISK_EVENTS = 10;
const NEWS_WINDOW_HOURS = 48;

// Force self-scoped reads regardless of the caller's real role.
const SELF: UserRole = "TRADER";

interface CompactTrade {
  symbol: string;
  side: TradeDto["side"];
  status: TradeDto["status"];
  volume: number;
  openPrice: number;
  closePrice: number | null;
  profit: number;
  currency: string;
  openedAt: string;
  closedAt: string | null;
}

function compactTrade(t: TradeDto): CompactTrade {
  return {
    symbol: t.symbol,
    side: t.side,
    status: t.status,
    volume: t.volume,
    openPrice: t.openPrice,
    closePrice: t.closePrice,
    profit: t.profit.amount,
    currency: t.profit.currency,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
  };
}

function compactAccount(a: TraderAccountSummary) {
  return {
    accountId: a.accountId,
    accountName: a.accountName,
    brokerName: a.brokerName,
    serverName: a.serverName,
    platform: a.platform,
    status: a.status,
    currency: a.balance.currency,
    balance: a.balance.amount,
    equity: a.equity.amount,
    floatingPnl: a.floatingPnl.amount,
    drawdownPercent: a.drawdownPercent,
    openTradeCount: a.openTradeCount,
    lastUpdatedAt: a.updatedAt,
  };
}

export interface TraderAiContext {
  generatedAt: string;
  pageContext: string | null;
  trader: { name: string };
  hasConnectedAccounts: boolean;
  accountsOverview: { totalAccounts: number; byStatus: Record<string, number> };
  selectedAccount: ReturnType<typeof compactAccount> | null;
  dailyClosedPnl: { amount: number; currency: string };
  analytics: AnalyticsSummary | null;
  openTrades: CompactTrade[];
  recentClosedTrades: CompactTrade[];
  riskEvents: Array<{ ruleName: string; severity: string; message: string; createdAt: string }>;
  activeCurrencies: string[];
  upcomingHighImpactNews: EconomicEventDto[];
}

export async function buildTraderAiContext(params: {
  userId: string;
  role: UserRole;
  name: string;
  accountId?: string;
  pageContext?: string | null;
}): Promise<TraderAiContext> {
  const { userId, accountId, name } = params;

  // 1. Self-scoped accounts.
  const accounts = await listTradingAccounts(userId, SELF);

  // 2. Ownership check for an explicitly requested account.
  let selectedAccount: TraderAccountSummary | null = null;
  if (accountId) {
    selectedAccount = accounts.find((a) => a.accountId === accountId) ?? null;
    if (!selectedAccount) {
      throw new AiError(
        AI_ERROR.FORBIDDEN,
        "You do not have access to this account.",
        403,
      );
    }
  } else {
    selectedAccount =
      accounts.find(isLiveConnectedAccount) ??
      accounts[0] ??
      null;
  }

  const scopedAccountId = selectedAccount?.accountId;

  // 3. Trades, risk, analytics, daily PnL — all self-scoped.
  const [openTrades, closedTrades, riskEvents, dailyPnl] = await Promise.all([
    listTrades({ userId, role: SELF, accountId: scopedAccountId, status: "OPEN", limit: MAX_OPEN_TRADES }),
    listTrades({ userId, role: SELF, accountId: scopedAccountId, status: "CLOSED", limit: MAX_RECENT_CLOSED }),
    listRiskEvents(scopedAccountId, userId, SELF),
    getDailyPnl(userId),
  ]);

  let analytics: AnalyticsSummary | null = null;
  if (scopedAccountId) {
    try {
      analytics = await getAnalyticsSummary(scopedAccountId, userId, SELF);
    } catch {
      analytics = null;
    }
  }

  // 4. Derive active currencies → upcoming high/medium-impact news (next 48h).
  const symbols = [...openTrades, ...closedTrades].map((t) => t.symbol);
  const activeCurrencies = currenciesFromSymbols(symbols);

  let upcomingHighImpactNews: EconomicEventDto[] = [];
  if (activeCurrencies.length > 0) {
    const now = new Date();
    const to = new Date(now.getTime() + NEWS_WINDOW_HOURS * 60 * 60 * 1000);
    try {
      upcomingHighImpactNews = await listUpcomingEvents({
        currencies: activeCurrencies,
        fromIso: now.toISOString(),
        toIso: to.toISOString(),
        impacts: ["HIGH", "MEDIUM"],
        limit: 20,
      });
    } catch {
      upcomingHighImpactNews = [];
    }
  }

  const byStatus: Record<string, number> = {};
  for (const a of accounts) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    pageContext: params.pageContext ?? null,
    trader: { name },
    hasConnectedAccounts: accounts.length > 0,
    accountsOverview: { totalAccounts: accounts.length, byStatus },
    selectedAccount: selectedAccount ? compactAccount(selectedAccount) : null,
    dailyClosedPnl: { amount: dailyPnl.dailyPnl, currency: dailyPnl.currency },
    analytics,
    openTrades: openTrades.map(compactTrade),
    recentClosedTrades: closedTrades.map(compactTrade),
    riskEvents: riskEvents.slice(0, MAX_RISK_EVENTS).map((e) => ({
      ruleName: e.ruleName,
      severity: e.severity,
      message: e.message,
      createdAt: e.createdAt,
    })),
    activeCurrencies,
    upcomingHighImpactNews,
  };
}
