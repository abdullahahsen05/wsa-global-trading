"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/app/Sidebar";
import { Topbar } from "@/components/app/Topbar";
import { ToastProvider } from "@/components/app/Toast";
import type { UserRole } from "@/lib/domain/types";

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
      <div className="min-h-screen bg-background">
        <div className="flex min-h-screen">
          <Sidebar
            role={role}
            mobileNavOpen={mobileNavOpen}
            onMobileNavOpenChange={setMobileNavOpen}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar role={role} onOpenMobileNav={() => setMobileNavOpen(true)} />
            <main className="relative flex-1 px-4 py-5 md:px-5 lg:px-7 lg:py-6">{children}</main>
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
