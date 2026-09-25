"use client";

import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { ConventionHint, NoteReview } from "@/lib/api";
import { hintParts, reviewLine } from "@/lib/health";

// Under the note title: the review line (only when the note is overdue) and
// the workspace guide's hints. Renders nothing when there's nothing to say.
export function NoteHealth({
  review,
  hints,
  canEdit,
  onMarkReviewed,
}: {
  review: NoteReview | null | undefined;
  hints: ConventionHint[] | undefined;
  canEdit: boolean;
  onMarkReviewed: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [justReviewed, setJustReviewed] = useState(false);
  const overdue = review?.overdue ?? false;
  if (!overdue && !justReviewed && !hints?.length) return null;

  async function mark() {
    setBusy(true);
    const ok = await onMarkReviewed();
    setBusy(false);
    if (ok) setJustReviewed(true);
  }

  return (
    <div className="space-y-1.5 text-sm">
      {overdue && review && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <AlertTriangle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{reviewLine(review)}</span>
          </span>
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7"
              onClick={() => void mark()}
              disabled={busy}
            >
              {busy ? "Saving…" : "Mark as reviewed"}
            </Button>
          )}
        </div>
      )}
      {!overdue && justReviewed && (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2 size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
          Marked as reviewed today.
        </div>
      )}
      {hints?.map((h) => (
        <div key={`${h.code}:${h.message}`} className="flex items-start gap-1.5 text-muted-foreground">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            {hintParts(h.message).map((p, i) =>
              p.code ? (
                <code key={i} className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
                  {p.text}
                </code>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
