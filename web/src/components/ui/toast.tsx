"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

type Variant = "default" | "error";
type Toast = { id: number; message: string; variant: Variant };
type ToastCtx = { toast: (message: string, variant?: Variant) => void };

const Ctx = createContext<ToastCtx | null>(null);

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// Minimal transient notifications (bottom-center, auto-dismiss, click to
// dismiss). Hand-rolled to match the app's other UI primitives — no external
// toast library.
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  // Only portal after mount so server render and first client render agree
  // (the portal has no server equivalent → would otherwise mismatch).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: Variant = "default") => {
      const id = ++nextId.current;
      setToasts((list) => [...list, { id, message, variant }]);
      setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2"
          >
            {toasts.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => dismiss(t.id)}
                title="Dismiss"
                className={cn(
                  "pointer-events-auto max-w-sm rounded-md border bg-card px-3 py-2 text-left text-sm shadow-md",
                  t.variant === "error" ? "text-destructive" : "text-foreground",
                )}
              >
                {t.message}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}
