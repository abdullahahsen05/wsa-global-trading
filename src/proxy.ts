import { NextResponse, type NextRequest } from "next/server";

type WindowBucket = {
  count: number;
  resetAt: number;
};

type RateRule = {
  name: string;
  limit: number;
  windowMs: number;
};

const buckets = new Map<string, WindowBucket>();
let lastSweepAt = 0;

const minute = 60_000;

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

function ruleFor(pathname: string, method: string): RateRule {
  if (pathname.startsWith("/api/webhooks/stripe")) {
    return { name: "stripe-webhook", limit: 240, windowMs: minute };
  }
  if (pathname.startsWith("/api/worker/")) {
    return { name: "worker", limit: 90, windowMs: minute };
  }
  if (pathname.startsWith("/api/ai/")) {
    return { name: "ai", limit: 30, windowMs: minute };
  }
  if (pathname.startsWith("/api/auth/")) {
    return { name: "auth", limit: 45, windowMs: minute };
  }
  if (pathname.startsWith("/api/billing/checkout") || pathname.startsWith("/api/billing/portal")) {
    return { name: "billing-mutation", limit: 20, windowMs: minute };
  }
  if (
    pathname.includes("/sync") ||
    pathname.includes("sync-trades") ||
    pathname.includes("broker-credentials") ||
    pathname.includes("connect")
  ) {
    return { name: "broker-sync", limit: 18, windowMs: minute };
  }
  if (pathname.startsWith("/api/admin/")) {
    return method === "GET"
      ? { name: "admin-read", limit: 240, windowMs: minute }
      : { name: "admin-write", limit: 90, windowMs: minute };
  }
  if (method !== "GET") {
    return { name: "api-write", limit: 75, windowMs: minute };
  }
  return { name: "api-read", limit: 360, windowMs: minute };
}

function sweepExpired(now: number) {
  if (now - lastSweepAt < minute) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function proxy(request: NextRequest) {
  const now = Date.now();
  sweepExpired(now);

  const { pathname } = request.nextUrl;
  const rule = ruleFor(pathname, request.method);
  const ip = clientIp(request);
  const key = `${rule.name}:${ip}`;
  const current = buckets.get(key);
  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + rule.windowMs };

  bucket.count += 1;
  buckets.set(key, bucket);

  const remaining = Math.max(0, rule.limit - bucket.count);
  if (bucket.count > rule.limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Please wait a moment and try again.",
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(rule.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(bucket.resetAt / 1000)),
        },
      },
    );
  }

  const response = NextResponse.next();
  response.headers.set("X-RateLimit-Limit", String(rule.limit));
  response.headers.set("X-RateLimit-Remaining", String(remaining));
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
