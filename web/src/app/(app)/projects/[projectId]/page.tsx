"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { createNote, listNotes, type NoteSummary } from "@/lib/api";

export default function ProjectNotes({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listNotes(projectId)
      .then((d) => setNotes(d.notes))
      .catch((e) => setErr(String(e)));
  }, [projectId]);

  async function onNew() {
    setCreating(true);
    try {
      const n = await createNote(projectId, "Untitled", "");
      router.push(`/notes/${n.id}`);
    } catch (e) {
      setErr(String(e));
      setCreating(false);
    }
  }

  return (
    <div className="p-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Notes</h1>
          <Button onClick={onNew} disabled={creating}>
            {creating ? "Creating…" : "New note"}
          </Button>
        </div>

        {err && <div className="mb-3 text-sm text-destructive">{err}</div>}

        {!notes ? (
          <div className="text-sm text-muted-foreground">loading…</div>
        ) : notes.length === 0 ? (
          <div className="text-sm text-muted-foreground">No notes yet.</div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {notes.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/notes/${n.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent"
                >
                  <span className="min-w-0 truncate">{n.title}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {n.type && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {n.type}
                      </span>
                    )}
                    {n.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        #{t}
                      </span>
                    ))}
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
