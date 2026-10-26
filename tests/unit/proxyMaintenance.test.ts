import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";
// Next 16.2.6 documents doesProxyMatch, but currently exports the legacy name.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "@/proxy";

const previousMode = process.env.WSA_MAINTENANCE_MODE;

afterEach(() => {
  if (previousMode === undefined) delete process.env.WSA_MAINTENANCE_MODE;
  else process.env.WSA_MAINTENANCE_MODE = previousMode;
});

function request(path: string, method = "GET") {
  return new NextRequest(`https://example.test${path}`, { method });
}

describe("database-cutover maintenance gate", () => {
  test("matches page actions as well as API requests", () => {
    for (const url of ["https://example.test/", "https://example.test/dashboard", "https://example.test/api/accounts"]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "https://example.test/_next/static/app.js" })).toBe(false);
  });

  test("stays disabled by default without changing the existing API limiter", () => {
    delete process.env.WSA_MAINTENANCE_MODE;
    expect(proxy(request("/dashboard")).status).toBe(200);
    const response = proxy(request("/api/accounts"));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("360");
  });

  test("pauses dynamic GET and POST paths, including API calls", async () => {
    process.env.WSA_MAINTENANCE_MODE = "true";
    for (const method of ["GET", "POST"]) {
      const page = proxy(request("/dashboard", method));
      expect(page.status).toBe(503);
      expect(page.headers.get("Retry-After")).toBe("60");
      expect(page.headers.get("Cache-Control")).toBe("no-store");

      const api = proxy(request("/api/accounts", method));
      expect(api.status).toBe(503);
      expect((await api.json()).error.code).toBe("MAINTENANCE");
    }
  });

  test("keeps framework assets available while paused", () => {
    process.env.WSA_MAINTENANCE_MODE = "true";
    expect(proxy(request("/_next/static/app.js")).status).toBe(200);
  });
});
