"use client";

import { Check, MoreVertical } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export type NoteMenuItem =
  | { divider: true }
  | { node: ReactNode } // custom row (e.g. an inline segmented control)
  | {
      label: string;
      onClick: () => void;
      icon?: ReactNode; // leading icon
      active?: boolean; // shows a checkmark when true (toggle items)
    };

// A lightweight dropdown of actions (the note ribbon kebab, the sidebar sort
// menu, …). `trigger` overrides the default kebab glyph; `align` picks the
// horizontal edge the panel aligns to; `side` opens it below or above the
// trigger (above suits a menu anchored at the bottom of the sidebar).
export function NoteMenu({
  items,
  trigger,
  label = "More options",
  align = "right",
  side = "bottom",
}: {
  items: NoteMenuItem[];
  trigger?: ReactNode;
  label?: string;
  align?: "left" | "right";
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {trigger ?? <MoreVertical size={20} />}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-20 min-w-44 rounded-md border bg-background p-1 shadow-md",
            side === "top" ? "bottom-full mb-1" : "top-full mt-1",
            align === "left" ? "left-0" : "right-0",
          )}
        >
          {items.map((it, i) =>
            "divider" in it ? (
              <div key={`div-${i}`} className="my-1 h-px bg-border" />
            ) : "node" in it ? (
              // Custom row: renders its own controls and manages its own clicks
              // (no auto-close), so an inline toggle can update live in place.
              <div key={`node-${i}`} role="none">
                {it.node}
              </div>
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  it.onClick();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                {it.icon && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                    {it.icon}
                  </span>
                )}
                <span className="flex-1 truncate">{it.label}</span>
                {it.active && (
                  <Check size={14} className="shrink-0 text-muted-foreground" />
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
