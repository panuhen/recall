"use client";

import { BookmarkPlus, History, X } from "lucide-react";

import type { Revision } from "@/lib/api";
import { absoluteTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const TRIGGER_LABEL: Record<Revision["trigger"], string> = {
  auto: "Autosaved",
  manual: "Saved version",
  session_start: "Session start",
  status_change: "Status change",
};

// "Alex via Claude · " / "via Claude · " / "Alex · " / "" — `client` is the
// MCP client (AI assistant) that wrote the revision; absent for web edits.
function attribution(rev: Revision): string {
  const who = [rev.author?.name, rev.client && `via ${rev.client}`]
    .filter(Boolean)
    .join(" ");
  return who ? `${who} · ` : "";
}

// Right-docked revision list (mirrors GraphDock). Sticks below the note's
// sticky header while the diff scrolls in the main column. Selecting a
// revision drives the diff shown in the main area.
export function NoteHistoryPanel({
  revisions,
  selectedId,
  loading,
  onSelect,
  onSaveVersion,
  onClose,
  hiddenOnMobile = false,
}: {
  revisions: Revision[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onSaveVersion: () => void;
  onClose: () => void;
  // Mobile drill-down: hide the list overlay once a version's diff is showing.
  hiddenOnMobile?: boolean;
}) {
  return (
    <aside
      className={cn(
        "flex flex-col border-l border-tab-border bg-background md:sticky md:top-11 md:max-h-[calc(100vh-2.75rem)] md:w-72 md:shrink-0 md:self-start max-md:fixed max-md:inset-0 max-md:z-40",
        hiddenOnMobile && "max-md:hidden",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <History size={16} className="shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">Version history</span>
        {!loading && (
          <span className="text-xs text-muted-foreground">{revisions.length}</span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history"
          title="Close"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="p-2 text-sm text-muted-foreground">loading…</div>
        ) : revisions.length === 0 ? (
          <div className="p-2 text-sm text-muted-foreground">
            No earlier versions yet. Snapshots are taken as you edit, or save one
            manually below.
          </div>
        ) : (
          <ul className="space-y-0.5">
            {revisions.map((rev) => (
              <li key={rev.id}>
                <button
                  type="button"
                  onClick={() => onSelect(rev.id)}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    rev.id === selectedId && "bg-accent",
                  )}
                >
                  <div className="truncate font-medium">
                    {rev.label ?? TRIGGER_LABEL[rev.trigger]}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={absoluteTime(rev.created_at)}
                  >
                    {attribution(rev)}
                    {relativeTime(rev.created_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t p-2">
        <button
          type="button"
          onClick={onSaveVersion}
          className="flex w-full items-center justify-center gap-2 rounded-md border px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <BookmarkPlus size={15} />
          Save current version
        </button>
      </div>
    </aside>
  );
}
