"use client";

import { FileText, Link2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import type { LinkTarget } from "./link-picker";

// Command-palette-style picker for inserting a `[[wikilink]]`, matching the
// Search / Trash dialogs. Filters this workspace's notes client-side (the index
// is already in memory), pre-fills the query with any selected text, and calls
// onPick(title) — the editor writes `[[title]]`. Dismissing calls onClose and
// inserts nothing.
export function LinkPickerDialog({
  open,
  initialQuery,
  targets,
  onPick,
  onClose,
}: {
  open: boolean;
  initialQuery: string;
  targets: LinkTarget[];
  onPick: (title: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Seed the query with the selection and grab focus (select-all so the first
  // keystroke replaces it) each time the picker opens.
  useEffect(() => {
    if (!open) return;
    setQ(initialQuery);
    setActive(0);
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const matches = useMemo(() => {
    const key = q.trim().toLowerCase();
    const list = key
      ? targets.filter((t) => t.title.toLowerCase().includes(key))
      : targets;
    return list.slice(0, 50);
  }, [q, targets]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open || typeof document === "undefined") return null;

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[active];
      if (m) onPick(m.title);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Link to note"
        className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Link2 size={18} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Link to note…"
            aria-label="Link to note"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto p-1">
          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {targets.length === 0
                ? "No other notes in this workspace yet"
                : "No notes match"}
            </li>
          ) : (
            matches.map((m, i) => (
              <li key={m.id}>
                <button
                  type="button"
                  onMouseMove={() => setActive(i)}
                  onClick={() => onPick(m.title)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left",
                    i === active ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <FileText size={14} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {m.title || "Untitled"}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
