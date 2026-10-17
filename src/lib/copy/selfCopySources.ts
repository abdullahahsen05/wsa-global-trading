/**
 * Which source accounts the copy worker has to listen to for self-copy. Pure - shared with the AWS worker.
 *
 * A source is followed while one of its routes is LIVE. A route that is only PAUSED still has to be
 * followed as long as it holds open copies: the copies keep mirroring the source's changes and
 * closes (pausing stops NEW copies, it does not abandon the ones that are open).
 */

import type { SelfCopyRoute } from "@/lib/copy/selfCopyEngine";

export interface SelfCopyRouteEntry {
  route: SelfCopyRoute;
  /** the bridge's id of the SOURCE account (null = the account is not registered at the bridge) */
  providerAccountId: string | null;
}

export interface SelfCopySourcePlan {
  sourceAccountId: string;
  providerAccountId: string | null;
  /** the live and paused routes of this source, as of the last look at the database */
  routes: SelfCopyRoute[];
  /** `live`: a route is live; `open-copies`: every route is paused but copies are still open */
  reason: "live" | "open-copies";
}

export function planSelfCopySources(
  entries: ReadonlyArray<SelfCopyRouteEntry>,
  sourcesWithOpenCopies: ReadonlySet<string>,
): Map<string, SelfCopySourcePlan> {
  const grouped = new Map<string, { routes: SelfCopyRoute[]; providerAccountId: string | null }>();
  for (const { route, providerAccountId } of entries) {
    if (route.status === "ARCHIVED") continue;
    const group = grouped.get(route.sourceAccountId) ?? { routes: [], providerAccountId: null };
    group.routes.push(route);
    group.providerAccountId ??= providerAccountId;
    grouped.set(route.sourceAccountId, group);
  }

  const plans = new Map<string, SelfCopySourcePlan>();
  for (const [sourceAccountId, group] of grouped) {
    const live = group.routes.some((route) => route.status === "LIVE");
    if (!live && !sourcesWithOpenCopies.has(sourceAccountId)) continue;
    plans.set(sourceAccountId, {
      sourceAccountId,
      providerAccountId: group.providerAccountId,
      routes: group.routes,
      reason: live ? "live" : "open-copies",
    });
  }
  return plans;
}

/** The sources that have routes but none that is live: only these need the "open copies" question answered. */
export function pausedOnlySources(entries: ReadonlyArray<SelfCopyRouteEntry>): string[] {
  const live = new Set<string>();
  const paused = new Set<string>();
  for (const { route } of entries) {
    if (route.status === "LIVE") live.add(route.sourceAccountId);
    else if (route.status === "PAUSED") paused.add(route.sourceAccountId);
  }
  return [...paused].filter((sourceAccountId) => !live.has(sourceAccountId));
}
