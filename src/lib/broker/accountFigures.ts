/**
 * Balance / equity out of a broker `AccountSummary` (pure - safe in the workers).
 *
 * Why this exists: the summary used to be read with `Number(summary.balance ?? 0)`.
 * A session that is still loading (or a bridge hiccup) answers with a partial
 * object, and the platform stored `balance 0 / equity 0` as if it were a real
 * reading - the equity curve then fell to zero and back, and the account-level
 * equity peak / drawdown were computed from it. An incomplete answer is now an
 * error (the cycle is retried), never a snapshot.
 */

export interface AccountSummaryLike {
  balance?: unknown;
  equity?: unknown;
  profit?: unknown;
  credit?: unknown;
}

export interface AccountFigures {
  balance: number;
  equity: number;
  /** the broker's own floating P&L when it reports one */
  floating: number | null;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class IncompleteAccountSummaryError extends Error {
  constructor(detail: string) {
    super(`Broker returned an incomplete account summary (${detail}).`);
    this.name = "IncompleteAccountSummaryError";
  }
}

/**
 * - no balance                         -> error (nothing to record);
 * - no equity                          -> balance + credit + floating P&L when the
 *                                         broker reports it, otherwise the balance;
 * - equity exactly 0 with balance > 0  -> error: with a positive balance the
 *                                         equity can not be exactly zero, that is a
 *                                         half-loaded answer.
 */
export function readAccountFigures(summary: AccountSummaryLike): AccountFigures {
  const balance = finiteOrNull(summary.balance);
  if (balance === null) throw new IncompleteAccountSummaryError("balance is missing");

  const floating = finiteOrNull(summary.profit);
  const credit = finiteOrNull(summary.credit) ?? 0;
  const reportedEquity = finiteOrNull(summary.equity);
  const equity = reportedEquity ?? (floating !== null ? balance + credit + floating : balance);

  if (equity === 0 && balance > 0) throw new IncompleteAccountSummaryError("equity is 0 while the balance is positive");
  return { balance, equity, floating };
}
