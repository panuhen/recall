"use client";

import { diffLines } from "diff";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

// Unified (git-style) line diff between two markdown bodies, computed in the
// browser (nothing diff-shaped is persisted). Added lines are green, removed
// red, context muted — readable in both themes.
type Row = { kind: "add" | "del" | "same"; text: string };

export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const part of diffLines(oldText, newText)) {
      const kind: Row["kind"] = part.added ? "add" : part.removed ? "del" : "same";
      // diffLines keeps a trailing newline on each part; drop it so we don't
      // emit a phantom blank row per hunk.
      const lines = part.value.replace(/\n$/, "").split("\n");
      for (const text of lines) out.push({ kind, text });
    }
    return out;
  }, [oldText, newText]);

  const identical = !rows.some((r) => r.kind !== "same");
  if (identical) {
    return (
      <div className="rounded-md border p-4 text-sm text-muted-foreground">
        No differences — this version matches the current note.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border font-mono text-[13px] leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            "flex px-3",
            r.kind === "add" &&
              "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
            r.kind === "del" &&
              "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300",
          )}
        >
          <span className="mr-3 shrink-0 select-none text-muted-foreground">
            {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-words">
            {r.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}
