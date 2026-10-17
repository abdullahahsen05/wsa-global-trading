/**
 * Whether the copy worker is listening to the source account of a self-copy route.
 *
 * The worker (AWS) writes `engine_status` / `engine_error` / `engine_heartbeat_at` on the route
 * when it opens, loses or keeps the stream of the source account (migration 061). The web only
 * reads them: a heartbeat that stops means the worker stopped, whatever the last status said.
 *
 * Pure - shared by the service, the "check route" button and the tests.
 */

import type { SelfCopyCheck } from "@/lib/copy/selfCopyDecision";

/** A worker that has not reported for this long is taken as gone (it reports about once a minute). */
export const ENGINE_FRESH_MS = 3 * 60_000;

export type EngineState = "listening" | "starting" | "error" | "stale" | "unreported";

export interface EngineReport {
  status: string | null;
  error: string | null;
  heartbeatAt: string | null;
}

export interface EngineVerdict {
  state: EngineState;
  /** the worker is connected to the source account right now */
  listening: boolean;
  check: SelfCopyCheck;
}

function ago(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

export function judgeEngine(report: EngineReport | null, now: number = Date.now()): EngineVerdict {
  const label = "Copy worker listens to the source account";
  const status = report?.status ?? null;
  if (!report || status === null) {
    return {
      state: "unreported",
      listening: false,
      check: {
        id: "WORKER_LISTENING",
        label,
        status: "warn",
        detail:
          "The copy worker has not reported on this route yet. A worker that runs the latest version reports within a minute; otherwise it has to pull the latest code and restart.",
      },
    };
  }

  const heartbeat = report.heartbeatAt ? Date.parse(report.heartbeatAt) : Number.NaN;
  const age = Number.isFinite(heartbeat) ? Math.max(0, now - heartbeat) : null;

  if (status === "ERROR") {
    return {
      state: "error",
      listening: false,
      check: {
        id: "WORKER_LISTENING",
        label,
        status: "fail",
        detail: report.error?.trim()
          ? `The copy worker cannot follow the source account: ${report.error.trim()}`
          : "The copy worker cannot follow the source account.",
      },
    };
  }

  if (age === null || age > ENGINE_FRESH_MS) {
    return {
      state: "stale",
      listening: false,
      check: {
        id: "WORKER_LISTENING",
        label,
        status: "fail",
        detail:
          age === null
            ? "The copy worker has not reported a heartbeat. It may be stopped."
            : `The copy worker last reported ${ago(age)} ago. It may be stopped.`,
      },
    };
  }

  if (status === "STARTING") {
    return {
      state: "starting",
      listening: false,
      check: { id: "WORKER_LISTENING", label, status: "warn", detail: "The copy worker is connecting to the source account." },
    };
  }

  return {
    state: "listening",
    listening: true,
    check: {
      id: "WORKER_LISTENING",
      label,
      status: "pass",
      detail: `The copy worker is listening to the source account (reported ${ago(age)} ago).`,
    },
  };
}
