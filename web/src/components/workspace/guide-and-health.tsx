"use client";

import { AlertTriangle, BookOpen, ChevronRight, HeartPulse, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  createGuide,
  getWorkspaceHealth,
  HttpError,
  type HealthListKey,
  type WorkspaceGuide,
  type WorkspaceHealth,
} from "@/lib/api";
import { HEALTH_ORDER, healthSummary, listTitle, reviewedText } from "@/lib/health";
import { useRevalidate } from "@/lib/revalidate";
import { relativeTime } from "@/lib/time";

type Loaded = { guide: WorkspaceGuide | null; health: WorkspaceHealth; can_edit: boolean };

// The workspace landing page's guide card and Health section. Both are quiet
// by design: no guide → an "Add a guide" prompt for editors only; nothing to
// report → no Health section at all.
export function GuideAndHealth({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Loaded | null>(null);

  const load = useCallback(() => {
    getWorkspaceHealth(projectId)
      .then(setData)
      .catch(() => {}); // a nicety on top of the page; keep what's shown
  }, [projectId]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useRevalidate(load);

  if (!data) return null;
  return (
    <div className="mb-6 space-y-3">
      {data.guide ? (
        <GuideCard guide={data.guide} />
      ) : (
        data.can_edit && <AddGuide projectId={projectId} />
      )}
      <HealthSection health={data.health} />
    </div>
  );
}

function GuideCard({ guide }: { guide: WorkspaceGuide }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
      <Link
        href={`/notes/${guide.id}`}
        className="flex min-w-0 items-center gap-2 font-medium hover:underline"
      >
        <BookOpen size={15} className="shrink-0 text-muted-foreground" />
        <span className="truncate">{guide.title || "Untitled"}</span>
      </Link>
      {guide.summary && <p className="mt-1 text-muted-foreground">{guide.summary}</p>}
      {guide.owner && (
        <p className="mt-1 text-xs text-muted-foreground">
          Owner: {guide.owner}
          {guide.owner_left && (
            <span className="text-amber-600 dark:text-amber-400"> (no longer a member)</span>
          )}
        </p>
      )}
      {guide.problems.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            The guide has a formatting problem, so its conventions are off until it’s fixed:{" "}
            {guide.problems[0]}
          </span>
        </p>
      )}
      {guide.guide_count > 1 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {guide.guide_count} notes are marked as a guide. This one is used because it’s the
          oldest.
        </p>
      )}
    </div>
  );
}

function AddGuide({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onAdd() {
    setBusy(true);
    setFailed(false);
    try {
      const note = await createGuide(projectId);
      router.push(`/notes/${note.id}`);
    } catch (e) {
      // Someone added one meanwhile: the page refresh will show it.
      if (!(e instanceof HttpError && e.status === 409)) setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="text-muted-foreground">
        This workspace has no guide yet. A guide tells people and agents how notes are
        written here.
        {failed && <span className="text-destructive"> Couldn’t create it.</span>}
      </div>
      <Button variant="outline" size="sm" onClick={onAdd} disabled={busy} className="shrink-0">
        <Plus size={14} />
        {busy ? "Adding…" : "Add a guide"}
      </Button>
    </div>
  );
}

function HealthSection({ health }: { health: WorkspaceHealth }) {
  const [open, setOpen] = useState(false);
  const summary = healthSummary(health.counts);
  if (summary.length === 0) return null;

  return (
    <section className="rounded-lg border text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-accent/50"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <HeartPulse size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium">Health</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {summary.map((s) => s.label).join(" · ")}
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t px-4 py-3">
          {HEALTH_ORDER.filter((k) => health.counts[k] > 0).map((key) => (
            <HealthList key={key} listKey={key} health={health} />
          ))}
        </div>
      )}
    </section>
  );
}

function HealthList({ listKey, health }: { listKey: HealthListKey; health: WorkspaceHealth }) {
  const total = health.counts[listKey];
  const rows = rowsFor(listKey, health);
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">
        {listTitle(listKey, health.stale_after_months)}{" "}
        <span className="font-normal">{total}</span>
      </h3>
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.key} className="flex min-w-0 items-baseline justify-between gap-3">
            <Link href={`/notes/${r.id}`} className="min-w-0 truncate text-link hover:underline">
              {r.title || "Untitled"}
            </Link>
            {r.detail && (
              <span className="shrink-0 text-xs text-muted-foreground">{r.detail}</span>
            )}
          </li>
        ))}
      </ul>
      {total > rows.length && (
        <p className="mt-1 text-xs text-muted-foreground">and {total - rows.length} more</p>
      )}
    </div>
  );
}

type Row = { key: string; id: string; title: string; detail: string | null };

function rowsFor(key: HealthListKey, h: WorkspaceHealth): Row[] {
  switch (key) {
    case "overdue":
      return h.overdue.map((n) => ({
        key: n.id,
        id: n.id,
        title: n.title,
        detail: `${reviewedText(n.reviewed)} (every ${n.every_text})`,
      }));
    case "owner_left":
      return h.owner_left.map((n) => ({
        key: n.id,
        id: n.id,
        title: n.title,
        detail: `owner: ${n.owner}`,
      }));
    case "broken_links":
      return h.broken_links.map((b) => ({
        key: `${b.id}:${b.target_title}`,
        id: b.id,
        title: b.title,
        detail: `→ [[${b.target_title}]] ${b.reason === "trashed" ? "(in trash)" : "(missing)"}`,
      }));
    case "old_drafts":
    case "not_edited":
      return h[key].map((n) => ({
        key: n.id,
        id: n.id,
        title: n.title,
        detail: `edited ${relativeTime(n.updated_at)}`,
      }));
    case "orphans":
      return h.orphans.map((n) => ({ key: n.id, id: n.id, title: n.title, detail: null }));
  }
}
