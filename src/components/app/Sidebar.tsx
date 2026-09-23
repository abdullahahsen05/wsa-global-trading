"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { LogOut, X } from "lucide-react";
import { BrandLogo } from "@/components/app/BrandLogo";
import { navItems } from "@/components/app/navigation";
import type { UserRole } from "@/lib/domain/types";
import { createClient } from "@/lib/supabase/client";

export function Sidebar({
  role,
  mobileNavOpen,
  onMobileNavOpenChange,
}: {
  role: UserRole;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (open: boolean) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const items = navItems.filter((item) => item.role === role);
  const activeHref = items
    .filter(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    queryClient.clear();
    router.replace("/login");
    router.refresh();
  };

  const renderNav = (closeDrawer?: () => void) => (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.href === activeHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={closeDrawer}
            className={`flex min-h-10 items-center gap-3 rounded-[4px] border-l-2 px-3 py-2 text-sm font-medium leading-tight transition-colors ${
              active
                ? "border-l-accent bg-panel-strong/90 text-accent"
                : "border-l-transparent text-foreground/78 hover:border-l-[#4a4730] hover:bg-panel-strong/55 hover:text-foreground"
            }`}
          >
            {Icon ? (
              <Icon className="h-4 w-4 shrink-0" />
            ) : (
              <span aria-hidden="true" className="w-4 shrink-0" />
            )}
            <span className="min-w-0 break-words">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden h-screen max-h-screen min-h-0 w-[var(--sidebar-width)] overflow-hidden border-r border-line bg-panel px-3 py-3 xl:px-4 lg:flex lg:flex-col">
        <div className="mb-5 flex min-h-[8rem] shrink-0 items-center justify-center overflow-hidden px-1 sm:mb-6">
          <BrandLogo
            className="h-[clamp(7.5rem,17vh,9.75rem)] w-auto max-w-[250px]"
            zoomClassName="scale-[1.55]"
            priority
          />
        </div>
        <div className="mb-2 shrink-0 px-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">
            Workspace
          </p>
        </div>
        <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="sidebar-scrollbar min-h-0 flex-1 overscroll-contain overflow-y-auto pr-1 touch-pan-y">
            {renderNav()}
          </div>
          <div className="mt-auto shrink-0 border-t border-line/70 pt-3">
            <button
              type="button"
              onClick={handleLogout}
              className="flex min-h-10 w-full items-center gap-3 rounded-[4px] border border-line px-3 py-2 text-sm text-muted transition-colors hover:border-accent/40 hover:text-accent"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </aside>

      <Dialog.Root open={mobileNavOpen} onOpenChange={onMobileNavOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75 lg:hidden" />
          <Dialog.Content className="fixed left-0 top-0 z-50 flex h-[100dvh] w-[min(88vw,340px)] flex-col overflow-hidden border-r border-line bg-panel px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] focus:outline-none sm:px-5 lg:hidden">
            <Dialog.Title className="sr-only">Navigation menu</Dialog.Title>
            <div className="mb-7 flex items-center justify-between">
              <BrandLogo
                className="h-[clamp(7.5rem,17vh,9.75rem)] w-auto max-w-[250px]"
                zoomClassName="scale-[1.55]"
                priority
              />
              <Dialog.Close asChild>
                <button className="grid h-9 w-9 place-items-center rounded-[4px] border border-line bg-panel-strong text-muted">
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
            <div className="mb-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">
                Workspace
              </p>
            </div>
            <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="sidebar-scrollbar min-h-0 flex-1 overscroll-contain overflow-y-auto pr-1 touch-pan-y">
                {renderNav(() => onMobileNavOpenChange(false))}
              </div>
              <div className="mt-auto shrink-0 border-t border-line/70 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    onMobileNavOpenChange(false);
                    handleLogout();
                  }}
                  className="btn-dark flex h-11 w-full items-center justify-center gap-2 px-4 text-sm text-muted transition hover:border-accent/40 hover:text-accent"
                >
                  <LogOut className="h-4 w-4" />
                  Logout
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
