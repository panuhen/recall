"use client";

import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  Clock,
  Code,
  FolderOpen,
  History,
  Link as LinkIcon,
  Link2,
  List,
  Lock,
  PenLine,
  RotateCcw,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";

import { DiffView } from "@/components/editor/diff-view";
import type { EditorMode } from "@/components/editor/markdown-editor";
import { NoteHistoryPanel } from "@/components/editor/note-history-panel";
import { NoteTitleInput } from "@/components/editor/note-title-input";
import { ReadingView } from "@/components/editor/reading-view";
import { NoteMenu } from "@/components/note-menu";
import { NoteProperties } from "@/components/note-properties";
import { useTabs } from "@/components/tabs/tabs-context";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  getNote,
  getRelated,
  getRevision,
  listNotes,
  listRevisions,
  NoteConflictError,
  restoreRevision,
  saveRevision,
  updateNote,
  type Note,
  type NoteActor,
  type NoteSummary,
  type RelatedNote,
  type Revision,
} from "@/lib/api";
import { updateFrontmatter, type FrontmatterValue } from "@/lib/frontmatter";
import { useRevalidate } from "@/lib/revalidate";
import { slugify } from "@/lib/slugify";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useCopyLink } from "@/lib/use-copy-link";
import { readPreferences } from "@/lib/use-preferences";

const MarkdownEditor = dynamic(
  () => import("@/components/editor/markdown-editor").then((m) => m.MarkdownEditor),
  {
    ssr: false,
    loading: () => (
      <div className="p-2 text-sm text-muted-foreground">loading editor…</div>
    ),
  },
);

type SaveState = "saved" | "unsaved" | "saving" | "error";

const SAVE_DEBOUNCE_MS = 800;
const MODE_KEY = "recall.editorMode";
const VIEW_PREFS_KEY = "recall.noteViewPrefs";

// Per-note visibility of the Properties / Backlinks sections, so each tab
// remembers what the user opened. Keyed by note id, persisted across sessions.
type NoteViewPref = { props?: boolean; backlinks?: boolean; meta?: boolean };

function readViewPrefs(): Record<string, NoteViewPref> {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeViewPref(noteId: string, patch: NoteViewPref) {
  try {
    const all = readViewPrefs();
    all[noteId] = { ...all[noteId], ...patch };
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(all));
  } catch {
    // ignore storage errors
  }
}

