import { AuthError, requireTrader } from "@/lib/auth/session";
import { jsonFail } from "@/lib/api/envelope";
import { listTrades } from "@/lib/services/tradeService";
import { formatPrice } from "@/lib/utils/format";

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const normalized = String(value);
  return /[",\r\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

export async function GET() {
  try {
    const user = await requireTrader();
    const trades = await listTrades({ userId: user.id, role: user.role, limit: 10_000 });
    const rows = [
      [
        "Trade ID",
        "Account ID",
        "Symbol",
        "Side",
        "Status",
        "Volume",
        "Open price",
        "Close price",
        "Profit",
        "Currency",
        "Opened at",
        "Closed at",
      ],
      ...trades.map((trade) => [
        trade.shortTradeId,
        trade.accountId,
        trade.symbol,
        trade.side,
        trade.status,
        trade.volume,
        formatPrice(trade.openPrice),
        formatPrice(trade.closePrice),
        trade.profit.amount,
        trade.profit.currency,
        trade.openedAt,
        trade.closedAt,
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="wsa-global-trades-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    throw error;
  }
}
