"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar, SidebarPlaceholder } from "@/components/app/Sidebar";
import { Topbar, TopbarPlaceholder } from "@/components/app/Topbar";
import { ToastProvider } from "@/components/app/Toast";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { SESSION_QUERY_KEY, useSessionUser } from "@/hooks/useSessionUser";
import { useShellHint } from "@/hooks/useShellHint";
import type { UserRole } from "@/lib/domain/types";
import { TradingAccountSelectionProvider } from "@/providers/TradingAccountSelectionProvider";
import { isAdmin } from "@/lib/auth/rbac";
import { clearShellHint, rememberShellHint } from "@/lib/shell/shellHint";

const AUTH_ROUTES = ["/login", "/register", "/forgot-password", "/reset-password"];

const MAIN_CLASS =
  "relative min-w-0 flex-1 overflow-x-auto px-3 py-4 sm:px-4 sm:py-5 md:px-5 lg:px-7 lg:py-6";

/**
 * The frame around every signed-in page: navigation, top bar and the page itself.
 *
 * The tree is the SAME before and after the session answer arrives. It used to be a bare `<main>` while the session
 * loaded and a different tree (providers, sidebar, top bar) afterwards, so React threw the page away and built it a
 * second time - every request the page had started was repeated after the wait. Now the page is mounted once, at once:
 *  - the page's own requests start together with the session check, not after it;
 *  - the sidebar and top bar are drawn from the remembered session (`lib/shell/shellHint.ts`) right away, or as
 *    placeholders on the very first visit, and fill in when the server has answered;
 *  - nothing here trusts the remembered session: the server's answer replaces it, and a "nobody is signed in" answer
 *    sends the person to the login page.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isAuthRoute = AUTH_ROUTES.includes(pathname);
  const isShellFreeRoute =
    isAuthRoute ||
    pathname.startsWith("/certificates/verify/") ||
    pathname === "/demo" ||
    pathname.startsWith("/demo/");
  const sessionQuery = useSessionUser({ enabled: !isShellFreeRoute });
  const hint = useShellHint();
  const verified = sessionQuery.data ?? null;
  const shownRole = verified?.role ?? hint?.role ?? null;
  const role: UserRole | null = shownRole ? (isAdmin(shownRole) ? "ADMIN" : shownRole) : null;
  const signedOut = !isShellFreeRoute && sessionQuery.isSuccess && verified === null;
  // (the live connection is for a verified session only, and it waits for the first screen: see useRealtimeUpdates)
  useRealtimeUpdates(!isShellFreeRoute && verified !== null);

  // Whoever signs in next must not be drawn as the previous person: the sign-in pages forget the session.
  useEffect(() => {
    if (!isAuthRoute) return;
    clearShellHint();
    queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
  }, [isAuthRoute, queryClient]);

  useEffect(() => {
    if (verified) rememberShellHint({ id: verified.id, role: verified.role });
  }, [verified]);

  useEffect(() => {
    if (!signedOut) return;
    clearShellHint();
    const nextPath = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    router.replace(`/login${nextPath}`);
  }, [signedOut, pathname, router]);

  if (isShellFreeRoute) {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  if (signedOut) {
    return (
      <main className="relative min-h-screen min-w-0 overflow-x-auto px-3 py-4 sm:px-4 sm:py-5 md:px-5 lg:px-7 lg:py-6">
        <div className="mx-auto flex min-h-[60vh] max-w-xl items-center justify-center">
          <div className="inner-surface w-full px-6 py-10 text-center">
            <p className="text-sm text-muted">Redirecting to login…</p>
          </div>
        </div>
      </main>
    );
  }

  if (sessionQuery.isError && !verified) {
    // The server could not say who is signed in (busy, rate limited, offline) - that is not a log-out.
    return (
      <main className="relative min-h-screen min-w-0 overflow-x-auto px-3 py-4 sm:px-4 sm:py-5 md:px-5 lg:px-7 lg:py-6">
        <div className="mx-auto flex min-h-[60vh] max-w-xl items-center justify-center">
          <div className="inner-surface w-full px-6 py-10 text-center">
            <p className="text-sm text-muted">We could not verify your session right now.</p>
            <button
              type="button"
              onClick={() => void sessionQuery.refetch()}
              className="btn-dark mt-4 px-4 text-xs"
            >
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <ToastProvider>
      <TradingAccountSelectionProvider>
        <div className="min-h-screen min-w-0 bg-background">
          <div className="flex min-h-screen min-w-0">
            {role ? (
              <Sidebar role={role} mobileNavOpen={mobileNavOpen} onMobileNavOpenChange={setMobileNavOpen} />
            ) : (
              <SidebarPlaceholder />
            )}
            <div className="app-shell-main flex flex-1 flex-col">
              {role ? <Topbar role={role} onOpenMobileNav={() => setMobileNavOpen(true)} /> : <TopbarPlaceholder />}
              <main className={MAIN_CLASS}>{children}</main>
            </div>
          </div>
        </div>
      </TradingAccountSelectionProvider>
    </ToastProvider>
  );
}
