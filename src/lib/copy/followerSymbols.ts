/**
 * The follower broker's symbol list, as a copy needs it: asked for with a time limit, because a
 * copy is worth milliseconds and a symbol name is only worth waiting for a moment.
 *
 * The adapter keeps each account's list for 15 minutes, so this is a map lookup once the list is
 * warm (the workers warm it). Shared by the self-copy and the strategy copy engines; both run on
 * the AWS workers, so no Next / React / `server-only` imports.
 */

import type { BrokerAdapter, BrokerSymbolInfo } from "@/lib/broker/BrokerAdapter";

/** How long a copy waits for a cold symbol list before it goes on with the names it was given. */
export const SYMBOL_LIST_BUDGET_MS = 250;

/**
 * Every symbol the account's broker offers, or null when the list is not known (the bridge has
 * none, the call failed, or it did not answer within `budgetMs`). Never throws.
 */
export async function symbolsWithin(
  adapter: Pick<BrokerAdapter, "fetchSymbolList">,
  accountId: string,
  budgetMs: number = SYMBOL_LIST_BUDGET_MS,
): Promise<BrokerSymbolInfo[] | null> {
  if (!adapter.fetchSymbolList) return null;
  const pending = adapter.fetchSymbolList(accountId).catch(() => [] as BrokerSymbolInfo[]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
    timer.unref?.();
  });
  try {
    const list = await Promise.race([pending, budget]);
    return list && list.length > 0 ? list : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
