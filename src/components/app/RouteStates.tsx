"use client";

import { motion } from "framer-motion";
import { AlertTriangle, RefreshCcw, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { BrandLogo } from "@/components/app/BrandLogo";
import { GhostButton, PrimaryButton } from "@/components/app/WorkspaceUI";

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[4px] bg-panel-strong/80 ${className}`} />;
}

export function WorkspaceLoadingState({
  eyebrow = "Loading",
  title = "Preparing workspace",
  description = "Loading the latest account, CRM, risk, and analytics data.",
}: {
  eyebrow?: string;
  title?: string;
  description?: string;
}) {
  return (
    <section className="w-full">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-accent">{eyebrow}</p>
          <SkeletonBlock className="mt-3 h-8 w-72 max-w-full" />
          <SkeletonBlock className="mt-3 h-4 w-[36rem] max-w-full" />
        </div>
        <SkeletonBlock className="h-10 w-36 rounded-[4px]" />
      </div>
      <div className="grid gap-px overflow-hidden rounded-[4px] border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonBlock key={index} className="h-24 rounded-none bg-panel" />
        ))}
      </div>
      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-[0.64fr_0.36fr]">
        <SkeletonBlock className="h-72 rounded-[4px]" />
        <SkeletonBlock className="h-72 rounded-[4px]" />
      </div>
      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-2">
        <SkeletonBlock className="h-52 rounded-[4px]" />
        <SkeletonBlock className="h-52 rounded-[4px]" />
      </div>
      <p className="mt-5 text-sm text-muted">{title}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
    </section>
  );
}

export function AuthLoadingState() {
  return (
    <main className="grid min-h-screen bg-background text-foreground md:grid-cols-2">
      <aside className="relative hidden min-h-screen overflow-hidden border-r border-line bg-[#060808] p-10 md:flex md:flex-col lg:p-14">
        <BrandLogo className="h-14 w-auto max-w-[180px]" priority />
        <div className="my-auto max-w-md">
          <SkeletonBlock className="h-8 w-72" />
          <SkeletonBlock className="mt-4 h-4 w-full" />
          <SkeletonBlock className="mt-2 h-4 w-4/5" />
        </div>
      </aside>
      <section className="flex min-h-screen items-center justify-center bg-[#060808] px-5 py-8 sm:px-8 lg:px-14">
        <div className="w-full max-w-xl">
          <BrandLogo className="mb-10 h-14 w-auto max-w-[180px] md:hidden" priority />
          <SkeletonBlock className="h-3 w-28" />
          <SkeletonBlock className="mt-6 h-9 w-64 max-w-full" />
          <SkeletonBlock className="mt-4 h-4 w-full" />
          <div className="mt-8 grid gap-5">
            <SkeletonBlock className="h-14 w-full rounded-[6px]" />
            <SkeletonBlock className="h-14 w-full rounded-[6px]" />
            <SkeletonBlock className="h-14 w-full rounded-[6px]" />
          </div>
        </div>
      </section>
    </main>
  );
}

export function WorkspaceErrorState({
  title = "Workspace unavailable",
  description = "We hit an unexpected rendering issue while loading this section.",
  retryLabel = "Try again",
  unstable_retry,
}: {
  title?: string;
  description?: string;
  retryLabel?: string;
  unstable_retry: () => void;
}) {
  return (
    <section className="mx-auto grid min-h-[60vh] max-w-3xl place-items-center px-4 py-10">
      <motion.div className="w-full rounded-[6px] border border-line bg-panel p-6">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[4px] bg-danger/10 text-danger">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-danger">Error</p>
            <h2 className="mt-2 text-2xl font-semibold text-foreground">{title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{description}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <PrimaryButton type="button" onClick={unstable_retry}>
                <RefreshCcw className="mr-2 inline-block h-4 w-4" />
                {retryLabel}
              </PrimaryButton>
              <GhostButton type="button" onClick={unstable_retry}>
                Refresh segment
              </GhostButton>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

export function AuthErrorState({
  unstable_retry,
}: {
  unstable_retry: () => void;
}) {
  return (
    <main className="grid min-h-screen bg-background text-foreground md:grid-cols-2">
      <aside className="relative hidden min-h-screen overflow-hidden border-r border-line bg-[#060808] p-10 md:flex md:flex-col lg:p-14">
        <BrandLogo className="h-14 w-auto max-w-[180px]" priority />
        <div className="my-auto max-w-md">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Secure access</p>
          <h2 className="mt-4 text-3xl font-semibold leading-tight">Operate with clarity. Scale with control.</h2>
        </div>
      </aside>
      <section className="flex min-h-screen items-center justify-center bg-[#060808] px-5 py-8 sm:px-8 lg:px-14">
        <div className="w-full max-w-xl">
          <BrandLogo className="mb-10 h-14 w-auto max-w-[180px] md:hidden" priority />
          <div className="grid h-11 w-11 place-items-center rounded-[4px] border border-danger/25 bg-danger/10 text-danger">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <h1 className="mt-6 text-3xl font-semibold text-foreground">Authentication screen failed</h1>
          <p className="mt-3 max-w-lg text-sm leading-6 text-muted">
            We could not render this auth flow. Try again and the page will re-fetch.
          </p>
          <div className="mt-7 flex flex-wrap gap-3 border-t border-line pt-5">
            <GhostButton type="button" onClick={unstable_retry}>Retry</GhostButton>
            <PrimaryButton type="button" onClick={unstable_retry}>
              <RefreshCcw className="mr-2 inline-block h-4 w-4" />
              Reload
            </PrimaryButton>
          </div>
        </div>
      </section>
    </main>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = Sparkles,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: typeof Sparkles;
}) {
  const Icon = icon;

  return (
    <div className="py-4 text-left">
      <div className="grid h-9 w-9 place-items-center rounded-[4px] bg-accent/10 text-accent">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{description}</p>
      {action ? <div className="mt-5 flex">{action}</div> : null}
    </div>
  );
}
