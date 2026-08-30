import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { TradeDto } from "@/lib/domain/types";

interface TradeReportPdfInput {
  reportName: string;
  period: string;
  trades: TradeDto[];
  currency: string;
}

function drawBrand(page: PDFPage, bold: PDFFont) {
  page.drawRectangle({ x: 40, y: 742, width: 26, height: 26, color: rgb(1, 0.82, 0) });
  page.drawText("W", {
    x: 47,
    y: 748,
    size: 16,
    font: bold,
    color: rgb(0.05, 0.05, 0.06),
  });
  page.drawText("WSA GLOBAL", {
    x: 76,
    y: 750,
    size: 14,
    font: bold,
    color: rgb(0.96, 0.96, 0.94),
  });
}

function drawPageFrame(page: PDFPage) {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.05, 0.05, 0.06) });
  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: rgb(1, 0.82, 0), borderWidth: 1.5 });
  page.drawRectangle({ x: 34, y: 34, width: width - 68, height: height - 68, color: rgb(0.08, 0.08, 0.09) });
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function drawSummaryCard(page: PDFPage, params: {
  x: number;
  y: number;
  w: number;
  title: string;
  value: string;
  tone?: "default" | "positive" | "negative";
  regular: PDFFont;
  bold: PDFFont;
}) {
  const toneColor = params.tone === "positive"
    ? rgb(0.45, 0.95, 0.55)
    : params.tone === "negative"
      ? rgb(1, 0.45, 0.45)
      : rgb(0.96, 0.96, 0.94);
  page.drawRectangle({
    x: params.x,
    y: params.y,
    width: params.w,
    height: 62,
    color: rgb(0.1, 0.1, 0.11),
    borderColor: rgb(0.2, 0.2, 0.22),
    borderWidth: 1,
  });
  page.drawText(params.title.toUpperCase(), {
    x: params.x + 12,
    y: params.y + 42,
    size: 8,
    font: params.bold,
    color: rgb(0.64, 0.64, 0.62),
  });
  page.drawText(params.value, {
    x: params.x + 12,
    y: params.y + 18,
    size: 18,
    font: params.bold,
    color: toneColor,
  });
}

function drawTableHeader(page: PDFPage, bold: PDFFont, topY: number) {
  page.drawRectangle({
    x: 42,
    y: topY - 18,
    width: 510,
    height: 20,
    color: rgb(0.14, 0.14, 0.15),
  });
  const labels = [
    ["Trade", 50],
    ["Symbol", 122],
    ["Side", 196],
    ["Status", 238],
    ["Volume", 292],
    ["P&L", 348],
    ["Opened", 420],
    ["Closed", 490],
  ] as const;
  for (const [label, x] of labels) {
    page.drawText(label, {
      x,
      y: topY - 12,
      size: 8,
      font: bold,
      color: rgb(0.75, 0.75, 0.72),
    });
  }
}

function fit(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

export async function generateTradeReportPdf(input: TradeReportPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`WSA Global Report — ${input.reportName}`);
  pdf.setAuthor("WSA Global");
  pdf.setSubject(`${input.reportName} trading report`);
  pdf.setKeywords(["WSA Global", "trading", "report", "pdf"]);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const closedTrades = input.trades.filter((trade) => trade.status === "CLOSED");
  const totalPnl = closedTrades.reduce((sum, trade) => sum + trade.profit.amount, 0);
  const winningDays = new Set(
    closedTrades
      .filter((trade) => trade.profit.amount > 0)
      .map((trade) => new Date(trade.closedAt ?? trade.openedAt).toISOString().slice(0, 10)),
  ).size;

  let page = pdf.addPage([595, 842]);
  drawPageFrame(page);
  drawBrand(page, bold);

  page.drawText(input.reportName, {
    x: 42,
    y: 694,
    size: 24,
    font: bold,
    color: rgb(0.96, 0.96, 0.94),
  });
  page.drawText(input.period, {
    x: 42,
    y: 672,
    size: 11,
    font: regular,
    color: rgb(0.7, 0.7, 0.68),
  });

  drawSummaryCard(page, { x: 42, y: 586, w: 160, title: "Trades", value: String(input.trades.length), regular, bold });
  drawSummaryCard(page, {
    x: 218,
    y: 586,
    w: 160,
    title: "Closed P&L",
    value: money(totalPnl, input.currency),
    tone: totalPnl >= 0 ? "positive" : "negative",
    regular,
    bold,
  });
  drawSummaryCard(page, { x: 394, y: 586, w: 158, title: "Winning days", value: String(winningDays), regular, bold });

  page.drawText("Trade ledger", {
    x: 42,
    y: 548,
    size: 14,
    font: bold,
    color: rgb(1, 0.82, 0),
  });

  let cursorY = 522;
  drawTableHeader(page, bold, cursorY);
  cursorY -= 34;

  const rowsPerPage = 22;
  input.trades.forEach((trade, index) => {
    if (index > 0 && index % rowsPerPage === 0) {
      page = pdf.addPage([595, 842]);
      drawPageFrame(page);
      drawBrand(page, bold);
      page.drawText(`${input.reportName} — continued`, {
        x: 42,
        y: 704,
        size: 16,
        font: bold,
        color: rgb(0.96, 0.96, 0.94),
      });
      cursorY = 668;
      drawTableHeader(page, bold, cursorY);
      cursorY -= 34;
    }

    const pnlColor = trade.profit.amount >= 0 ? rgb(0.45, 0.95, 0.55) : rgb(1, 0.45, 0.45);
    const rowY = cursorY - (index % rowsPerPage) * 24;
    page.drawRectangle({
      x: 42,
      y: rowY - 6,
      width: 510,
      height: 20,
      color: index % 2 === 0 ? rgb(0.095, 0.095, 0.1) : rgb(0.11, 0.11, 0.115),
    });

    const opened = new Date(trade.openedAt).toLocaleDateString("en-GB");
    const closed = trade.closedAt ? new Date(trade.closedAt).toLocaleDateString("en-GB") : "—";

    const cells = [
      [fit(trade.shortTradeId, 10), 50, rgb(0.95, 0.95, 0.93)],
      [fit(trade.symbol, 8), 122, rgb(0.95, 0.95, 0.93)],
      [trade.side, 196, rgb(0.95, 0.95, 0.93)],
      [trade.status, 238, rgb(0.78, 0.78, 0.75)],
      [String(trade.volume), 292, rgb(0.95, 0.95, 0.93)],
      [money(trade.profit.amount, trade.profit.currency || input.currency), 348, pnlColor],
      [opened, 420, rgb(0.78, 0.78, 0.75)],
      [closed, 490, rgb(0.78, 0.78, 0.75)],
    ] as const;

    for (const [value, x, color] of cells) {
      page.drawText(value, {
        x,
        y: rowY,
        size: 7.5,
        font: regular,
        color,
      });
    }
  });

  return pdf.save();
}