export default function NotePage({
  params,
}: {
  params: Promise<{ noteId: string }>;
}) {
  const { noteId } = use(params);
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [mode, setMode] = useState<EditorMode>("live");
  const [showProps, setShowProps] = useState(false);
  const [showBacklinks, setShowBacklinks] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  // Semantic neighbors for the "Related" section. Shows beneath Backlinks
  // (same section toggle), opt-in via Settings → Preferences (off by default).
  // Unlike the section-open defaults below (per-note snapshots at open time),
  // this is a feature switch — tracked live so toggling it in Settings applies
  // to open notes immediately (same pattern as the sidebar's org-workspaces).
  const [related, setRelated] = useState<RelatedNote[] | null>(null);
  const [relatedEnabled, setRelatedEnabled] = useState(false);
  // Code-block syntax highlighting (Settings → Appearance). Live like the
  // related switch so toggling it reflows open notes without a refresh.
  const [codeHighlight, setCodeHighlight] = useState(true);
  useEffect(() => {
    const read = () => {
      const p = readPreferences();
      setRelatedEnabled(p.related);
      setCodeHighlight(p.codeHighlight);
    };
    read();
    window.addEventListener("recall:prefs", read);
    return () => window.removeEventListener("recall:prefs", read);
  }, []);
  // Version history is an ephemeral view (not persisted like the panels above):
  // opening it docks the revision list and shows a diff in the main area.
  const [showHistory, setShowHistory] = useState(false);
  // Mobile only: whether the version LIST (a full-screen overlay) is showing, vs.
  // the selected version's diff. Desktop shows both side by side and ignores it.
  const [histList, setHistList] = useState(true);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selectedRevId, setSelectedRevId] = useState<string | null>(null);
  const [revBodies, setRevBodies] = useState<Record<string, string>>({});
  // A non-blocking notice about the note changing underneath you: another
  // person saved (`conflict`, carrying their version) or the note is no longer
  // available to you (`removed`). Drives the banner; null when in sync.
  const [notice, setNotice] = useState<
    { kind: "conflict"; note: Note } | { kind: "removed" } | null
  >(null);
  const { openTab, setTabTitle, tabs, closeTab } = useTabs();
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const copyLink = useCopyLink();

  // Other notes in this workspace — the index that resolves `[[wikilinks]]` to a
  // note id and (later) feeds the link picker. Links only resolve within a
  // workspace, so this is scoped to the current note's project.
  const [linkTargets, setLinkTargets] = useState<NoteSummary[]>([]);
  const projectId = note?.project_id;
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    listNotes(projectId)
      .then(({ notes }) => !cancelled && setLinkTargets(notes))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Resolve a wikilink to a note id. First preference: the server-resolved
  // edge (note.links) — it ships in the same payload as the body, so the two
  // can never desync (a rename cascade rewrites this note's text AND its edges
  // in one transaction; a cached workspace list lags and would render the
  // fresh text as a dead link). Fallback for text the server hasn't indexed
  // yet (unsaved edits): match the workspace list by title, literal slug, or
  // slugified text — the slug never changes, so this also covers restored or
  // cascade-skipped linkers.
  const noteLinks = note?.links;
  const resolveLink = useCallback(
    (target: string): string | null => {
      const key = target.split("#")[0].trim().toLowerCase();
      // Anchor-only ([[#Heading]]) or punctuation-only targets have no note to
      // resolve to — bail before slugify, which maps "" to "untitled" and would
      // wrongly match a real note slugged "untitled".
      if (!key) return null;
      const edge = noteLinks?.find((l) => l.target_title.toLowerCase() === key);
      if (edge?.id) return edge.id;
      const slug = slugify(key);
      const hit = linkTargets.find(
        (n) => n.title.toLowerCase() === key || n.slug === key || n.slug === slug,
      );
      return hit?.id ?? null;
    },
    [noteLinks, linkTargets],
  );

  // Open a note (new tab / focus if already open). The target page adds itself
  // to the tab set on load and this note's tab stays put — the "new tab" default.
  const openNote = useCallback((id: string) => router.push(`/notes/${id}`), [router]);

  const followLink = useCallback(
    (target: string) => {
      const id = resolveLink(target);
      if (id) openNote(id);
      else toast("No note titled that in this workspace", "error");
    },
    [resolveLink, openNote, toast],
  );

  // Last-persisted content, and a live mirror of the current edits so the
  // debounced/unmount save always reads the newest values. `updatedAt` is the
  // server version we're based on — sent with each save as the concurrency
  // token, and compared on revalidate to detect another person's edit.
  const savedRef = useRef<{ title: string; body: string; updatedAt: string } | null>(
    null,
  );
  // The last title we pushed to the tab, so we can tell our own edits apart
  // from an external rename (e.g. from the sidebar) coming back through it.
  const pushedTitle = useRef("");
  const latest = useRef({ title, body });
  latest.current = { title, body };

  // Whether the caller may edit this note. Viewers (org-wide read access, or an
  // explicit viewer membership) get a read-only surface — no editor, no
  // autosave — instead of controls that 403 on the server. Notes returned from
  // mutating calls omit the flag; the caller is an editor there, so default on.
  const canEdit = note?.can_edit ?? true;

  // Editor mode preference is remembered across notes/sessions.
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "live" || saved === "read" || saved === "source")
      setMode(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  // Ctrl/Cmd+E toggles editing (Live Preview) ⇄ Reading (works regardless of
  // focus); from Source it switches to Reading.
  useEffect(() => {
    if (!canEdit) return; // viewers are locked to Reading — nothing to toggle
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "e"
      ) {
        e.preventDefault();
        setMode((m) => (m === "read" ? "live" : "read"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit]);

  useEffect(() => {
    let cancelled = false;
    savedRef.current = null;
    // Switching notes exits any open history view and drops the loaded diffs.
    setShowHistory(false);
    setRevisions(null);
    setSelectedRevId(null);
    setRevBodies({});
    setNotice(null);
    getNote(noteId)
      .then((n) => {
        if (cancelled) return;
        setNote(n);
        setTitle(n.title);
        setBody(n.body);
        savedRef.current = { title: n.title, body: n.body, updatedAt: n.updated_at };
        setSaveState("saved");
        openTab(n.id, n.title || "Untitled");
        // Open-state precedence: this note's saved per-note pref, else the
        // user's global default (Settings → Preferences), else the built-in.
        // Properties' "auto" default opens only when the note already has any.
        const pref = readViewPrefs()[n.id];
        const gp = readPreferences();
        const hasProps = Boolean(
          n.type || n.status || n.tags.length || Object.keys(n.metadata ?? {}).length,
        );
        const propsDefault =
          gp.properties === "always" ? true : gp.properties === "never" ? false : hasProps;
        setShowProps(pref?.props ?? propsDefault);
        setShowBacklinks(pref?.backlinks ?? gp.backlinks);
        setShowMeta(pref?.meta ?? gp.metadata);
      })
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [noteId, openTab]);

  // Don't show the previous note's Related list while the next one loads.
  useEffect(() => setRelated(null), [noteId]);

  // Fetch semantic neighbors while the Backlinks section is visible. Re-runs
  // after a save (updated_at moves) — embedding is async, so fresh edits can
  // lag one save behind; fine for a suggestion surface. Errors just leave the
  // section hidden: Related is a nicety, never a blocker.
  const noteUpdatedAt = note?.updated_at;
  useEffect(() => {
    if (!showBacklinks || !relatedEnabled || !noteUpdatedAt) return;
    let cancelled = false;
    getRelated(noteId)
      .then((r) => !cancelled && setRelated(r.related))
      .catch(() => !cancelled && setRelated(null));
    return () => {
      cancelled = true;
    };
  }, [noteId, showBacklinks, relatedEnabled, noteUpdatedAt]);

  // Keep this note's tab label in sync with its (possibly edited) title.
  useEffect(() => {
    if (!note) return;
    const t = title.trim() || "Untitled";
    pushedTitle.current = t;
    setTabTitle(noteId, t);
  }, [noteId, title, note, setTabTitle]);

  // Adopt an external rename of this note (e.g. from the sidebar): its tab title
  // changes without us pushing it, so pull it back into the editor's title.
  const myTabTitle = tabs.find((t) => t.id === noteId)?.title;
  useEffect(() => {
    if (!note || myTabTitle == null || myTabTitle === pushedTitle.current) return;
    pushedTitle.current = myTabTitle;
    setTitle(myTabTitle);
  }, [myTabTitle, note]);

  const doSave = useCallback(async () => {
    const snap = { ...latest.current };
    const saved = savedRef.current;
    if (saved && snap.title === saved.title && snap.body === saved.body) return;
    setSaveState("saving");
    try {
      await updateNote(noteId, snap, saved?.updatedAt);
      const fresh = await getNote(noteId); // refresh projected metadata + backlinks + links
      // If the user kept editing during the round-trip, we're dirty again;
      // the change effect below will reschedule.
      const clean =
        latest.current.title === snap.title && latest.current.body === snap.body;
      // A rename with a self-link makes the server rewrite our own body
      // ([[Old]]→[[New]]); if we're still clean, adopt it so the editor and
      // savedRef match the server — otherwise the next autosave would ship the
      // pre-rewrite body with a valid token and silently revert the rewrite.
      // If the user typed on, keep their text (savedRef = snap) and let the
      // reschedule save it.
      if (clean && (fresh.body !== snap.body || fresh.title !== snap.title)) {
        setTitle(fresh.title);
        setBody(fresh.body);
        savedRef.current = { title: fresh.title, body: fresh.body, updatedAt: fresh.updated_at };
      } else {
        savedRef.current = { ...snap, updatedAt: fresh.updated_at };
      }
      setNote(fresh);
      setSaveState(clean ? "saved" : "unsaved");
    } catch (e) {
      if (e instanceof NoteConflictError) {
        // Someone else saved first. Never overwrite blindly — hold the user's
        // edits in place and surface the choice (reload theirs / keep mine).
        if (e.note) setNotice({ kind: "conflict", note: e.note });
        setSaveState("unsaved");
      } else {
        setSaveState("error");
      }
    }
  }, [noteId]);

  // Debounced autosave whenever the content diverges from what's persisted.
  useEffect(() => {
    if (!canEdit) return; // viewers can't persist — never attempt a save
    // Hold saves while a conflict is unresolved: retrying would only 409 again.
    // The user's edits stay in the editor until they pick reload / keep-mine.
    if (notice?.kind === "conflict") return;
    const saved = savedRef.current;
    if (!saved) return; // still loading
    if (title === saved.title && body === saved.body) return;
    setSaveState("unsaved");
    const t = setTimeout(() => void doSave(), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [title, body, doSave, canEdit, notice]);

  // Flush pending edits when navigating away.
  useEffect(
    () => () => {
      const saved = savedRef.current;
      const cur = latest.current;
      if (saved && (cur.title !== saved.title || cur.body !== saved.body)) {
        // Pass the concurrency token: if a rename cascade rewrote this note
        // (as a linker) while the tab sat open and dirty, a tokenless flush
        // would clobber that rewrite last-writer-wins. On 409 the flush is
        // dropped — the component is unmounting, so there's no UI to reconcile,
        // and losing a sub-second of unsaved text beats reverting the rewrite.
        void updateNote(noteId, { ...cur }, saved.updatedAt);
      }
    },
    [noteId],
  );

  // Return `n` if it already carries resolved outbound links, else refetch the
  // full note (409-conflict payloads and the restore response omit `links`, and
  // resolveLink's id-based path needs them or a freshly-cascaded [[New]] link
  // renders dead until the next save).
  const withLinks = useCallback(
    async (n: Note): Promise<Note> =>
      n.links === undefined ? await getNote(noteId).catch(() => n) : n,
    [noteId],
  );

  // Adopt a server version into the editor, discarding any local divergence.
  // Shared by silent catch-up (idle + remote change) and the banner's Reload.
  const adopt = useCallback(
    async (fresh: Note) => {
      const full = await withLinks(fresh);
      setNote(full);
      setTitle(full.title);
      setBody(full.body);
      savedRef.current = { title: full.title, body: full.body, updatedAt: full.updated_at };
      setSaveState("saved");
      setNotice(null);
    },
    [withLinks],
  );

  // Re-save local edits over the server's newer version — the human's explicit
  // "keep mine" after a conflict, so it's an intended overwrite (not a blind one).
  const keepMine = useCallback(
    async (over: Note) => {
      const snap = { ...latest.current };
      setNotice(null);
      setSaveState("saving");
      try {
        const updated = await updateNote(noteId, snap, over.updated_at);
        savedRef.current = { ...snap, updatedAt: updated.updated_at };
        const fresh = await getNote(noteId);
        setNote(fresh);
        setSaveState("saved");
      } catch (e) {
        if (e instanceof NoteConflictError && e.note) {
          setNotice({ kind: "conflict", note: e.note }); // moved again mid-decision
          setSaveState("unsaved");
        } else {
          setSaveState("error");
        }
      }
    },
    [noteId],
  );

  // Revalidate the open note on tab focus / interval. Adopt a newer version
  // silently when you're idle; if you have unsaved edits, raise the conflict
  // banner instead of touching your text. A note that has vanished (unshared /
  // deleted) shows the "removed" banner rather than leaving a stale view.
  const revalidateNote = useCallback(() => {
    const saved = savedRef.current;
    if (!saved) return; // still loading
    if (saveState === "saving") return; // let an in-flight save settle first
    getNote(noteId)
      .then((fresh) => {
        if (fresh.updated_at === saved.updatedAt) return; // in sync
        const dirty =
          latest.current.title !== saved.title || latest.current.body !== saved.body;
        if (dirty) setNotice({ kind: "conflict", note: fresh });
        else void adopt(fresh);
      })
      .catch((e) => {
        if (String(e).includes("404")) setNotice({ kind: "removed" });
      });
  }, [noteId, saveState, adopt]);

  useRevalidate(revalidateNote);

  const applyFrontmatter = useCallback(
    (updates: Record<string, FrontmatterValue>) => {
      setBody((b) => updateFrontmatter(b, updates));
    },
    [],
  );

  const toggleProps = useCallback(() => {
    setShowProps((v) => {
      writeViewPref(noteId, { props: !v });
      return !v;
    });
  }, [noteId]);

  const toggleBacklinks = useCallback(() => {
    setShowBacklinks((v) => {
      writeViewPref(noteId, { backlinks: !v });
      return !v;
    });
  }, [noteId]);

  const toggleMeta = useCallback(() => {
    setShowMeta((v) => {
      writeViewPref(noteId, { meta: !v });
      return !v;
    });
  }, [noteId]);

  // Raw markdown ("source") ⇄ back to Live Preview.
  const toggleSource = useCallback(() => {
    setMode((m) => (m === "source" ? "live" : "source"));
  }, []);

  const toggleHistory = useCallback(() => {
    setShowHistory((v) => !v);
    setHistList(true); // (re)open on the version list on mobile
  }, []);

  // (Re)load the revision list; keep the current selection if it survives,
  // else select the newest. Used on open and after save/restore.
  const refreshRevisions = useCallback(async () => {
    try {
      const { revisions } = await listRevisions(noteId);
      setRevisions(revisions);
      setSelectedRevId((cur) =>
        cur && revisions.some((r) => r.id === cur) ? cur : (revisions[0]?.id ?? null),
      );
    } catch {
      setRevisions([]);
    }
  }, [noteId]);

  useEffect(() => {
    if (!showHistory) return;
    setRevisions(null);
    setSelectedRevId(null);
    void refreshRevisions();
  }, [showHistory, refreshRevisions]);

  // Lazily fetch + cache the selected revision's body for the diff.
  useEffect(() => {
    if (!selectedRevId || revBodies[selectedRevId] !== undefined) return;
    let cancelled = false;
    getRevision(noteId, selectedRevId)
      .then((rev) => !cancelled && setRevBodies((m) => ({ ...m, [rev.id]: rev.body })))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedRevId, noteId, revBodies]);

  const saveVersion = useCallback(async () => {
    try {
      await doSave(); // persist pending edits so the snapshot captures them
      const { revisions } = await saveRevision(noteId);
      setRevisions(revisions);
      setSelectedRevId(revisions[0]?.id ?? null);
      toast("Version saved");
    } catch {
      toast("Could not save version", "error");
    }
  }, [noteId, doSave, toast]);

  const restoreSelected = useCallback(async () => {
    if (!selectedRevId) return;
    const ok = await confirm({
      title: "Restore this version?",
      description:
        "The current text is saved to history first, so you can undo this.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      await doSave(); // checkpoint the true current body, incl. unsaved edits
      const restored = await withLinks(await restoreRevision(noteId, selectedRevId));
      setNote(restored);
      setTitle(restored.title);
      setBody(restored.body);
      savedRef.current = {
        title: restored.title,
        body: restored.body,
        updatedAt: restored.updated_at,
      };
      setSaveState("saved");
      setShowHistory(false);
      setSelectedRevId(null);
      setRevBodies({});
      toast("Version restored");
    } catch {
      toast("Could not restore version", "error");
    }
  }, [noteId, selectedRevId, confirm, doSave, toast, withLinks]);

  if (err) return <div className="p-8 text-sm text-destructive">{err}</div>;
  if (!note) return <div className="p-8 text-sm text-muted-foreground">loading…</div>;

  const selectedRev = revisions?.find((r) => r.id === selectedRevId) ?? null;
  const selectedRevBody = selectedRevId ? revBodies[selectedRevId] : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="sticky top-0 z-10 flex h-11 items-center justify-between gap-3 bg-background/80 px-4 backdrop-blur md:px-8">
        <div className="flex min-w-0 items-center gap-2 md:flex-1">
          {canEdit ? (
            <SaveStatus state={saveState} onRetry={() => void doSave()} />
          ) : (
            <ReadOnlyStatus />
          )}
          {showMeta && saveState !== "error" && <MetaPopover note={note} />}
        </div>
        {/* The editable title sits right below in the content, so this
            persistent copy is redundant on mobile — desktop keeps it for when
            the content title has scrolled away. */}
        <div className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground max-md:hidden">
          {title.trim() || "Untitled"}
        </div>
        <div className="flex items-center justify-end gap-1 md:flex-1">
          {canEdit && <ModeToggle mode={mode} onChange={setMode} />}
          <NoteMenu
            items={[
              // Raw text and History are editing surfaces — viewers get neither.
              ...(canEdit
                ? [
                    {
                      label: "Raw text",
                      icon: <Code size={16} />,
                      active: mode === "source",
                      onClick: toggleSource,
                    },
                  ]
                : []),
              {
                label: "Properties",
                icon: <List size={16} />,
                active: showProps,
                onClick: toggleProps,
              },
              {
                label: "Backlinks",
                icon: <Link2 size={16} />,
                active: showBacklinks,
                onClick: toggleBacklinks,
              },
              {
                label: "Metadata",
                icon: <Clock size={16} />,
                active: showMeta,
                onClick: toggleMeta,
              },
              ...(canEdit
                ? [
                    {
                      label: "History",
                      icon: <History size={16} />,
                      active: showHistory,
                      onClick: toggleHistory,
                    },
                  ]
                : []),
              { divider: true as const },
              {
                label: "Copy link",
                icon: <LinkIcon size={16} />,
                onClick: () => void copyLink("note", noteId),
              },
              {
                label: "Open workspace",
                icon: <FolderOpen size={16} />,
                onClick: () => router.push(`/projects/${note.project_id}`),
              },
            ]}
          />
        </div>
      </div>

      {notice?.kind === "conflict" && (
        <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm md:px-8">
          <span className="min-w-0 flex-1 truncate text-foreground">
            Updated by {notice.note.updated_by?.name ?? "someone else"}
            {latest.current.title !== savedRef.current?.title ||
            latest.current.body !== savedRef.current?.body
              ? " — you have unsaved changes."
              : "."}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void adopt(notice.note)}>
            Reload
          </Button>
          {canEdit && (
            <Button variant="default" size="sm" onClick={() => void keepMine(notice.note)}>
              Keep mine
            </Button>
          )}
        </div>
      )}
      {notice?.kind === "removed" && (
        <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm md:px-8">
          <span className="min-w-0 flex-1 truncate text-foreground">
            This note is no longer available to you.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              closeTab(noteId);
              router.push("/");
            }}
          >
            Close
          </Button>
        </div>
      )}

      <div className="flex min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          <div className="px-4 py-6 md:px-8 md:py-10 max-md:pb-24">
            {/* Mobile: the version list is a full-screen overlay, so the diff
                needs a way back to it. Outside the space-y run (and md:hidden) so
                desktop spacing is untouched. */}
            {showHistory && (
              <button
                type="button"
                onClick={() => setHistList(true)}
                aria-label="Back to version list"
                className="mx-auto mb-4 flex max-w-3xl items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
              >
                <ChevronLeft size={16} />
                Versions
              </button>
            )}
            <div className="mx-auto max-w-3xl space-y-6">
              {showHistory ? (
                <HistoryMain
                  loading={revisions === null}
                  hasRevisions={(revisions?.length ?? 0) > 0}
                  rev={selectedRev}
                  revBody={selectedRevBody}
                  currentBody={body}
                  onRestore={restoreSelected}
                />
              ) : (
                <>
                  <NoteTitleInput
                    value={title}
                    onChange={setTitle}
                    placeholder="Untitled"
                    readOnly={!canEdit}
                    className="w-full resize-none overflow-hidden bg-transparent text-3xl font-semibold tracking-tight outline-none"
                  />
                  {showProps && (mode === "live" || !canEdit) && (
                    <div className="space-y-1 border-b pb-4">
                      <div className="text-sm text-muted-foreground">Properties</div>
                      <NoteProperties
                        key={note.id}
                        note={note}
                        onChange={applyFrontmatter}
                        readOnly={!canEdit}
                      />
                    </div>
                  )}
                  {mode === "read" || !canEdit ? (
                    <ReadingView
                      body={body}
                      resolveLink={resolveLink}
                      onOpenNote={openNote}
                      highlight={codeHighlight}
                    />
                  ) : (
                    <MarkdownEditor
                      value={body}
                      onChange={setBody}
                      mode={mode}
                      onFollowLink={followLink}
                      linkTargets={linkTargets}
                    />
                  )}

                  {showBacklinks && (
                    <div className="space-y-2 border-t pt-4">
                      <div className="text-sm font-medium">
                        Backlinks{" "}
                        <span className="text-muted-foreground">
                          {note.backlinks?.length ?? 0}
                        </span>
                      </div>
                      {!note.backlinks || note.backlinks.length === 0 ? (
                        <div className="text-sm text-muted-foreground">
                          No notes link here yet.
                        </div>
                      ) : (
                        <ul className="space-y-1 text-sm">
                          {note.backlinks.map((b) => (
                            <li key={b.id}>
                              <Link
                                href={`/notes/${b.id}`}
                                className="text-link hover:underline"
                              >
                                {b.title}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {/* Semantic neighbors — similar notes in this workspace the
                      note doesn't link to yet. Hidden entirely when empty (a
                      suggestion surface, not a status one). */}
                  {showBacklinks && relatedEnabled && related != null && related.length > 0 && (
                    <div className="space-y-2 border-t pt-4">
                      <div className="text-sm font-medium">
                        Related{" "}
                        <span className="text-muted-foreground">{related.length}</span>
                      </div>
                      <ul className="space-y-1 text-sm">
                        {related.map((r) => (
                          <li key={r.id}>
                            <Link
                              href={`/notes/${r.id}`}
                              className="text-link hover:underline"
                            >
                              {r.title || "Untitled"}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {showHistory && (
          <NoteHistoryPanel
            revisions={revisions ?? []}
            selectedId={selectedRevId}
            loading={revisions === null}
            onSelect={(id) => {
              setSelectedRevId(id);
              setHistList(false); // drill from the list into the diff on mobile
            }}
            onSaveVersion={saveVersion}
            onClose={toggleHistory}
            hiddenOnMobile={!histList}
          />
        )}
      </div>
    </div>
  );
}

// The main-column content when History is open: the diff between the selected
// revision and the current body, with a Restore action.
function HistoryMain({
  loading,
  hasRevisions,
  rev,
  revBody,
  currentBody,
  onRestore,
}: {
  loading: boolean;
  hasRevisions: boolean;
  rev: Revision | null;
  revBody: string | undefined;
  currentBody: string;
  onRestore: () => void;
}) {
  if (loading)
    return <div className="text-sm text-muted-foreground">loading history…</div>;
  if (!hasRevisions)
    return (
      <div className="text-sm text-muted-foreground">
        No earlier versions of this note yet. Keep editing — snapshots are taken
        automatically — or save one from the panel on the right.
      </div>
    );
  if (!rev)
    return (
      <div className="text-sm text-muted-foreground">
        Select a version from the right to see what changed.
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {rev.label ?? "Version"} · {relativeTime(rev.created_at)} → current
          </div>
          <div
            className="truncate text-xs text-muted-foreground"
            title={absoluteTime(rev.created_at)}
          >
            {rev.author?.name ? `${rev.author.name} · ` : ""}
            {absoluteTime(rev.created_at)}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onRestore}>
          <RotateCcw size={14} className="mr-1.5" />
          Restore
        </Button>
      </div>
      {revBody === undefined ? (
        <div className="text-sm text-muted-foreground">loading diff…</div>
      ) : (
        <DiffView oldText={revBody} newText={currentBody} />
      )}
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: EditorMode;
  onChange: (m: EditorMode) => void;
}) {
  const reading = mode === "read";
  return (
    <button
      type="button"
      onClick={() => onChange(reading ? "live" : "read")}
      aria-label={reading ? "Edit" : "Reading view"}
      title={
        reading
          ? "Reading view — click to edit (Ctrl/⌘E)"
          : "Editing — click for reading view (Ctrl/⌘E)"
      }
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {/* Reading → PenLine (go edit); Editing → BookOpen (go read). */}
      {reading ? <PenLine size={18} /> : <BookOpen size={18} />}
    </button>
  );
}

function SaveStatus({
  state,
  onRetry,
}: {
  state: SaveState;
  onRetry: () => void;
}) {
  if (state === "error") {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <span>Save failed</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  const label =
    state === "saving" ? "Saving…" : state === "unsaved" ? "Unsaved changes" : "Saved";
  return <div className="text-sm text-muted-foreground">{label}</div>;
}

// Shown in place of the save status when the caller only has view access to
// this note's workspace.
function ReadOnlyStatus() {
  return (
    <div
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
      title="You have view-only access to this workspace"
    >
      <Lock size={14} />
      Read-only
    </div>
  );
}

// Collapsed provenance hint next to the save status: relative "edited" time
// (exact on hover) that opens a popover with full created / last-edited detail.
function MetaPopover({ note }: { note: Note }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <span className="mr-2 text-muted-foreground max-md:hidden" aria-hidden>
        ·
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={absoluteTime(note.updated_at)}
        aria-label="Show note metadata"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        {/* Mobile: a compact clock+chevron so the header doesn't cram; desktop
            keeps the inline "edited …" provenance. Same popover either way. */}
        <Clock size={14} className="md:hidden" />
        <span className="max-md:hidden">edited {relativeTime(note.updated_at)}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 w-64 rounded-md border bg-card p-3 text-sm shadow-md">
          <MetaRow label="Created" actor={note.created_by} iso={note.created_at} />
          <MetaRow label="Last edited" actor={note.updated_by} iso={note.updated_at} />
        </div>
      )}
    </div>
  );
}

function MetaRow({
  label,
  actor,
  iso,
}: {
  label: string;
  actor: NoteActor | null;
  iso: string;
}) {
  return (
    <div className="py-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-foreground" title={relativeTime(iso)}>
        {actor?.name ? `${actor.name} · ` : ""}
        {absoluteTime(iso)}
      </div>
    </div>
  );
}
