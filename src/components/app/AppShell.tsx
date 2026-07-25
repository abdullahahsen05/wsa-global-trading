"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/app/Sidebar";
import { Topbar } from "@/components/app/Topbar";
import { ToastProvider } from "@/components/app/Toast";
import type { UserRole } from "@/lib/domain/types";
import { TradingAccountSelectionProvider } from "@/providers/TradingAccountSelectionProvider";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isShellFreeRoute =
    ["/login", "/register", "/forgot-password", "/reset-password"].includes(pathname) ||
    pathname.startsWith("/certificates/verify/") ||
    pathname === "/demo" ||
    pathname.startsWith("/demo/");
  const role: UserRole = pathname.startsWith("/admin")
    ? "ADMIN"
    : pathname.startsWith("/partner")
      ? "PARTNER"
      : "TRADER";

  if (isShellFreeRoute) {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  return (
    <ToastProvider>
      <TradingAccountSelectionProvider>
        <div className="min-h-screen min-w-0 overflow-x-hidden bg-background">
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
        </div>
      </TradingAccountSelectionProvider>
    </ToastProvider>
  );
}
