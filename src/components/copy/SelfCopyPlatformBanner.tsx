"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { platformNotices } from "@/lib/copy/selfCopyView";
import type { SelfCopyPlatform } from "@/components/copy/selfCopyClient";

/**
 * The copy system as a whole, above the routes: "live copying is switched off" or "the AWS system does not
 * answer" explain a route that does nothing better than anything inside the route can.
 */
export function SelfCopyPlatformBanner({ platform }: { platform: SelfCopyPlatform | null | undefined }) {
  const notices = platformNotices(platform);
  if (notices.length === 0) return null;
  const trouble = notices.some((notice) => notice.tone === "danger");
  const warning = !trouble && notices.some((notice) => notice.tone === "warn");
  const tone = trouble
    ? "border-danger/25 bg-danger/10 text-danger"
    : warning
      ? "border-accent/25 bg-accent/10 text-accent"
      : "border-lime/25 bg-lime/10 text-lime";
  const Icon = trouble || warning ? AlertTriangle : CheckCircle2;
  return (
    <div role={trouble ? "alert" : "status"} className={`flex items-start gap-3 rounded-[4px] border px-4 py-3 text-sm ${tone}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <ul className="min-w-0 space-y-1">
        {notices.map((notice) => (
          <li key={notice.id}>{notice.text}</li>
        ))}
      </ul>
    </div>
  );
}
