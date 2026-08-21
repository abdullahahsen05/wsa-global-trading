"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Sidebar } from "@/components/app/Sidebar";
import { Topbar } from "@/components/app/Topbar";
import { ToastProvider } from "@/components/app/Toast";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import type { UserRole } from "@/lib/domain/types";
import { TradingAccountSelectionProvider } from "@/providers/TradingAccountSelectionProvider";
import { isAdmin } from "@/lib/auth/rbac";

interface SessionPayload {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED" | "PENDING";
}

async function fetchSession(): Promise<SessionPayload | null> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) return null;
  return payload.data as SessionPayload;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isShellFreeRoute =
    ["/login", "/register", "/forgot-password", "/reset-password"].includes(pathname) ||
    pathname.startsWith("/certificates/verify/") ||
    pathname === "/demo" ||
    pathname.startsWith("/demo/");
  const sessionQuery = useQuery({
    queryKey: ["auth-session-shell"],
    queryFn: fetchSession,
    enabled: !isShellFreeRoute,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const role: UserRole | null = sessionQuery.data
    ? isAdmin(sessionQuery.data.role)
      ? "ADMIN"
      : sessionQuery.data.role
    : null;
  useRealtimeUpdates(!isShellFreeRoute);

  if (isShellFreeRoute) {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  return (
    <ToastProvider>
      <TradingAccountSelectionProvider>
        <div className="min-h-screen min-w-0 overflow-x-hidden bg-background">
          {role ? (
            <div className="flex min-h-screen min-w-0">
              <Sidebar
                role={role}
                mobileNavOpen={mobileNavOpen}
                onMobileNavOpenChange={setMobileNavOpen}
              />
              <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
                <Topbar role={role} onOpenMobileNav={() => setMobileNavOpen(true)} />
                <main className="relative min-w-0 flex-1 overflow-x-hidden px-3 py-4 sm:px-4 sm:py-5 md:px-5 lg:px-7 lg:py-6">{children}</main>
              </div>
            </div>
          ) : (
            <main className="relative min-h-screen min-w-0 overflow-x-hidden px-3 py-4 sm:px-4 sm:py-5 md:px-5 lg:px-7 lg:py-6">
              {children}
            </main>
          )}
        </div>
      </TradingAccountSelectionProvider>
    </ToastProvider>
  );
}
