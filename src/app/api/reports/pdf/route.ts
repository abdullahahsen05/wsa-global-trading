import { AuthError, requireAuth } from "@/lib/auth/session";
import type { TradeDto } from "@/lib/domain/types";
import { generateTradeReportPdf } from "@/lib/pdf/tradeReportPdf";
import { jsonFail } from "@/lib/api/envelope";
import { z } from "zod";

const tradeSchema = z.object({
  id: z.string(),
  shortTradeId: z.string(),
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  status: z.enum(["OPEN", "CLOSED"]),
  volume: z.number(),
  openPrice: z.number().nullable().optional(),
  closePrice: z.number().nullable().optional(),
  openedAt: z.string(),
  closedAt: z.string().nullable().optional(),
  profit: z.object({
    amount: z.number(),
    currency: z.string(),
  }),
});

const requestSchema = z.object({
  reportName: z.string().min(1).max(120),
  period: z.string().min(1).max(120),
  currency: z.string().min(1).max(12),
  trades: z.array(tradeSchema).max(5000),
});

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = requestSchema.parse(await request.json());
    const pdf = await generateTradeReportPdf({
      reportName: body.reportName,
      period: body.period,
      trades: body.trades as TradeDto[],
      currency: body.currency,
    });
    const pdfBytes = Uint8Array.from(pdf);
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonFail("AUTH_ERROR", error.message, error.statusCode);
    }
    if (error instanceof z.ZodError) {
      return jsonFail("INVALID_REQUEST", "Invalid report export payload.", 400);
    }
    return jsonFail("PDF_EXPORT_FAILED", "Unable to generate the PDF report right now.", 500);
  }
}
