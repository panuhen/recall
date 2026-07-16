"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

// A flat right-click menu for the nav tree. Mirrors editor-context-menu.tsx
// (fixed position, viewport clamp, outside-click/Escape close) without submenus.
export type MenuItem =
  | { divider: true }
  | { label: string; icon: ReactNode; onSelect: () => void; danger?: boolean };

const ROW =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent";

export function SidebarContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport once we know the menu's size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-44 rounded-md border bg-card p-1 shadow-md"
    >
      {items.map((item, i) =>
        "divider" in item ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={cn(ROW, item.danger && "text-destructive")}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center",
                !item.danger && "text-muted-foreground",
              )}
            >
              {item.icon}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
