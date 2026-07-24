"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Bell, CheckCircle2, Info, X } from "lucide-react";

export type ToastTone = "accent" | "lime" | "danger" | "muted";

type ToastItem = {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
};

type ToastContextValue = {
  pushToast: (toast: Omit<ToastItem, "id">) => void;
  dismissToast: (id: string) => void;
  toastCount: number;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const toneConfig: Record<
  ToastTone,
  { className: string; icon: typeof Bell }
> = {
  accent: { className: "border-accent/30 bg-accent/10 text-accent", icon: Bell },
  lime: { className: "border-accent-2/30 bg-accent-2/10 text-accent-2", icon: CheckCircle2 },
  danger: { className: "border-danger/30 bg-danger/10 text-danger", icon: AlertTriangle },
  muted: { className: "border-line bg-panel text-foreground", icon: Info },
};

function toastId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `toast-${Math.random().toString(36).slice(2)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const dismissToast = useMemo(
    () => (id: string) => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      const timer = timers.current.get(id);
      if (timer) {
        window.clearTimeout(timer);
        timers.current.delete(id);
      }
    },
    [],
  );

  const pushToast = useMemo(
    () => (toast: Omit<ToastItem, "id">) => {
      const id = toastId();
      setToasts((current) => [...current, { id, ...toast }].slice(-3));
      const timer = window.setTimeout(() => {
        dismissToast(id);
      }, 4200);
      timers.current.set(id, timer);
    },
    [dismissToast],
  );

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  const value = useMemo(
    () => ({
      pushToast,
      dismissToast,
      toastCount: toasts.length,
    }),
    [pushToast, dismissToast, toasts.length],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[92vw] max-w-sm flex-col gap-3 sm:bottom-6 sm:right-6">
        <AnimatePresence>
          {toasts.map((toast) => {
            const tone = toneConfig[toast.tone ?? "muted"];
            const Icon = tone.icon;

            return (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className={`pointer-events-auto rounded-[4px] border p-4 ${tone.className}`}
              >
                <div className="flex items-start gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[4px] border border-current/15 bg-background/25">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{toast.title}</p>
                    {toast.description ? (
                      <p className="mt-1 text-sm leading-6 text-foreground/80">{toast.description}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissToast(toast.id)}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-[4px] border border-current/15 bg-background/30 text-current/70 transition hover:bg-background/50"
                    aria-label="Dismiss toast"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return value;
}
