// Read-only network comparison. Neither endpoint can place an order.
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const key = execFileSync(
  "aws",
  ["ssm", "get-parameter", "--region", "eu-west-2", "--profile", "wsa-client", "--name", "/wsa/test/WSA_LATENCY_PROBE_KEY", "--with-decryption", "--query", "Parameter.Value", "--output", "text"],
  { encoding: "utf8" },
).trim();
if (!key) throw new Error("Probe key is unavailable");

const endpoints = [
  ["vercel", "https://wsa-global-trading-platform.vercel.app/api/terminal/trade/open", {}],
  ["aws-worker", "https://bhe6dp0gl6.execute-api.eu-west-2.amazonaws.com/probe/worker", { "x-wsa-probe-key": key }],
];
const results = new Map(endpoints.map(([name]) => [name, []]));

for (let round = 0; round < 12; round++) {
  for (const [name, url, headers] of round % 2 ? [...endpoints].reverse() : endpoints) {
    const start = performance.now();
    const response = await fetch(url, { method: "GET", headers, cache: "no-store" });
    await response.arrayBuffer();
    const elapsed = Math.round(performance.now() - start);
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    results.get(name).push(elapsed);
    console.log(`${round} ${name} ${elapsed}ms${name === "aws-worker" ? ` worker=${response.headers.get("x-wsa-worker-ms")}ms` : ""}`);
  }
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return (ordered[4] + ordered[5]) / 2;
}
for (const [name, values] of results) console.log(`${name} warm median: ${median(values.slice(2))}ms`);

const preflightStart = performance.now();
const preflight = await fetch("https://bhe6dp0gl6.execute-api.eu-west-2.amazonaws.com/probe/worker", {
  method: "OPTIONS",
  headers: {
    origin: "https://wsa-global-trading-platform.vercel.app",
    "access-control-request-method": "GET",
    "access-control-request-headers": "x-wsa-probe-key",
  },
});
if (preflight.status !== 204) throw new Error(`Preflight returned HTTP ${preflight.status}`);
console.log(`AWS cross-origin preflight (uncached): ${Math.round(performance.now() - preflightStart)}ms`);
