"use client";

import { useSyncExternalStore } from "react";
import { readShellHint, subscribeShellHint, type ShellHint } from "@/lib/shell/shellHint";

const noHint = (): ShellHint | null => null;

/**
 * The remembered session of this browser (`null` on the server, while hydrating and when there is none).
 * Safe for server rendering: the first render always sees `null`, the real value arrives right after hydration.
 */
export function useShellHint(): ShellHint | null {
  return useSyncExternalStore(subscribeShellHint, readShellHint, noHint);
}
