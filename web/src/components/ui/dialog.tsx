"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

// A lightweight modal primitive: a portalled overlay + centered panel that
// closes on Escape or overlay click and locks body scroll while open. Mirrors
// the outside-click/Escape handling of note-menu.tsx / sidebar-context-menu.tsx
// but as a focus-trapping dialog. Compose confirm/form dialogs on top of it.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  showClose = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  showClose?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // Move focus into the dialog unless content already claimed it (e.g. an
  // autoFocus button). Effects run child-first, so any autoFocus has applied.
  useEffect(() => {
    const panel = panelRef.current;
    if (open && panel && !panel.contains(document.activeElement)) panel.focus();
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full max-w-md rounded-lg border bg-card p-5 shadow-lg outline-none",
          className,
        )}
      >
        {showClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X size={16} />
          </button>
        )}
        {title && <h2 className="pr-8 text-base font-semibold">{title}</h2>}
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
