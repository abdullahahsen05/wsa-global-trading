import { describe, expect, it } from "vitest";
import { readSelfCopySettings } from "@/lib/copy/selfCopyDecision";
import type { SelfCopyRoute, SelfCopyRouteStatus } from "@/lib/copy/selfCopyEngine";
import { pausedOnlySources, planSelfCopySources, type SelfCopyRouteEntry } from "@/lib/copy/selfCopySources";

function entry(id: string, source: string, status: SelfCopyRouteStatus, provider: string | null = `p-${source}`): SelfCopyRouteEntry {
  const route: SelfCopyRoute = {
    id,
    traderId: "t1",
    sourceAccountId: source,
    followerAccountId: `f-${id}`,
    status,
    settings: readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 0.1 }),
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  return { route, providerAccountId: provider };
}

describe("planSelfCopySources", () => {
  it("follows a source while one of its routes is live, with all of its routes", () => {
    const plans = planSelfCopySources([entry("r1", "A", "LIVE"), entry("r2", "A", "PAUSED"), entry("r3", "B", "LIVE")], new Set());
    expect([...plans.keys()].sort()).toEqual(["A", "B"]);
    expect(plans.get("A")).toMatchObject({ reason: "live", providerAccountId: "p-A" });
    expect(plans.get("A")?.routes.map((route) => route.id)).toEqual(["r1", "r2"]);
  });

  it("leaves a source with only paused routes alone when nothing is open on them", () => {
    expect(planSelfCopySources([entry("r1", "A", "PAUSED")], new Set()).size).toBe(0);
  });

  it("keeps following a source whose routes are all paused while copies are still open", () => {
    const plans = planSelfCopySources([entry("r1", "A", "PAUSED")], new Set(["A"]));
    expect(plans.get("A")).toMatchObject({ reason: "open-copies" });
  });

  it("never follows a removed route", () => {
    expect(planSelfCopySources([entry("r1", "A", "ARCHIVED")], new Set(["A"])).size).toBe(0);
  });

  it("takes the first broker id it finds for the source", () => {
    const plans = planSelfCopySources([entry("r1", "A", "LIVE", null), entry("r2", "A", "LIVE", "p-late")], new Set());
    expect(plans.get("A")?.providerAccountId).toBe("p-late");
  });

  it("reports a source without a broker id as it is, for the worker to explain", () => {
    expect(planSelfCopySources([entry("r1", "A", "LIVE", null)], new Set()).get("A")?.providerAccountId).toBeNull();
  });
});

describe("pausedOnlySources", () => {
  it("lists the sources that have paused routes and no live one", () => {
    const entries = [entry("r1", "A", "PAUSED"), entry("r2", "B", "LIVE"), entry("r3", "B", "PAUSED"), entry("r4", "C", "ARCHIVED"), entry("r5", "D", "PAUSED")];
    expect(pausedOnlySources(entries).sort()).toEqual(["A", "D"]);
  });
});
