import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

const production = process.argv.includes("--production");
loadEnvConfig(process.cwd(), !production);
const runWorkers = production || process.env.WSA_DEV_WORKERS === "true";

const node = process.execPath;
const services: Array<{ name: string; process: ChildProcess }> = [];
let shuttingDown = false;

function start(name: string, args: string[]) {
  const child = spawn(node, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  services.push({ name, process: child });
  child.on("error", (error) => {
    console.error(`[dev] ${name} failed to start: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} stopped unexpectedly (${signal ?? code ?? "unknown"}).`);
    shutdown(code ?? 1);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const service of services) {
    if (!service.process.killed) service.process.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 1_500).unref();
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

start(
  "Next.js",
  production
    ? [resolve("node_modules/next/dist/bin/next"), "start"]
    : [resolve("node_modules/next/dist/bin/next"), "dev", "--webpack"],
);

if (
  runWorkers &&
  process.env.WSA_COPY_ENGINE_ENABLED === "true" &&
  process.env.BROKER_EXECUTION_ENABLED === "true"
) {
  start("WSA copy worker", [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/wsa-copy-worker.ts")]);
  console.log("[dev] WSA live copy worker enabled.");
} else {
  console.warn(
    production
      ? "[dev] WSA live copy worker is disabled by the execution flags."
      : "[dev] WSA live copy worker is disabled in development. Set WSA_DEV_WORKERS=true to enable it.",
  );
}

if (
  runWorkers &&
  process.env.METAAPI_TOKEN &&
  process.env.WSA_RISK_ENGINE_ENABLED !== "false"
) {
  start("WSA risk worker", [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/wsa-risk-worker.ts")]);
  console.log("[dev] WSA live risk worker enabled.");
} else {
  console.warn(
    production
      ? "[dev] WSA live risk worker is disabled or METAAPI_TOKEN is missing."
      : "[dev] WSA live risk worker is disabled in development. Set WSA_DEV_WORKERS=true to enable it.",
  );
}
