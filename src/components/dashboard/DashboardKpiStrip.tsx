"use client";

import { motion } from "framer-motion";
import { itemMotion } from "@/components/app/WorkspaceUI";

type KpiTone = "accent" | "lime" | "danger" | "muted";

export type DashboardKpiItem = {
  label: string;
  value: string;
  helper: string;
  tone: KpiTone;
  status: string;
  statusTone: KpiTone;
  sparkline: number[];
};

export type SentimentItem = {
  label: string;
  value: string;
  helper: string;
  tone: KpiTone;
};

const toneColor: Record<KpiTone, string> = {
  accent: "#ffcf00",
  lime: "#d7ff32",
  danger: "#ff5d4d",
  muted: "#8f8e83",
};

function CompactStatus({ children, tone }: { children: string; tone: KpiTone }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: toneColor[tone] }} />
      <span
        className={
          tone === "lime"
            ? "text-accent-2"
            : tone === "danger"
              ? "text-danger"
              : tone === "muted"
                ? "text-muted"
                : "text-accent"
        }
      >
        {children}
      </span>
    </span>
  );
}

function MiniSparkline({ points, tone }: { points: number[]; tone: KpiTone }) {
  if (points.length < 2) {
    return <div className="h-[52px] w-[120px] border-b border-line" aria-hidden="true" />;
  }

  const width = 120;
  const height = 44;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const linePoints = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const y = height - ((point - min) / range) * (height - 8) - 4;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[52px] w-[120px]" aria-hidden="true">
      <polyline
        points={linePoints}
        fill="none"
        stroke={toneColor[tone]}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points={linePoints}
        fill="none"
        stroke={toneColor[tone]}
        strokeOpacity="0.18"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KpiCard({ item }: { item: DashboardKpiItem }) {
  return (
    <article className="min-w-0 border-b border-line px-5 py-4 last:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted">{item.label}</p>
          <p className="mt-3 text-[30px] font-semibold leading-none text-foreground">{item.value}</p>
          <p className="mt-2 max-w-[20rem] text-sm leading-6 text-muted">{item.helper}</p>
        </div>
        <div className="hidden shrink-0 pt-0.5 sm:block">
          <MiniSparkline points={item.sparkline} tone={item.tone} />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <CompactStatus tone={item.statusTone}>{item.status}</CompactStatus>
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">Live</span>
      </div>
    </article>
  );
}

export function DashboardKpiStrip({ items }: { items: DashboardKpiItem[] }) {
  return (
    <div className="grid overflow-hidden rounded-[4px] border border-line bg-panel xl:grid-cols-3">
      {items.map((item) => (
        <KpiCard key={item.label} item={item} />
      ))}
    </div>
  );
}

export function MarketSentimentStrip({ items }: { items: SentimentItem[] }) {
  return (
    <motion.section
      variants={itemMotion}
      className="section-surface p-3"
    >
      <div className="grid gap-0 xl:grid-cols-4">
        {items.map((item, index) => (
          <div
            key={item.label}
            className={`flex items-center justify-between gap-4 bg-background/55 px-4 py-4 xl:border-r xl:border-[rgba(255,255,255,0.08)] ${
              index === items.length - 1 ? "xl:border-r-0" : ""
            }`}
          >
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">{item.label}</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{item.value}</p>
              <p className="mt-1 text-xs text-muted">{item.helper}</p>
            </div>
        <span
          className={`status-pill shrink-0 ${
            item.tone === "lime"
              ? "status-pill-green"
              : item.tone === "danger"
                ? "border-danger/20 bg-danger/10 text-danger"
                : ""
          }`}
        >
          {item.value}
        </span>
          </div>
        ))}
      </div>
    </motion.section>
  );
}
