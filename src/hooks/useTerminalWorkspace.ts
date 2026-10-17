"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultWorkspace,
  mergeWorkspace,
  sanitizeWorkspace,
  type TerminalWorkspace,
  type TerminalWorkspacePatch,
} from "@/lib/terminal/workspace";

/**
 * The terminal workspace (open tab, TradingView settings, MetaTrader settings).
 *
 *  - The stored copy (`/api/terminal/workspace`, per user) is the source of truth.
 *  - A device-local copy restores the layout instantly on the next visit and keeps
 *    it when the server cannot store it. It deliberately leaves out everything
 *    account-specific (accounts added by hand, the selected account) so nothing
 *    of one user can show up for another on a shared browser.
 *  - Changes are sent as small patches, debounced; the server merges them, so a
 *    write can never wipe a setting the user did not touch.
 */

const LOCAL_KEY = "wsa.terminal.workspace.v1";
const SAVE_DELAY_MS = 700;

export type WorkspaceSaveState = "idle" | "saving" | "saved" | "error" | "unavailable";

function localCopy(workspace: TerminalWorkspace): TerminalWorkspace {
  return {
    ...workspace,
    metatrader: { ...workspace.metatrader, selection: null, manualAccounts: [], brokerTerminals: {} },
    wsatrade: { ...workspace.wsatrade, accountId: null },
  };
}

function readLocal(): TerminalWorkspace | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    return raw ? sanitizeWorkspace(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(workspace: TerminalWorkspace): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(localCopy(workspace)));
  } catch {
    // private mode / storage blocked: the stored copy still works
  }
}

function combinePatches(
  first: TerminalWorkspacePatch | null,
  second: TerminalWorkspacePatch,
): TerminalWorkspacePatch {
  if (!first) return second;
  const combined: TerminalWorkspacePatch = { ...first, ...second };
  if (first.tradingview || second.tradingview) {
    const panels =
      first.tradingview?.panels || second.tradingview?.panels
        ? { ...first.tradingview?.panels, ...second.tradingview?.panels }
        : undefined;
    const chart =
      first.tradingview?.chart || second.tradingview?.chart
        ? { ...first.tradingview?.chart, ...second.tradingview?.chart }
        : undefined;
    combined.tradingview = {
      ...first.tradingview,
      ...second.tradingview,
      ...(panels ? { panels } : {}),
      ...(chart ? { chart } : {}),
    };
  }
  if (first.metatrader || second.metatrader) {
    // addresses saved for different brokers within one pause must all be sent
    const brokerTerminals =
      first.metatrader?.brokerTerminals || second.metatrader?.brokerTerminals
        ? { ...first.metatrader?.brokerTerminals, ...second.metatrader?.brokerTerminals }
        : undefined;
    combined.metatrader = {
      ...first.metatrader,
      ...second.metatrader,
      ...(brokerTerminals ? { brokerTerminals } : {}),
    };
  }
  if (first.wsatrade || second.wsatrade) {
    // symbol and volume are often changed in separate patches within one pause
    combined.wsatrade = { ...first.wsatrade, ...second.wsatrade };
  }
  return combined;
}

type WorkspaceEnvelope = {
  ok?: boolean;
  data?: { workspace?: unknown; persisted?: boolean; storage?: string };
  error?: { code?: string; message?: string };
};

async function postPatch(
  patch: TerminalWorkspacePatch,
  keepalive: boolean,
): Promise<"saved" | "unavailable" | "error"> {
  try {
    const response = await fetch("/api/terminal/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      keepalive,
      body: JSON.stringify({ workspace: patch }),
    });
    const json = (await response.json().catch(() => ({}))) as WorkspaceEnvelope;
    if (json.ok) return "saved";
    return json.error?.code === "TERMINAL_STORAGE_UNAVAILABLE" ? "unavailable" : "error";
  } catch {
    return "error";
  }
}

export function useTerminalWorkspace() {
  const [workspace, setWorkspace] = useState<TerminalWorkspace>(() => {
    if (typeof window === "undefined") return defaultWorkspace();
    return readLocal() ?? defaultWorkspace();
  });
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<WorkspaceSaveState>("idle");
  const [storageAvailable, setStorageAvailable] = useState(true);

  const workspaceRef = useRef(workspace);
  /** everything changed since this page opened (to replay on top of the stored copy) */
  const sinceMountRef = useRef<TerminalWorkspacePatch | null>(null);
  /** changes not sent yet */
  const pendingRef = useRef<TerminalWorkspacePatch | null>(null);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);

  const send = useCallback(async (keepalive = false): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (pendingRef.current) {
        const patch = pendingRef.current;
        pendingRef.current = null;
        setSaveState("saving");
        const outcome = await postPatch(patch, keepalive);
        if (outcome === "saved") {
          setSaveState("saved");
        } else if (outcome === "unavailable") {
          // the database cannot hold it; the device-local copy keeps the layout
          setStorageAvailable(false);
          setSaveState("unavailable");
        } else {
          // keep it for the next change instead of retrying in a loop
          pendingRef.current = combinePatches(patch, pendingRef.current ?? {});
          setSaveState("error");
          break;
        }
        if (keepalive) break;
        // something changed while the request was running: send it after a short pause
        if (pendingRef.current) await new Promise((resolve) => window.setTimeout(resolve, SAVE_DELAY_MS));
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  const update = useCallback(
    (patch: TerminalWorkspacePatch) => {
      const next = mergeWorkspace(workspaceRef.current, patch);
      workspaceRef.current = next;
      setWorkspace(next);
      writeLocal(next);
      sinceMountRef.current = combinePatches(sinceMountRef.current, patch);
      pendingRef.current = combinePatches(pendingRef.current, patch);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void send(), SAVE_DELAY_MS);
    },
    [send],
  );

  // stored copy
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/terminal/workspace", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const json = (await response.json()) as WorkspaceEnvelope;
        if (!json.ok || !json.data) return;
        setStorageAvailable(json.data.storage !== "unavailable");
        if (!json.data.persisted) return; // nothing stored yet: keep what is on screen
        const stored = sanitizeWorkspace(json.data.workspace);
        // anything changed while this request was running wins over the stored copy
        const next = sinceMountRef.current ? mergeWorkspace(stored, sinceMountRef.current) : stored;
        workspaceRef.current = next;
        setWorkspace(next);
        writeLocal(next);
      } catch {
        // offline / aborted: the device-local copy stays in use
      } finally {
        if (!controller.signal.aborted) setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, []);

  // do not lose the last change when the tab is closed or hidden
  useEffect(() => {
    const flushNow = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void send(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      void send(true);
    };
  }, [send]);

  return { workspace, update, loaded, saveState, storageAvailable };
}
