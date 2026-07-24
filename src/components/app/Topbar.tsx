"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Bell, CheckCircle2, Info, Menu, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { navItems } from "@/components/app/navigation";
import type { UserRole, TraderAccountSummary, NotificationDto } from "@/lib/domain/types";

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(isoString).toLocaleDateString();
}

function notificationIcon(type: string | null) {
  if (type === "SYNC_SUCCESS") return CheckCircle2;
  if (type === "SYNC_FAILURE") return AlertTriangle;
  if (type === "RISK_EVENT") return AlertTriangle;
  return Info;
}

function notificationTone(type: string | null): "danger" | "lime" | "accent" {
  if (type === "RISK_EVENT") return "danger";
  if (type === "SYNC_SUCCESS") return "lime";
  return "accent";
}

export function Topbar({
  role,
  onOpenMobileNav,
}: {
  role: UserRole;
  onOpenMobileNav: () => void;
}) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const { data: tradingAccounts = [] } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts", role],
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts");
      const json = await res.json();
      if (!json.ok) return [];
      return json.data;
    },
    enabled: role === "TRADER",
  });

  const { data: notifData } = useQuery<{ notifications: NotificationDto[]; unreadCount: number }>({
    queryKey: ["notifications"],
    queryFn: async () => {
      const res = await fetch("/api/notifications");
      const json = await res.json();
      if (!json.ok) return { notifications: [], unreadCount: 0 };
      return json.data;
    },
    refetchInterval: 30_000,
  });

  const notifications = notifData?.notifications ?? [];
  const unreadCount = notifData?.unreadCount ?? 0;

  async function handleMarkRead(id: string) {
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "PATCH" });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } catch {
      // network failure — silently ignore; next refetch will correct state
    }
  }

  async function handleMarkAllRead() {
    try {
      await fetch("/api/notifications/read-all", { method: "PATCH" });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } catch {
      // network failure — silently ignore; next refetch will correct state
    }
  }

  const mobileItems = navItems.filter((item) => item.role === role).slice(0, 6);
  const activeItem =
    navItems
      .filter((item) => item.role === role)
      .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
      .sort((left, right) => right.href.length - left.href.length)[0] ?? mobileItems[0];
  const subtitle =
    activeItem?.href === "/dashboard"
      ? "Equity, risk, and performance at a glance."
      : activeItem?.href === "/accounts"
        ? "Broker-linked accounts and connection health."
        : activeItem?.href === "/analytics"
          ? "Profitability, drawdown, and performance quality."
          : activeItem?.href === "/risk"
            ? "Rules, limits, and review queue monitoring."
            : activeItem?.href === "/reports"
              ? "Exports, summaries, and schedules."
              : activeItem?.href === "/settings"
                ? "Profile, broker, and security preferences."
                : role === "ADMIN"
                  ? "Platform supervision, CRM, and audit workflows."
                  : "Manage trading operations and account performance.";

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setNotificationsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setNotificationsOpen(false);
    }
    if (notificationsOpen) {
      window.addEventListener("pointerdown", handlePointerDown);
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [notificationsOpen]);

  return (
    <header className="sticky top-0 z-20 min-h-16 border-b border-line bg-panel px-4 py-3 lg:px-7">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onOpenMobileNav}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[4px] border border-line bg-panel-strong text-muted lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="hidden md:block">
            <p className="text-lg font-bold text-foreground">{activeItem?.label ?? "Workspace"}</p>
            <p className="mt-0.5 text-xs font-medium text-muted">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative" ref={popoverRef}>
            <button
              type="button"
              onClick={() => setNotificationsOpen((current) => !current)}
              className="relative grid h-9 w-9 place-items-center rounded-full border border-[rgba(255,255,255,0.08)] bg-panel-strong text-muted transition hover:border-accent/40 hover:text-accent"
              aria-label="Show notifications"
              aria-expanded={notificationsOpen}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-[4px] bg-accent px-1 text-[10px] font-bold text-background">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>

            <div
              className={`absolute right-0 top-full z-30 mt-3 w-[min(92vw,340px)] rounded-[6px] border border-line bg-panel shadow-[0_12px_30px_rgba(0,0,0,0.28)] transition duration-150 ${
                notificationsOpen ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0"
              }`}
            >
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">
                    Notifications
                  </p>
                  <p className="mt-1 text-sm font-semibold text-foreground">Recent updates</p>
                </div>
                <div className="flex items-center gap-2">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={handleMarkAllRead}
                      className="text-xs font-medium text-muted hover:text-accent"
                    >
                      Mark all read
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setNotificationsOpen(false)}
                    className="grid h-8 w-8 place-items-center rounded-[4px] border border-line bg-background text-muted transition-colors hover:text-foreground"
                    aria-label="Close notifications"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="invisible-scrollbar max-h-80 overflow-y-auto">
                {notifications.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">No notifications yet.</p>
                ) : (
                  notifications.map((notification) => {
                    const Icon = notificationIcon(notification.type);
                    const tone = notificationTone(notification.type);
                    const toneClass =
                      tone === "danger"
                        ? "text-danger bg-danger/10 border-danger/20"
                        : tone === "lime"
                          ? "text-accent-2 bg-accent-2/10 border-accent-2/20"
                          : "text-accent bg-accent/10 border-accent/20";
                    const isUnread = !notification.readAt;

                    return (
                      <button
                        key={notification.id}
                        type="button"
                        onClick={() => handleMarkRead(notification.id)}
                        className={`flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors hover:bg-panel-strong ${
                          isUnread ? "border-l-2 border-l-accent bg-background/70" : "bg-background/40"
                        }`}
                      >
                        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-[4px] border ${toneClass}`}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className={`truncate text-sm font-semibold ${isUnread ? "text-foreground" : "text-muted"}`}>
                              {notification.title}
                            </p>
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                              {relativeTime(notification.createdAt)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-5 text-muted">{notification.message}</p>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
          <span className="hidden rounded-[4px] border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent sm:inline-flex items-center">
            {role === "ADMIN" ? "Admin" : role === "PARTNER" ? "Partner" : "Trader"}
          </span>
          {role === "TRADER" ? (
            <select
              aria-label="Select one of your trading accounts"
              className="h-10 max-w-[260px] rounded-[5px] border border-line bg-panel-strong px-3 text-sm font-semibold text-foreground outline-none focus:border-accent"
              disabled={tradingAccounts.length === 0}
            >
              {tradingAccounts.length === 0 ? (
                <option>No connected accounts</option>
              ) : (
                tradingAccounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.accountName}
                  </option>
                ))
              )}
            </select>
          ) : null}
        </div>
      </div>
      <nav className="invisible-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1 lg:hidden">
        {mobileItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="btn-dark h-9 shrink-0 px-4 text-xs text-muted"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
