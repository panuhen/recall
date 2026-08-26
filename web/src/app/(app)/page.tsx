"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { listRecentNotes, type RecentNote } from "@/lib/api";
import { relativeTime } from "@/lib/time";
import { readPreferences } from "@/lib/use-preferences";

export default function Home() {
  const [showRecent, setShowRecent] = useState(false);
  const [notes, setNotes] = useState<RecentNote[] | null>(null);

  const sync = useCallback(() => {
    const on = readPreferences().showRecentOnHome;
    setShowRecent(on);
    if (on) {
      listRecentNotes()
        .then((d) => setNotes(d.notes.slice(0, 10)))
        .catch(() => setNotes([]));
    }
  }, []);

  useEffect(() => {
    sync();
    window.addEventListener("recall:prefs", sync);
    return () => window.removeEventListener("recall:prefs", sync);
  }, [sync]);

  if (!showRecent) {
    return (
      <div className="p-4 md:p-8">
        <div className="mx-auto max-w-2xl space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Pick up where you left off.
          </h1>
          <p className="text-sm text-muted-foreground">
            Choose a note in the sidebar, or right-click a folder to start a new
            one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Pick up where you left off.
        </h1>
        <p className="text-sm text-muted-foreground">
          Your most recently edited notes across all workspaces.
        </p>

        {notes === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No notes yet. Create one from the sidebar.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {notes.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/notes/${n.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-accent"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {n.title}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {n.project_name}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(n.updated_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
