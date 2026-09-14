import { afterEach, describe, expect, test, vi } from "vitest";
import { searchKnownMetaApiServers } from "@/lib/services/metaApiServerDiscoveryService";

const originalToken = process.env.METAAPI_TOKEN;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.METAAPI_TOKEN;
  else process.env.METAAPI_TOKEN = originalToken;
});

describe("MetaApi known server discovery", () => {
  test("flattens servers grouped by broker", async () => {
    process.env.METAAPI_TOKEN = "test-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      "Raw Trading Ltd": ["ICMarketsSC-Demo", "ICMarketsSC-MT5"],
      "IC Markets Ltd": ["ICMarketsInternational-Demo"],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchKnownMetaApiServers({ platform: "MT5", query: "IC Markets" });

    expect(result.available).toBe(true);
    expect(result.servers).toHaveLength(3);
    expect(result.servers[0]).toEqual({
      brokerName: "Raw Trading Ltd",
      serverName: "ICMarketsSC-Demo",
    });
    const [, request] = fetchMock.mock.calls[0];
    expect(request.headers["auth-token"]).toBe("test-token");
  });

  test("returns an honest unavailable state when MetaApi is not configured", async () => {
    delete process.env.METAAPI_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchKnownMetaApiServers({ platform: "MT5", query: "broker" });

    expect(result.available).toBe(false);
    expect(result.servers).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not leak provider error payloads to the caller", async () => {
    process.env.METAAPI_TOKEN = "test-token";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "provider-internal-detail" }), { status: 500 }),
    ));

    const result = await searchKnownMetaApiServers({ platform: "MT4", query: "broker" });

    expect(result.available).toBe(false);
    expect(result.message).toBe("Broker server search is temporarily unavailable.");
    expect(result.message).not.toContain("provider-internal-detail");
  });
});
