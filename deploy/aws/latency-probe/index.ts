// Staging-only probe. No order route, broker call, database access, or user credential.
import { createHmac, timingSafeEqual } from "node:crypto";
import * as https from "node:https";
import { directLaneClientTls } from "../../../src/lib/gateway/directLaneTls";

const PROBE_PATH = "/probe";
const WORKER_PATH = "/probe/worker";
const WORKER_HEALTH_PATH = "/v1/health";

type ApiEvent = { rawPath?: string; headers?: Record<string, string | undefined> };

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function response(statusCode: number, headers: Record<string, string> = {}) {
  return { statusCode, headers: { "cache-control": "no-store, max-age=0", ...headers }, body: "" };
}

const workerAgent = (() => {
  const secret = process.env.WSA_TRADE_DIRECT_SECRET?.trim();
  return secret
    ? new https.Agent({ ...directLaneClientTls(secret), keepAlive: true, maxSockets: 4, maxFreeSockets: 2 })
    : null;
})();

function workerHealth(): Promise<boolean> {
  const secret = process.env.WSA_TRADE_DIRECT_SECRET?.trim();
  const base = process.env.WSA_TRADE_DIRECT_URL?.trim();
  if (!secret || !base || !workerAgent) return Promise.resolve(false);
  let url: URL;
  try {
    url = new URL(WORKER_HEALTH_PATH, base);
    if (url.protocol !== "https:") return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).digest("hex");
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: "GET", agent: workerAgent, headers: { "x-wsa-ts": timestamp, "x-wsa-sig": signature } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const answer = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
          const verified =
            res.statusCode === 200 &&
            equal(String(res.headers["x-wsa-ts"] ?? ""), timestamp) &&
            equal(String(res.headers["x-wsa-sig"] ?? ""), answer);
          resolve(verified && body.includes('"ok":true'));
        });
      },
    );
    req.setTimeout(2_500, () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

export async function handler(event: ApiEvent) {
  const expected = process.env.WSA_LATENCY_PROBE_KEY ?? "";
  const supplied = event?.headers?.["x-wsa-probe-key"] ?? "";
  if (!expected || !equal(expected, supplied)) return response(404);
  if (event.rawPath === PROBE_PATH) return response(204, { "x-wsa-probe": "aws-london" });
  if (event.rawPath === WORKER_PATH) {
    const start = performance.now();
    const ok = await workerHealth();
    return response(ok ? 204 : 503, {
      "x-wsa-probe": "aws-london-worker-health",
      "x-wsa-worker-ms": String(Math.round(performance.now() - start)),
    });
  }
  return response(404);
}
