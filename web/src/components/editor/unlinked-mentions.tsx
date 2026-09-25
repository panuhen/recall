"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  getUnlinkedMentions,
  HttpError,
  linkUnlinkedMention,
  type UnlinkedMention,
} from "@/lib/api";
import { highlightTerms } from "@/lib/mentions";

// "Unlinked mentions" under Backlinks: other notes in the workspace that name
// this note in plain text without a [[wikilink]]. Collapsed to a count by
// default (a suggestion surface, like Related), hidden entirely when there are
// none. "Link" rewrites the first plain mention in that note into a wikilink;
// it's offered only when the caller can edit the mentioning note.
//
// Refetches when `version` (the open note's updated_at) moves, since a rename
// or a new alias changes what counts as a mention. Mount with key={noteId} so
// switching notes starts collapsed with no stale rows.
export function UnlinkedMentions({
  noteId,
  version,
  onLinked,
}: {
  noteId: string;
  version: string;
  onLinked: () => void;
}) {
  const [mentions, setMentions] = useState<UnlinkedMention[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getUnlinkedMentions(noteId)
      .then((r) => !cancelled && setMentions(r.mentions))
      .catch(() => !cancelled && setMentions(null));
    return () => {
      cancelled = true;
    };
  }, [noteId, version, reload]);

  async function link(m: UnlinkedMention) {
    setBusy(m.id);
    try {
      await linkUnlinkedMention(noteId, m.id);
      toast("Linked");
      onLinked();
    } catch (e) {
      // 409: the mention is gone or the note changed meanwhile — the refetch
      // below shows the current state either way.
      const stale = e instanceof HttpError && e.status === 409;
      toast(stale ? "That mention changed — list refreshed" : "Couldn't link", "error");
    } finally {
      setBusy(null);
      setReload((n) => n + 1);
    }
  }

  if (!mentions || mentions.length === 0) return null;

  return (
    <div className="space-y-2 border-t pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-sm font-medium hover:text-foreground"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Unlinked mentions{" "}
        <span className="text-muted-foreground">{mentions.length}</span>
      </button>
      {open && (
        <ul className="space-y-3 text-sm">
          {mentions.map((m) => (
            <li key={m.id} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <Link href={`/notes/${m.id}`} className="text-link hover:underline">
                  {m.title || "Untitled"}
                </Link>
                <div className="mt-0.5 break-words text-xs text-muted-foreground">
                  {highlightTerms(m.snippet, [m.match, m.term]).map((p, i) =>
                    p.hit ? (
                      <mark
                        key={i}
                        className="rounded-sm bg-amber-500/25 px-0.5 text-foreground"
                      >
                        {p.text}
                      </mark>
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
                </div>
              </div>
              {m.can_edit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={busy !== null}
                  onClick={() => void link(m)}
                  title={`Turn this mention in “${m.title}” into a link`}
                >
                  {busy === m.id ? "Linking…" : "Link"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
