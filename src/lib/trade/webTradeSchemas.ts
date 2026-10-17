/**
 * Request validation of the WSA Trade routes (zod). Kept apart from `webTrade.ts`
 * so the panel itself - which only needs the pure helpers and the DTO types -
 * does not pull zod into the browser bundle.
 */

import { z } from "zod";
import {
  isValidLots,
  levelsProblem,
  MAX_TRADE_LEVEL,
  pendingLevelsProblem,
  REQUEST_ID_PATTERN,
  TICKET_PATTERN,
  TRADE_SYMBOL_PATTERN,
  WEB_TRADE_BULK_SCOPES,
  WEB_TRADE_MAX_LOTS,
  WEB_TRADE_MIN_LOTS,
  WEB_TRADE_ORDER_KINDS,
  WEB_TRADE_SIDES,
} from "@/lib/trade/webTrade";

const accountIdSchema = z.string().uuid("Account is not valid.");
const symbolSchema = z.string().trim().regex(TRADE_SYMBOL_PATTERN, "Symbol is not valid.");
const ticketSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().regex(TICKET_PATTERN, "Position is not valid."));
const lotsSchema = z
  .number("Volume must be a number.")
  .min(WEB_TRADE_MIN_LOTS, `Volume must be at least ${WEB_TRADE_MIN_LOTS} lot.`)
  .max(WEB_TRADE_MAX_LOTS, `Volume cannot be above ${WEB_TRADE_MAX_LOTS} lots.`)
  .refine(isValidLots, "Volume can have at most 3 decimals.");
const levelSchema = z.number("Level must be a number.").positive("Level must be above zero.").max(MAX_TRADE_LEVEL);
const priceSchema = z.number("Price must be a number.").positive("Price must be above zero.").max(MAX_TRADE_LEVEL);
/** one per click: a repeated request with the same id never sends a second order */
const requestIdSchema = z.string().regex(REQUEST_ID_PATTERN, "Request id is not valid.");

export const webTradeOpenSchema = z
  .object({
    accountId: accountIdSchema,
    symbol: symbolSchema,
    side: z.enum(WEB_TRADE_SIDES),
    volume: lotsSchema,
    /** MARKET (default) executes now; LIMIT / STOP wait for `price` */
    orderKind: z.enum(WEB_TRADE_ORDER_KINDS).optional(),
    /** the price a pending order waits for */
    price: priceSchema.nullish(),
    stopLoss: levelSchema.nullish(),
    takeProfit: levelSchema.nullish(),
    clientRequestId: requestIdSchema,
  })
  .superRefine((value, context) => {
    if ((value.orderKind ?? "MARKET") === "MARKET") {
      const problem = levelsProblem(value.side, value.stopLoss, value.takeProfit);
      if (problem) context.addIssue({ code: "custom", message: problem, path: ["stopLoss"] });
      return;
    }
    if (!value.price) {
      context.addIssue({ code: "custom", message: "Enter the price the order waits for.", path: ["price"] });
      return;
    }
    const problem = pendingLevelsProblem(value.side, value.price, value.stopLoss, value.takeProfit);
    if (problem) context.addIssue({ code: "custom", message: problem, path: ["stopLoss"] });
  });

/**
 * `null` removes a level, a number sets it, a missing key leaves it as it is.
 * `price` moves the entry of a PENDING order.
 */
export const webTradeModifySchema = z
  .object({
    accountId: accountIdSchema,
    ticket: ticketSchema,
    stopLoss: levelSchema.nullable().optional(),
    takeProfit: levelSchema.nullable().optional(),
    price: priceSchema.optional(),
    clientRequestId: requestIdSchema.optional(),
  })
  .refine((value) => value.stopLoss !== undefined || value.takeProfit !== undefined || value.price !== undefined, {
    message: "Nothing to change.",
    path: ["stopLoss"],
  });

/** Without a volume the whole position is closed. */
export const webTradeCloseSchema = z.object({
  accountId: accountIdSchema,
  ticket: ticketSchema,
  volume: lotsSchema.optional(),
  clientRequestId: requestIdSchema.optional(),
});

/** Deletes a pending order. */
export const webTradeCancelSchema = z.object({
  accountId: accountIdSchema,
  ticket: ticketSchema,
  clientRequestId: requestIdSchema.optional(),
});

/** Closes several positions (or deletes the pending orders) at once. */
export const webTradeCloseBulkSchema = z
  .object({
    accountId: accountIdSchema,
    scope: z.enum(WEB_TRADE_BULK_SCOPES),
    symbol: symbolSchema.nullish(),
    clientRequestId: requestIdSchema.optional(),
  })
  .refine((value) => value.scope !== "SYMBOL" || Boolean(value.symbol), {
    message: "Choose the symbol to close.",
    path: ["symbol"],
  });

export const webTradeStateQuerySchema = z.object({
  accountId: accountIdSchema,
  symbol: symbolSchema.optional(),
});

export const webTradeSymbolsQuerySchema = z.object({
  accountId: accountIdSchema,
});

/** The messages of a failed validation as one text (no duplicates). */
export function issuesText(error: z.ZodError): string {
  return Array.from(new Set(error.issues.map((issue) => issue.message))).join(" ");
}

export type WebTradeOpenInput = z.infer<typeof webTradeOpenSchema>;
export type WebTradeModifyInput = z.infer<typeof webTradeModifySchema>;
export type WebTradeCloseInput = z.infer<typeof webTradeCloseSchema>;
export type WebTradeCancelInput = z.infer<typeof webTradeCancelSchema>;
export type WebTradeCloseBulkInput = z.infer<typeof webTradeCloseBulkSchema>;
