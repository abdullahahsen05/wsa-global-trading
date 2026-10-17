"use client";

import dynamic from "next/dynamic";

/**
 * The terminal workspace (TradingView, MetaTrader web terminal, WSA Trade), loaded
 * in the browser only. One loader for the trader page (`/terminal`) and the admin
 * page (`/admin/terminal`): both pages show exactly the same workspace.
 */

function TerminalWorkspaceSkeleton() {
  return (
    <section className="section-surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <div className="h-6 w-48 animate-pulse rounded-full bg-panel-strong" />
          <div className="mt-3 h-4 w-40 animate-pulse rounded-full bg-panel-strong" />
        </div>
        <div className="h-9 w-52 animate-pulse rounded-[4px] bg-panel-strong" />
      </div>
      <div className="px-5 py-5">
        <div className="inner-surface h-[760px] animate-pulse" />
      </div>
    </section>
  );
}

export const TerminalWorkspaceLazy = dynamic(
  () => import("@/components/trading/TerminalWorkspace").then((mod) => mod.TerminalWorkspace),
  {
    ssr: false,
    loading: () => <TerminalWorkspaceSkeleton />,
  },
);
