"use client";

import {
  ArrowUpDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Compass,
  Copy,
  Download,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  Globe,
  Link as LinkIcon,
  LogOut,
  MoreHorizontal,
  Network,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  SquarePlus,
  Star,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Waypoints,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useGraphDock } from "@/components/graph/graph-dock-context";
import { useMobileNav } from "@/components/mobile-nav";
import { NoteMenu } from "@/components/note-menu";
import { useBrowse } from "@/components/browse/browse-dialog";
import { useSearch } from "@/components/search/search-dialog";
import { useSettings } from "@/components/settings/settings-dialog";
import { useShare } from "@/components/share/share-dialog";
import { useTrash } from "@/components/trash/trash-dialog";
import { SidebarContextMenu, type MenuItem } from "@/components/sidebar-context-menu";
import { useTabs } from "@/components/tabs/tabs-context";
import { buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  addFavorite,
  copyFolder,
  copyNote,
  createFolder,
  createNote,
  createProject,
  deleteFolder,
  deleteNote,
  deleteProject,
  type FavoriteItem,
  type FavoriteType,
  type FolderSummary,
  getNote,
  listFavorites,
  listOrgProjects,
  listTree,
  moveFolder,
  moveNote,
  type NoteSummary,
  type OrgAccess,
  type OrgProject,
  pinProject,
  removeFavorite,
  renameFolder,
  renameProject,
  reorderFavorites,
  type Tree,
  unpinProject,
  updateNote,
} from "@/lib/api";
import {
  downloadNoteMarkdown,
  downloadZip,
  folderZipPath,
  projectZipPath,
} from "@/lib/export-markdown";
import { importMarkdownFiles, partitionFiles } from "@/lib/import-markdown";
import { useRevalidate } from "@/lib/revalidate";
import { useCopyLink } from "@/lib/use-copy-link";
import { type OrgWorkspacesMode, readPreferences } from "@/lib/use-preferences";
import { type CreateTarget, describeTarget, resolveCreateTarget } from "@/lib/create-target";
import { cn } from "@/lib/utils";

type Project = {
  id: string;
  name: string;
  slug: string;
  role: string;
  is_personal: boolean;
  member_count?: number;
  org_access?: OrgAccess;
  created_at: string;
  updated_at: string;
};

// An org-visible workspace (Browse/pinned) rendered as a Project row: it's a
// viewer, never personal, and always org-visible.
const orgToProject = (o: OrgProject): Project => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  role: "viewer",
  is_personal: false,
  member_count: o.member_count,
  org_access: "viewer",
  created_at: o.updated_at,
  updated_at: o.updated_at,
});

type Me = {
  user: { id: string; upn: string; name: string | null };
  personal_project_id: string;
  projects: Project[];
  favorites: FavoriteItem[];
};

type State =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: Me };

// Per-project folder+note tree, loaded lazily when a project is first expanded.
type TreeState = Tree | "loading" | "error" | undefined;

// The item being dragged: a note (movable across projects) or a folder (movable
// only within its own project).
type Drag = { kind: "note" | "folder"; id: string; title: string; projectId: string };

// Inline creation of a new folder under a target parent (null = project root).
type Creating = { projectId: string; parentId: string | null };
// Inline rename of a project / folder / note.
type Renaming = { kind: "project" | "folder" | "note"; id: string; projectId: string };
type Menu = { x: number; y: number; items: MenuItem[] };

const EXPANDED_KEY = "recall.sidebar.expanded";
const SORT_KEY = "recall.sidebar.sort";
const TOOLBAR_BTN =
  "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground";
// Thin vertical rule separating the toolbar's three groups (create / explore / view).
const TOOLBAR_DIVIDER = "mx-1 h-5 w-px shrink-0 bg-border";

type SortMode =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc";

const SORT_OPTIONS: { mode: SortMode; label: string }[] = [
  { mode: "name-asc", label: "Name (A to Z)" },
  { mode: "name-desc", label: "Name (Z to A)" },
  { mode: "modified-desc", label: "Modified (new to old)" },
  { mode: "modified-asc", label: "Modified (old to new)" },
  { mode: "created-desc", label: "Created (new to old)" },
  { mode: "created-asc", label: "Created (old to new)" },
];

// Comparators for a sort mode, applied to workspaces, folders, and notes alike
// (folders still render before notes within a level). ISO timestamps compare
// chronologically as plain strings, so no date parsing is needed.
function comparators(mode: SortMode) {
  const dir = mode.endsWith("-desc") ? -1 : 1;
  const cmp = (a: string, b: string) =>
    dir * a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  // The string to compare on for the active axis.
  const key = (label: string, created: string, updated: string) =>
    mode.startsWith("name") ? label : mode.startsWith("created") ? created : updated;
  return {
    projects: (a: Project, b: Project) =>
      cmp(key(a.name, a.created_at, a.updated_at), key(b.name, b.created_at, b.updated_at)),
    folders: (a: FolderSummary, b: FolderSummary) =>
      cmp(key(a.name, a.created_at, a.updated_at), key(b.name, b.created_at, b.updated_at)),
    notes: (a: NoteSummary, b: NoteSummary) =>
      cmp(
        key(a.title || "", a.created_at, a.updated_at),
        key(b.title || "", b.created_at, b.updated_at),
      ),
  };
}
const canWrite = (role: string) => role === "owner" || role === "editor";

// True when a drag carries OS files (a markdown import) rather than our own
// internal note/folder drag.
const isFileDrag = (dt: DataTransfer) => dt.types.includes("Files");
// How many files the drag carries. Readable during dragover (contents aren't);
// falls back to 1 if the item list is momentarily empty.
const fileCount = (dt: DataTransfer) =>
  Array.from(dt.items).filter((i) => i.kind === "file").length || 1;

// 1×1 transparent GIF — replaces the browser's default drag image so our own
// tooltip is the only thing following the cursor.
const TRANSPARENT_IMG =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Is `nodeId` the folder `rootId` or one of its descendants? Used to block a
// folder being dropped into its own subtree (which would orphan it).
function inSubtree(tree: Tree, rootId: string, nodeId: string | null): boolean {
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  let cur: string | null = nodeId;
  while (cur) {
    if (cur === rootId) return true;
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return false;
}

// Uncontrolled inline text field: Enter commits, Escape cancels. Blur commits or
// cancels per `commitOnBlur`. A ref guards against the commit+blur double-fire.
function InlineInput({
  initial = "",
  placeholder,
  commitOnBlur = false,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  commitOnBlur?: boolean;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  const finish = (commit: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, "");
        }
      }}
      onBlur={(e) => finish(commitOnBlur, e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary"
    />
  );
}

// A row label that truncates with an ellipsis at rest, and — like the Claude
// desktop chat list — plays a gentle right-to-left marquee of the full title
// once the pointer lingers, resting on the tail. No-op when the title fits.
// The inner span is measured (and shows the ellipsis) while capped to the
// visible width; on hover it runs full-width past the clipped parent and the
// transform reveals the overflow at a constant speed.
function MarqueeText({ text, className }: { text: string; className?: string }) {
  const inner = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState(0); // px of overflow to reveal (0 = at rest)

  function onEnter() {
    const el = inner.current;
    if (!el) return;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1) setScroll(over);
  }

  return (
    <span
      onMouseEnter={onEnter}
      onMouseLeave={() => setScroll(0)}
      className={cn("block overflow-hidden", className)}
    >
      <span
        ref={inner}
        // Keep display + overflow constant across rest/hover and only flip
        // max-width: toggling `overflow` on an inline-block shifts its baseline
        // (bottom-edge when hidden → text-baseline when visible), which would
        // change the row height and make the hover highlight + rows below jump.
        className={cn(
          "inline-block overflow-hidden whitespace-nowrap text-ellipsis",
          scroll ? "max-w-none" : "max-w-full",
        )}
        style={{
          transform: `translateX(-${scroll}px)`,
          transitionProperty: "transform",
          transitionTimingFunction: "linear",
          // ~16 ms/px keeps a steady, readable scroll; wait out a brief hover
          // before starting, and snap back instantly on leave.
          transitionDuration: scroll ? `${Math.round(scroll * 16)}ms` : "0ms",
          transitionDelay: scroll ? "500ms" : "0ms",
        }}
      >
        {text}
      </span>
    </span>
  );
}

// Mobile-only "⋯" button standing in for right-click on a tree row: it opens the
// same actions menu (share, rename, delete, new note, export, favorite…). Hidden
// at md+, where right-clicking the row is the affordance and chrome stays quiet.
function RowMenuButton({
  onOpen,
  label,
}: {
  onOpen: (e: React.MouseEvent) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title="More actions"
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground md:hidden"
    >
      <MoreHorizontal size={16} />
    </button>
  );
}

// entra: the MSAL route clears the cookie and ends the Entra SSO session.
// betterauth: Better Auth's sign-out (a POST) clears its session, then back to
// the sign-in page. dev: there is no session to end.
async function signOut(authMode: string) {
  if (authMode === "entra") {
    window.location.href = "/api/auth/signout";
    return;
  }
  if (authMode === "betterauth") {
    const { authClient } = await import("@/lib/auth-client");
    await authClient.signOut().catch(() => {});
    window.location.href = "/sign-in";
    return;
  }
  window.location.href = "/";
}

export function AppSidebar({ authMode }: { authMode: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [trees, setTrees] = useState<Record<string, TreeState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sort, setSort] = useState<SortMode>("name-asc");
  // Org-visible workspaces (see use-preferences `orgWorkspaces`): `allOrg` is
  // every org-visible workspace the user isn't a member of; `orgMode` picks
  // whether the sidebar shows all of them or only pinned ones.
  const [orgMode, setOrgMode] = useState<OrgWorkspacesMode>("pinned");
  const [allOrg, setAllOrg] = useState<OrgProject[]>([]);
  // Starred shortcuts (notes/folders/workspaces), in the user's saved order.
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  // Index of the favorite being dragged / dragged over (in-section reorder).
  const [favDrag, setFavDrag] = useState<number | null>(null);
  const [favOver, setFavOver] = useState<number | null>(null);
  // Row id (ws-<id> / fld-<id>) briefly flashed after a favorite reveals it.
  const [flash, setFlash] = useState<string | null>(null);
  // Number of OS files under an in-flight markdown-import drag (null = none).
  // Drives the drag ghost's document icon + count badge.
  const [fileDragCount, setFileDragCount] = useState<number | null>(null);

  const router = useRouter();
  const params = useParams();
  const activeNoteId = typeof params.noteId === "string" ? params.noteId : null;
  // The workspace whose landing page (/projects/<id>) is open, if any.
  const activeProjectId =
    typeof params.projectId === "string" ? params.projectId : null;
  // The workspace the open note belongs to, for the outline around its block.
  // Learned from a loaded tree when possible; otherwise from the note itself.
  const [noteProject, setNoteProject] = useState<
    ({ noteId: string } & CreateTarget) | null
  >(null);
  const treeNoteLocation = useMemo((): CreateTarget | null => {
    if (!activeNoteId) return null;
    for (const [pid, t] of Object.entries(trees)) {
      if (t && typeof t === "object") {
        const hit = t.notes.find((n) => n.id === activeNoteId);
        if (hit) return { projectId: pid, folderId: hit.folder_id };
      }
    }
    return null;
  }, [activeNoteId, trees]);
  useEffect(() => {
    if (!activeNoteId || treeNoteLocation || noteProject?.noteId === activeNoteId) return;
    let cancelled = false;
    getNote(activeNoteId)
      .then((n) => {
        if (!cancelled)
          setNoteProject({ noteId: activeNoteId, projectId: n.project_id, folderId: n.folder_id });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeNoteId, treeNoteLocation, noteProject?.noteId]);
  const noteLocation: CreateTarget | null =
    treeNoteLocation ??
    (noteProject?.noteId === activeNoteId && noteProject
      ? { projectId: noteProject.projectId, folderId: noteProject.folderId }
      : null);
  // The workspace or folder row last clicked in the sidebar. It targets the
  // toolbar's New note / New folder until the user opens another note or page.
  const [sidebarFocus, setSidebarFocus] = useState<CreateTarget | null>(null);
  useEffect(() => {
    setSidebarFocus(null);
  }, [activeNoteId, activeProjectId]);
  const currentProjectId =
    sidebarFocus?.projectId ?? activeProjectId ?? noteLocation?.projectId ?? null;
  // The default target for the toolbar's quick New note / New folder actions.
  const personalId = state.kind === "ready" ? state.me.personal_project_id : "";
  const anyExpanded = expanded.size > 0;
  const { openTab, tabs, setTabTitle } = useTabs();
  const confirm = useConfirm();
  const { openDock, openRootDock } = useGraphDock();
  const { openSearch } = useSearch();
  const { openSettings } = useSettings();
  const { openTrash } = useTrash();
  const { openShare } = useShare();
  const { openBrowse } = useBrowse();
  const { toast } = useToast();
  const copyLink = useCopyLink();
  // Below `md` the sidebar is an off-canvas drawer; this drives its slide + scrim.
  const { open: navOpen, setOpen: setNavOpen } = useMobileNav();

  // An open note's live (possibly unsaved) title comes from its tab, so typing
  // in the editor updates the tree name immediately — the sidebar name always
  // reflects the note's title rather than being a separate label.
  const tabTitles = useMemo(() => new Map(tabs.map((t) => [t.id, t.title])), [tabs]);

  // The floating tooltip is positioned imperatively (via ref) on every dragover
  // so pointer movement never re-renders the tree.
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dragImgRef = useRef<HTMLImageElement | null>(null);
  // Hidden file input for the "Import markdown…" menu action, plus the target
  // (project/folder) the pending pick should import into.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importTarget = useRef<{ projectId: string; folderId: string | null }>({
    projectId: "",
    folderId: null,
  });

  // Touch gestures for the mobile drawer: swipe right from the left edge to
  // open, swipe left anywhere to close. A window-level listener (rather than an
  // overlay strip) means taps on the underlying content pass through untouched.
  // Inert at md+, where the sidebar is a static rail.
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      if (window.innerWidth >= 768) return; // md+: static rail, no drawer
      const t = e.touches[0];
      if (!t) return;
      // Track a close-swipe from anywhere while open, or an open-swipe that
      // begins within 24px of the left edge while closed.
      tracking = navOpen || t.clientX <= 24;
      startX = t.clientX;
      startY = t.clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // Require a decisive, mostly-horizontal swipe so it never fights a scroll.
      if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return;
      if (navOpen && dx < 0) setNavOpen(false);
      else if (!navOpen && dx > 0) setNavOpen(true);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [navOpen, setNavOpen]);

  // Fetch /api/me. On first load this drives the whole sidebar state
  // (loading → ready / anon / error). On a background revalidate (`quiet`) it
  // only folds fresh projects/favorites into an already-ready state — it never
  // flips to a loading/error screen over a transient blip, and never disturbs
  // an anon tab. `/api/me` also accepts pending invitations, so polling it is
  // what makes a just-shared workspace appear on its own.
  const loadMe = useCallback((quiet = false) => {
    fetch("/api/me", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) {
          if (!quiet) setState({ kind: "anon" });
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const me = (await r.json()) as Me;
        setState((s) => (quiet && s.kind !== "ready" ? s : { kind: "ready", me }));
        setFavorites(me.favorites ?? []);
      })
      .catch((e) => {
        if (!quiet) setState({ kind: "error", message: String(e) });
      });
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Lock body scroll while the mobile drawer is open (mirrors ui/dialog.tsx). A
  // no-op on `md`+, where the h-screen shell never scrolls the body anyway.
  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [navOpen]);

  const loadTree = useCallback((projectId: string) => {
    setTrees((prev) => ({ ...prev, [projectId]: "loading" }));
    listTree(projectId)
      .then((t) => setTrees((prev) => ({ ...prev, [projectId]: t })))
      .catch(() => setTrees((prev) => ({ ...prev, [projectId]: "error" })));
  }, []);

  // Refetch a project's tree in place — no "loading" placeholder — so a
  // background revalidate refreshes titles/new notes without flashing the tree.
  const quietReloadTree = useCallback((projectId: string) => {
    listTree(projectId)
      .then((t) => setTrees((prev) => ({ ...prev, [projectId]: t })))
      .catch(() => {
        // Keep the stale tree on a transient failure rather than blanking it.
      });
  }, []);

  // ── Org-visible workspaces ────────────────────────────────
  const fetchOrg = useCallback(() => {
    listOrgProjects()
      .then(({ projects }) => setAllOrg(projects))
      .catch(() => setAllOrg([]));
  }, []);

  // Load org workspaces once signed in; refetch when pins change elsewhere
  // (e.g. from the Browse dialog, which broadcasts "recall:pins").
  useEffect(() => {
    if (state.kind !== "ready") return;
    fetchOrg();
    const onPins = () => fetchOrg();
    window.addEventListener("recall:pins", onPins);
    return () => window.removeEventListener("recall:pins", onPins);
  }, [state.kind, fetchOrg]);

  // Track the "pinned only / show all" preference live (Settings writes it).
  useEffect(() => {
    const read = () => setOrgMode(readPreferences().orgWorkspaces);
    read();
    window.addEventListener("recall:prefs", read);
    return () => window.removeEventListener("recall:prefs", read);
  }, []);

  // Keep the sidebar live: on tab focus / a gentle interval, pull newly shared
  // workspaces (and accepted invites) plus favorites, and refresh the trees
  // currently on screen — all without loading flashes. Paused while a drag or
  // inline create/rename is in flight so a poll never stomps an interaction.
  useRevalidate(() => {
    if (state.kind !== "ready") return;
    if (drag || favDrag !== null || renaming || creating || creatingWorkspace) return;
    loadMe(true);
    fetchOrg();
    for (const [id, t] of Object.entries(trees)) {
      if (expanded.has(id) && t && t !== "loading" && t !== "error") quietReloadTree(id);
    }
  });

  async function togglePin(id: string, pin: boolean) {
    try {
      if (pin) await pinProject(id);
      else await unpinProject(id);
    } finally {
      fetchOrg();
    }
  }

  // ── Favorites ─────────────────────────────────────────────
  const refreshFavorites = useCallback(() => {
    listFavorites()
      .then(({ favorites }) => setFavorites(favorites))
      .catch(() => {});
  }, []);

  // Seed from /api/me once signed in.
  useEffect(() => {
    if (state.kind === "ready") setFavorites(state.me.favorites ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  const favKeys = useMemo(
    () => new Set(favorites.map((f) => `${f.type}:${f.id}`)),
    [favorites],
  );
  const isFav = (type: FavoriteType, id: string) => favKeys.has(`${type}:${id}`);

  async function toggleFavorite(type: FavoriteType, id: string) {
    try {
      if (isFav(type, id)) await removeFavorite(type, id);
      else await addFavorite(type, id);
      refreshFavorites();
    } catch {
      toast("Couldn’t update favorites.", "error");
    }
  }

  function openFavorite(f: FavoriteItem) {
    if (f.type === "note") return openNote(f.id, f.label || "Untitled");
    if (f.type === "project") return revealProject(f.project_id);
    return void revealFolder(f.project_id, f.id);
  }

  // Wait a tick for expand state to render the row, then bring it into view and
  // flash it so the reveal is visible even if it was already on-screen.
  function scrollToRow(id: string) {
    setFlash(id);
    setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    }, 60);
    setTimeout(() => setFlash((cur) => (cur === id ? null : cur)), 1200);
  }

  function revealProject(projectId: string) {
    expand(projectId);
    if (trees[projectId] === undefined) loadTree(projectId);
    scrollToRow(`ws-${projectId}`);
  }

  async function revealFolder(projectId: string, folderId: string) {
    let tree = trees[projectId];
    if (!tree || typeof tree !== "object") {
      try {
        tree = await listTree(projectId);
        setTrees((prev) => ({ ...prev, [projectId]: tree as Tree }));
      } catch {
        return;
      }
    }
    // Expand the workspace + the folder's ancestor chain so it's visible.
    const byId = new Map((tree as Tree).folders.map((f) => [f.id, f]));
    const chain: string[] = [];
    let cur: string | null = folderId;
    while (cur) {
      chain.push(cur);
      cur = byId.get(cur)?.parent_id ?? null;
    }
    setExpanded((prev) => {
      const next = new Set(prev).add(projectId);
      chain.forEach((id) => next.add(id));
      persistExpanded(next);
      return next;
    });
    scrollToRow(`fld-${folderId}`);
  }

  // Locate a note in the tree ("Show in Explorer" from a tab): expand its
  // workspace + ancestor folders and flash the row. The note id is all we get,
  // so learn its project/folder from a loaded tree if possible, else fetch it.
  async function revealNote(noteId: string) {
    let projectId: string | null = null;
    let folderId: string | null = null;
    for (const [pid, t] of Object.entries(trees)) {
      if (t && typeof t === "object") {
        const hit = t.notes.find((n) => n.id === noteId);
        if (hit) {
          projectId = pid;
          folderId = hit.folder_id;
          break;
        }
      }
    }
    if (!projectId) {
      try {
        const n = await getNote(noteId);
        projectId = n.project_id;
        folderId = n.folder_id;
      } catch {
        return; // note no longer reachable (deleted / unshared)
      }
    }
    let tree = trees[projectId];
    if (!tree || typeof tree !== "object") {
      try {
        tree = await listTree(projectId);
        setTrees((prev) => ({ ...prev, [projectId as string]: tree as Tree }));
      } catch {
        return;
      }
    }
    // Expand the workspace + the note's ancestor folder chain so its row exists.
    const chain: string[] = [];
    if (folderId) {
      const byId = new Map((tree as Tree).folders.map((f) => [f.id, f]));
      let cur: string | null = folderId;
      while (cur) {
        chain.push(cur);
        cur = byId.get(cur)?.parent_id ?? null;
      }
    }
    setExpanded((prev) => {
      const next = new Set(prev).add(projectId as string);
      chain.forEach((id) => next.add(id));
      persistExpanded(next);
      return next;
    });
    scrollToRow(`note-${noteId}`);
  }

  // A tab's "Show in Explorer" reveals its note from another component, so it
  // arrives as a window event. Keep the latest revealNote in a ref (it closes
  // over trees/expanded) and register the listener once.
  const revealNoteRef = useRef(revealNote);
  revealNoteRef.current = revealNote;
  useEffect(() => {
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) void revealNoteRef.current(id);
    };
    window.addEventListener("recall:reveal-note", onReveal);
    return () => window.removeEventListener("recall:reveal-note", onReveal);
  }, []);

  // Reorder within the Favorites section — deliberately separate from the tree
  // move-DnD (startDrag/onTargetDrop), which moves items between folders.
  function onFavDragStart(e: React.DragEvent, idx: number) {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "favorite");
    setFavDrag(idx);
  }
  function onFavDragOver(e: React.DragEvent, idx: number) {
    if (favDrag === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (favOver !== idx) setFavOver(idx);
  }
  function onFavDrop(e: React.DragEvent, idx: number) {
    if (favDrag === null) return;
    e.preventDefault();
    e.stopPropagation();
    const from = favDrag;
    setFavDrag(null);
    setFavOver(null);
    if (from === idx) return;
    const next = [...favorites];
    const [moved] = next.splice(from, 1);
    next.splice(idx, 0, moved);
    setFavorites(next);
    reorderFavorites(
      next.map((f) => ({ item_type: f.type, item_id: f.id })),
    ).catch(() => refreshFavorites());
  }
  function onFavDragEnd() {
    setFavDrag(null);
    setFavOver(null);
  }

  const persistExpanded = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {
      // ignore quota errors
    }
  }, []);

  // Restore expanded ids once projects are known. Keep folder ids too (they
  // render expanded once their project's tree loads); load expanded projects.
  useEffect(() => {
    if (state.kind !== "ready") return;
    let saved: string[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]");
      if (Array.isArray(parsed)) saved = parsed.filter((x) => typeof x === "string");
    } catch {
      // ignore malformed storage
    }
    const known = new Set(state.me.projects.map((p) => p.id));
    setExpanded(new Set(saved));
    saved.filter((id) => known.has(id)).forEach((id) => loadTree(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  // Opening a workspace's landing page (/projects/<id>, e.g. from a copied
  // link) expands its row, loads its tree and flashes it — once per visit, so
  // collapsing it while the page stays open still works. Only for a workspace
  // that has a row here (a membership, or a listed org workspace); a link to
  // one you can't open reveals nothing.
  const activeHasRow =
    !!activeProjectId &&
    state.kind === "ready" &&
    (state.me.projects.some((p) => p.id === activeProjectId) ||
      (orgMode === "all" ? allOrg : allOrg.filter((o) => o.pinned)).some(
        (o) => o.id === activeProjectId,
      ));
  useEffect(() => {
    if (activeProjectId && activeHasRow) revealProject(activeProjectId);
    // Runs when the page or its row's availability changes, not on every tree
    // update revealProject closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeHasRow]);

  // Restore the saved sort order.
  useEffect(() => {
    const saved = localStorage.getItem(SORT_KEY);
    if (saved && SORT_OPTIONS.some((o) => o.mode === saved)) setSort(saved as SortMode);
  }, []);

  // Markdown-import drag: window-level fallback for when files are dragged
  // outside a sidebar drop target (those stopPropagation, so this won't fire
  // over them). Keeps the ghost following the cursor with no highlight, and —
  // importantly — preventDefault stops the browser from navigating away to open
  // a file dropped anywhere in the app. Clears on drop / leaving the window.
  useEffect(() => {
    const onOver = (e: DragEvent) => {
      if (!e.dataTransfer || !isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setFileDragCount(fileCount(e.dataTransfer));
      setDropTarget(null);
      moveGhost(e.clientX, e.clientY);
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer && isFileDrag(e.dataTransfer)) e.preventDefault();
      setFileDragCount(null);
      setDropTarget(null);
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setFileDragCount(null); // pointer left the window
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onLeave);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onLeave);
    };
    // moveGhost reads only a ref and the setters are stable — safe with [].
  }, []);

  function changeSort(mode: SortMode) {
    setSort(mode);
    try {
      localStorage.setItem(SORT_KEY, mode);
    } catch {
      // ignore quota errors
    }
  }

  // Expand every workspace and folder. Loads any not-yet-fetched trees first
  // (reusing cached ones), then expands all workspace + folder ids at once.
  async function expandAll() {
    if (state.kind !== "ready") return;
    const ids = state.me.projects.map((p) => p.id);
    try {
      const loaded = await Promise.all(
        ids.map(async (id) => {
          const cur = trees[id];
          const t = cur && typeof cur === "object" ? cur : await listTree(id);
          return [id, t] as const;
        }),
      );
      setTrees((prev) => {
        const next = { ...prev };
        for (const [id, t] of loaded) next[id] = t;
        return next;
      });
      const next = new Set<string>(ids);
      for (const [, t] of loaded) for (const f of t.folders) next.add(f.id);
      setExpanded(next);
      persistExpanded(next);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  function collapseAll() {
    const next = new Set<string>();
    setExpanded(next);
    persistExpanded(next);
  }

  function expand(id: string) {
    setExpanded((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      persistExpanded(next);
      return next;
    });
  }

  function toggle(id: string, onOpen?: () => void) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        onOpen?.();
      }
      persistExpanded(next);
      return next;
    });
  }

  function openNote(id: string, title: string) {
    openTab(id, title);
    router.push(`/notes/${id}`);
    setNavOpen(false); // dismiss the mobile drawer once you're headed to a note
  }

  // The workspace landing page. Clicking the row itself still only toggles.
  function openWorkspace(id: string) {
    router.push(`/projects/${id}`);
    setNavOpen(false);
  }

  // ── Create ────────────────────────────────────────────────
  async function newNote(projectId: string, folderId: string | null) {
    try {
      const n = await createNote(projectId, "Untitled", "", folderId);
      expand(projectId);
      if (folderId) expand(folderId);
      loadTree(projectId);
      openNote(n.id, n.title);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  // Import one or more markdown files as notes into a project + folder, then
  // reveal them. Opens the note when a single file was imported.
  async function importFiles(
    files: File[],
    projectId: string,
    folderId: string | null,
  ) {
    const { supported, unsupported } = partitionFiles(files);
    try {
      const created = supported.length
        ? await importMarkdownFiles(supported, projectId, folderId)
        : [];
      if (created.length > 0) {
        expand(projectId);
        if (folderId) expand(folderId);
        loadTree(projectId);
        if (created.length === 1) openNote(created[0].id, created[0].title);
      }
      reportImport(created.length, unsupported.length);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  // A single toast summarizing an import: errors when nothing was importable,
  // notes the skipped (unsupported) count, and confirms a bulk import.
  function reportImport(created: number, skipped: number) {
    if (created === 0 && skipped > 0) {
      toast(
        `Can't import ${skipped === 1 ? "that file" : "those files"} — only ` +
          `markdown (.md) and text (.txt) are supported.`,
        "error",
      );
    } else if (skipped > 0) {
      toast(
        `Imported ${created} note${created === 1 ? "" : "s"} · skipped ` +
          `${skipped} unsupported file${skipped === 1 ? "" : "s"}.`,
      );
    } else if (created > 0) {
      toast(`Imported ${created} note${created === 1 ? "" : "s"}.`);
    }
  }

  // Menu path: remember the target, then open the OS file picker.
  function startImport(projectId: string, folderId: string | null) {
    importTarget.current = { projectId, folderId };
    fileInputRef.current?.click();
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file later
    const { projectId, folderId } = importTarget.current;
    if (projectId) void importFiles(files, projectId, folderId);
  }

  function startNewFolder(projectId: string, parentId: string | null) {
    if (trees[projectId] === undefined) loadTree(projectId);
    expand(projectId);
    if (parentId) expand(parentId);
    setCreating({ projectId, parentId });
  }

  async function commitCreateFolder(value: string) {
    const c = creating;
    setCreating(null);
    const name = value.trim();
    if (!c || !name) return;
    try {
      await createFolder(c.projectId, name, c.parentId);
      loadTree(c.projectId);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  // A "workspace" is a top-level project in the backend (createProject); the
  // term is only different in the UI.
  async function createWorkspace(value: string) {
    const name = value.trim();
    setCreatingWorkspace(false);
    if (!name) return;
    try {
      const p = await createProject(name);
      setState((s) =>
        s.kind === "ready"
          ? { kind: "ready", me: { ...s.me, projects: [...s.me.projects, p] } }
          : s,
      );
      expand(p.id);
      loadTree(p.id);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  // ── Rename ────────────────────────────────────────────────
  // Patch one project's cached tree in place — no refetch, no loading flash.
  const patchTree = (projectId: string, fn: (t: Tree) => Tree) =>
    setTrees((prev) => {
      const t = prev[projectId];
      return t && typeof t === "object" ? { ...prev, [projectId]: fn(t) } : prev;
    });

  async function commitRename(value: string) {
    const r = renaming;
    setRenaming(null);
    const name = value.trim();
    if (!r || !name) return;
    try {
      if (r.kind === "note") {
        await updateNote(r.id, { title: name });
        setTabTitle(r.id, name); // refresh the tab + the sidebar's live overlay
        patchTree(r.projectId, (t) => ({
          ...t,
          notes: t.notes.map((n) => (n.id === r.id ? { ...n, title: name } : n)),
        }));
      } else if (r.kind === "folder") {
        await renameFolder(r.id, name);
        patchTree(r.projectId, (t) => ({
          ...t,
          folders: t.folders.map((f) => (f.id === r.id ? { ...f, name } : f)),
        }));
      } else {
        await renameProject(r.id, name);
        setState((s) =>
          s.kind === "ready"
            ? {
                kind: "ready",
                me: {
                  ...s.me,
                  projects: s.me.projects.map((p) =>
                    p.id === r.id ? { ...p, name } : p,
                  ),
                },
              }
            : s,
        );
      }
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  // ── Copy / delete ─────────────────────────────────────────
  async function copyNode(kind: "folder" | "note", id: string, projectId: string) {
    try {
      if (kind === "folder") await copyFolder(id);
      else await copyNote(id);
      loadTree(projectId);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  async function deleteNoteNode(id: string, projectId: string) {
    try {
      await deleteNote(id);
      loadTree(projectId);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  async function deleteFolderNode(folder: FolderSummary, tree: Tree) {
    const hasContents =
      tree.folders.some((f) => f.parent_id === folder.id) ||
      tree.notes.some((n) => n.folder_id === folder.id);
    if (
      hasContents &&
      !(await confirm({
        title: `Delete "${folder.name}"?`,
        description:
          "This folder and everything inside it moves to Trash — you can restore it later.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    try {
      await deleteFolder(folder.id);
      loadTree(folder.project_id);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  async function deleteProjectNode(p: Project) {
    if (
      !(await confirm({
        title: `Delete "${p.name}"?`,
        description:
          "This workspace and everything inside it moves to Trash — you can restore it later.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    try {
      await deleteProject(p.id);
      setState((s) =>
        s.kind === "ready"
          ? {
              kind: "ready",
              me: { ...s.me, projects: s.me.projects.filter((x) => x.id !== p.id) },
            }
          : s,
      );
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  // ── Context menu ──────────────────────────────────────────
  function openMenu(
    e: React.MouseEvent,
    items: MenuItem[],
  ) {
    e.preventDefault();
    e.stopPropagation();
    if (items.length === 0) return;
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function projectMenu(p: Project): MenuItem[] {
    // "Open graph" is a read view — available to every member (incl. viewers).
    const items: MenuItem[] = [
      {
        label: "Open workspace",
        icon: <FolderOpen size={15} />,
        onSelect: () => openWorkspace(p.id),
      },
      {
        label: "Copy link",
        icon: <LinkIcon size={15} />,
        onSelect: () => void copyLink("project", p.id),
      },
      {
        label: "Open graph",
        icon: <Waypoints size={15} />,
        onSelect: () => openDock(p.id),
      },
      {
        label: "Export workspace",
        icon: <Download size={15} />,
        onSelect: () => downloadZip(projectZipPath(p.id)),
      },
    ];
    // Members: non-owners get a read-only view of who's in the workspace (and who
    // to ask for access). Owners get "Share…" below — the same dialog, but with
    // the invite / role controls enabled.
    if (!p.is_personal && p.role !== "owner")
      items.push({
        label: "Members",
        icon: <Users size={15} />,
        onSelect: () =>
          openShare({ id: p.id, name: p.name, org_access: p.org_access }),
      });
    if (!p.is_personal)
      items.push({
        label: isFav("project", p.id) ? "Remove from favorites" : "Add to favorites",
        icon: <Star size={15} />,
        onSelect: () => toggleFavorite("project", p.id),
      });
    if (canWrite(p.role)) {
      items.push({ divider: true });
      items.push({ label: "New note", icon: <FilePlus size={15} />, onSelect: () => newNote(p.id, null) });
      items.push({ label: "New folder", icon: <FolderPlus size={15} />, onSelect: () => startNewFolder(p.id, null) });
      items.push({ label: "Import markdown…", icon: <Upload size={15} />, onSelect: () => startImport(p.id, null) });
    }
    if (p.role === "owner") {
      items.push({ divider: true });
      if (!p.is_personal)
        items.push({
          label: "Share…",
          icon: <UserPlus size={15} />,
          onSelect: () =>
            openShare({ id: p.id, name: p.name, org_access: p.org_access }),
        });
      items.push({
        label: "Rename",
        icon: <Pencil size={15} />,
        onSelect: () => setRenaming({ kind: "project", id: p.id, projectId: p.id }),
      });
      if (!p.is_personal)
        items.push({
          label: "Delete",
          icon: <Trash2 size={15} />,
          danger: true,
          onSelect: () => deleteProjectNode(p),
        });
    }
    return items;
  }

  // Context menu for an org-visible workspace you're viewing (not a member of):
  // read actions only, plus pin/unpin to keep it in your sidebar.
  function orgProjectMenu(p: Project, pinned: boolean): MenuItem[] {
    return [
      {
        label: "Open workspace",
        icon: <FolderOpen size={15} />,
        onSelect: () => openWorkspace(p.id),
      },
      {
        label: "Copy link",
        icon: <LinkIcon size={15} />,
        onSelect: () => void copyLink("project", p.id),
      },
      { label: "Open graph", icon: <Waypoints size={15} />, onSelect: () => openDock(p.id) },
      {
        label: "Export workspace",
        icon: <Download size={15} />,
        onSelect: () => downloadZip(projectZipPath(p.id)),
      },
      {
        label: "Members",
        icon: <Users size={15} />,
        onSelect: () =>
          openShare({ id: p.id, name: p.name, org_access: p.org_access }),
      },
      {
        label: isFav("project", p.id) ? "Remove from favorites" : "Add to favorites",
        icon: <Star size={15} />,
        onSelect: () => toggleFavorite("project", p.id),
      },
      { divider: true },
      pinned
        ? { label: "Unpin", icon: <PinOff size={15} />, onSelect: () => void togglePin(p.id, false) }
        : {
            label: "Pin to sidebar",
            icon: <Pin size={15} />,
            onSelect: () => void togglePin(p.id, true),
          },
    ];
  }

  function folderMenu(f: FolderSummary, p: Project, tree: Tree): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: "Export folder",
        icon: <Download size={15} />,
        onSelect: () => downloadZip(folderZipPath(f.id)),
      },
    ];
    items.push({
      label: isFav("folder", f.id) ? "Remove from favorites" : "Add to favorites",
      icon: <Star size={15} />,
      onSelect: () => toggleFavorite("folder", f.id),
    });
    if (!canWrite(p.role)) return items;
    items.push(
      { divider: true },
      { label: "New note", icon: <FilePlus size={15} />, onSelect: () => newNote(p.id, f.id) },
      { label: "New folder", icon: <FolderPlus size={15} />, onSelect: () => startNewFolder(p.id, f.id) },
      { label: "Import markdown…", icon: <Upload size={15} />, onSelect: () => startImport(p.id, f.id) },
      { divider: true },
      {
        label: "Rename",
        icon: <Pencil size={15} />,
        onSelect: () => setRenaming({ kind: "folder", id: f.id, projectId: p.id }),
      },
      { label: "Make a copy", icon: <Copy size={15} />, onSelect: () => copyNode("folder", f.id, p.id) },
      { divider: true },
      {
        label: "Delete",
        icon: <Trash2 size={15} />,
        danger: true,
        onSelect: () => deleteFolderNode(f, tree),
      },
    );
    return items;
  }

  function noteMenu(n: NoteSummary, p: Project): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: "Copy link",
        icon: <LinkIcon size={15} />,
        onSelect: () => void copyLink("note", n.id),
      },
      {
        label: "Download .md",
        icon: <Download size={15} />,
        onSelect: () => void downloadNoteMarkdown(n.id),
      },
    ];
    items.push({
      label: isFav("note", n.id) ? "Remove from favorites" : "Add to favorites",
      icon: <Star size={15} />,
      onSelect: () => toggleFavorite("note", n.id),
    });
    if (!canWrite(p.role)) return items;
    items.push(
      { divider: true },
      {
        label: "Rename",
        icon: <Pencil size={15} />,
        onSelect: () => setRenaming({ kind: "note", id: n.id, projectId: p.id }),
      },
      { label: "Make a copy", icon: <Copy size={15} />, onSelect: () => copyNode("note", n.id, p.id) },
      { divider: true },
      {
        label: "Delete",
        icon: <Trash2 size={15} />,
        danger: true,
        onSelect: () => deleteNoteNode(n.id, p.id),
      },
    );
    return items;
  }

  // ── Drag and drop ─────────────────────────────────────────
  function startDrag(e: React.DragEvent, d: Drag) {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", d.id);
    if (!dragImgRef.current) {
      const img = new Image();
      img.src = TRANSPARENT_IMG;
      dragImgRef.current = img;
    }
    e.dataTransfer.setDragImage(dragImgRef.current, 0, 0);
    setDrag(d);
    moveGhost(e.clientX, e.clientY);
  }

  function moveGhost(x: number, y: number) {
    const el = ghostRef.current;
    if (!el) return;
    el.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
    el.style.visibility = "visible"; // revealed once positioned (avoids a corner flash)
  }

  // Can the current drag land on this project + folder (null = project root)?
  function canDrop(p: Project, folderId: string | null): boolean {
    if (!drag || !canWrite(p.role)) return false;
    if (drag.kind === "note") return true; // notes may cross projects / folders
    // Folders can cross projects too, but never onto themselves or into their
    // own subtree (a same-project descendant).
    if (drag.id === folderId) return false;
    const tree = trees[p.id];
    if (tree && typeof tree === "object" && inSubtree(tree, drag.id, folderId)) return false;
    return true;
  }

  function onTargetDragOver(e: React.DragEvent, p: Project, folderId: string | null) {
    if (isFileDrag(e.dataTransfer)) {
      // Only writable targets accept an import; otherwise let it bubble to the
      // window handler, which shows the generic "drop on a folder" hint.
      if (!canWrite(p.role)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setFileDragCount(fileCount(e.dataTransfer));
      const id = folderId ?? p.id;
      if (dropTarget !== id) setDropTarget(id);
      moveGhost(e.clientX, e.clientY);
      return;
    }
    if (!canDrop(p, folderId)) return; // bubbles to <aside>, which clears the highlight
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    moveGhost(e.clientX, e.clientY);
    const id = folderId ?? p.id;
    if (dropTarget !== id) setDropTarget(id);
  }

  async function onTargetDrop(e: React.DragEvent, p: Project, folderId: string | null) {
    if (isFileDrag(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const allowed = canWrite(p.role);
      endDrag(); // clears the highlight + drag ghost
      if (allowed) await importFiles(files, p.id, folderId);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const d = drag;
    endDrag();
    if (!d || !canDrop(p, folderId)) return;
    try {
      if (d.kind === "note") await moveNote(d.id, { projectId: p.id, folderId });
      else await moveFolder(d.id, { projectId: p.id, parentId: folderId });
    } finally {
      if (d.projectId !== p.id) loadTree(d.projectId); // refresh the source too
      loadTree(p.id);
      expand(p.id);
      if (folderId) expand(folderId);
    }
  }

  function endDrag() {
    setDrag(null);
    setDropTarget(null);
    setFileDragCount(null);
  }

  // Destination name for the floating drag tooltip. Keyed on dropTarget (set for
  // both internal note/folder drags and file-import drags), not on `drag`.
  function destName(): string | null {
    if (!dropTarget || state.kind !== "ready") return null;
    const proj = state.me.projects.find((p) => p.id === dropTarget);
    if (proj) return proj.name;
    for (const t of Object.values(trees)) {
      if (t && typeof t === "object") {
        const f = t.folders.find((x) => x.id === dropTarget);
        if (f) return f.name;
      }
    }
    return null;
  }

  // ── Recursive render ──────────────────────────────────────
  const renderNote = (p: Project, n: NoteSummary): ReactNode => {
    // Only the open note being edited overrides the stored title (its live,
    // possibly-unsaved title); every other row uses the server's title.
    const live = (n.id === activeNoteId ? tabTitles.get(n.id) : undefined) ?? n.title;
    const label = live || "Untitled";
    if (renaming?.id === n.id)
      return (
        <li key={n.id} className="px-2 py-1">
          <InlineInput
            initial={live}
            commitOnBlur
            onCommit={commitRename}
            onCancel={() => setRenaming(null)}
          />
        </li>
      );
    return (
      <li key={n.id} id={`note-${n.id}`}>
        <div
          className={cn(
            "group flex items-center rounded-md text-sm",
            n.id === activeNoteId
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
            drag?.id === n.id && "opacity-40",
            flash === `note-${n.id}` && "recall-flash",
          )}
        >
          <button
            type="button"
            draggable
            onDragStart={(e) => startDrag(e, { kind: "note", id: n.id, title: label, projectId: p.id })}
            onDragEnd={endDrag}
            onClick={() => openNote(n.id, label)}
            onContextMenu={(e) => openMenu(e, noteMenu(n, p))}
            className="flex min-w-0 flex-1 items-center px-2 py-1 text-left"
          >
            <MarqueeText text={label} />
          </button>
          <RowMenuButton
            onOpen={(e) => openMenu(e, noteMenu(n, p))}
            label={`Actions for ${label}`}
          />
        </div>
      </li>
    );
  };

  const renderFolder = (p: Project, tree: Tree, f: FolderSummary): ReactNode => {
    const isOpen = expanded.has(f.id);
    const isDrop = dropTarget === f.id;
    const isRenaming = renaming?.id === f.id;
    return (
      <li
        key={f.id}
        id={`fld-${f.id}`}
        draggable={canWrite(p.role) && !isRenaming}
        onDragStart={(e) => startDrag(e, { kind: "folder", id: f.id, title: f.name, projectId: p.id })}
        onDragEnd={endDrag}
        onDragOver={(e) => onTargetDragOver(e, p, f.id)}
        onDrop={(e) => onTargetDrop(e, p, f.id)}
        onContextMenu={(e) => openMenu(e, folderMenu(f, p, tree))}
        className={cn(
          "rounded-md",
          isDrop && "bg-sidebar-accent ring-1 ring-primary/50",
          flash === `fld-${f.id}` && "recall-flash",
        )}
      >
        <div className="group flex items-center rounded-md pr-1 hover:bg-sidebar-accent">
          {isRenaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5">
              <ChevronRight size={16} className="shrink-0 text-muted-foreground opacity-40" />
              <InlineInput
                initial={f.name}
                commitOnBlur
                onCommit={commitRename}
                onCancel={() => setRenaming(null)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSidebarFocus({ projectId: p.id, folderId: f.id });
                toggle(f.id);
              }}
              className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-sm"
            >
              <ChevronRight
                size={16}
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform",
                  isOpen && "rotate-90",
                )}
              />
              <MarqueeText text={f.name} />
            </button>
          )}
          {canWrite(p.role) && !isRenaming && (
            <button
              type="button"
              onClick={() => newNote(p.id, f.id)}
              aria-label={`New note in ${f.name}`}
              title="New note"
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground group-hover:opacity-100 max-md:hidden"
            >
              <Plus size={16} />
            </button>
          )}
          {!isRenaming && (
            <RowMenuButton
              onOpen={(e) => openMenu(e, folderMenu(f, p, tree))}
              label={`Actions for ${f.name}`}
            />
          )}
        </div>
        {isOpen && (
          <ul className="ml-3 border-l pl-1">{renderLevel(p, tree, f.id)}</ul>
        )}
      </li>
    );
  };

  const cmp = comparators(sort);

  // Org workspaces to show below the membership list: all of them, or just the
  // ones the user has pinned (default), per the Settings preference.
  const orgShown = orgMode === "all" ? allOrg : allOrg.filter((o) => o.pinned);

  // Personal workspace is always first and exempt from sort/favorites; the rest
  // of the memberships sort normally below Favorites.
  const me = state.kind === "ready" ? state.me : null;
  const personalProject = me?.projects.find((p) => p.is_personal) ?? null;
  const workspaceProjects = me ? me.projects.filter((p) => !p.is_personal) : [];

  // Toolbar New note / New folder target (see lib/create-target.ts). Only
  // memberships with editor+ rights qualify; org-visible workspaces you only
  // view fall back to Personal.
  const createTarget = resolveCreateTarget({
    focus: sidebarFocus,
    note: noteLocation,
    workspacePage: activeProjectId,
    personalId,
    canWrite: (id) => !!me?.projects.some((p) => p.id === id && canWrite(p.role)),
    folderExists: (pid, fid) => {
      const t = trees[pid];
      return !t || typeof t !== "object" || t.folders.some((f) => f.id === fid);
    },
  });
  const createTargetProject = me?.projects.find((p) => p.id === createTarget.projectId);
  const createTargetTree = trees[createTarget.projectId];
  const createTargetLabel = describeTarget(
    createTargetProject?.name ?? "Personal",
    createTarget.folderId,
    createTargetTree && typeof createTargetTree === "object" ? createTargetTree.folders : undefined,
  );

  const renderLevel = (p: Project, tree: Tree, parentId: string | null): ReactNode => {
    const folders = tree.folders
      .filter((f) => f.parent_id === parentId)
      .sort(cmp.folders);
    const notes = tree.notes.filter((n) => n.folder_id === parentId).sort(cmp.notes);
    const creatingHere =
      creating && creating.projectId === p.id && creating.parentId === parentId;
    return (
      <>
        {creatingHere && (
          <li className="px-2 pb-1">
            <InlineInput
              placeholder="Folder name…"
              onCommit={commitCreateFolder}
              onCancel={() => setCreating(null)}
            />
          </li>
        )}
        {folders.map((f) => renderFolder(p, tree, f))}
        {notes.map((n) => renderNote(p, n))}
        {!creatingHere && folders.length === 0 && notes.length === 0 && parentId === null && (
          <li className="px-2 py-1 text-xs text-muted-foreground">No notes</li>
        )}
      </>
    );
  };

  // One workspace row + its lazily-loaded tree. Used for both memberships and
  // org-visible workspaces (`isOrg`): org rows get a globe badge and a
  // read-only pin/unpin menu; their viewer role already hides write affordances.
  const renderProject = (p: Project, isOrg: boolean, pinned = false): ReactNode => {
    const isDropTarget = dropTarget === p.id;
    const tree = trees[p.id];
    const isRenaming = renaming?.kind === "project" && renaming.id === p.id;
    return (
      <li
        key={p.id}
        id={`ws-${p.id}`}
        onDragOver={(e) => onTargetDragOver(e, p, null)}
        onDrop={(e) => onTargetDrop(e, p, null)}
        onContextMenu={(e) =>
          openMenu(e, isOrg ? orgProjectMenu(p, pinned) : projectMenu(p))
        }
        className={cn(
          // p-1 always, so the outline below has breathing room around the
          // rows and opening a note elsewhere doesn't shift the list.
          "rounded-lg p-1",
          isDropTarget && "bg-sidebar-accent ring-1 ring-primary/50",
          // A quiet outline around the workspace holding the open note (or
          // whose page is open), distinct from the row highlight.
          !isDropTarget && p.id === currentProjectId && "ring-1 ring-inset ring-border",
          flash === `ws-${p.id}` && "recall-flash",
        )}
      >
        <div
          className={cn(
            "group flex items-center rounded-md pr-1 hover:bg-sidebar-accent",
            // Its landing page is open (highlighted like the active note).
            p.id === activeProjectId && "bg-sidebar-accent text-foreground",
          )}
          aria-current={p.id === activeProjectId ? "page" : undefined}
        >
          {isRenaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5">
              <ChevronRight size={16} className="shrink-0 text-muted-foreground opacity-40" />
              <InlineInput
                initial={p.name}
                commitOnBlur
                onCommit={commitRename}
                onCancel={() => setRenaming(null)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSidebarFocus({ projectId: p.id, folderId: null });
                toggle(p.id, () => tree === undefined && loadTree(p.id));
              }}
              className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-sm"
            >
              <ChevronRight
                size={16}
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform",
                  expanded.has(p.id) && "rotate-90",
                )}
              />
              <MarqueeText text={p.name} />
              {p.is_personal ? (
                <span className="ml-1 shrink-0 text-xs text-muted-foreground">
                  personal
                </span>
              ) : p.org_access === "viewer" || (p.member_count ?? 0) > 1 ? (
                // Two independent facts, composed when both hold: org-wide
                // visibility (globe) and having collaborators (people). This is
                // why an org-visible team workspace reads as both, not just a
                // detached globe.
                <span className="ml-1 flex shrink-0 items-center gap-1 text-muted-foreground">
                  {p.org_access === "viewer" && (
                    <Globe size={13} aria-label="Visible to your organisation" />
                  )}
                  {(p.member_count ?? 0) > 1 && (
                    <Users size={13} aria-label="Shared with members" />
                  )}
                </span>
              ) : null}
            </button>
          )}
          {canWrite(p.role) && !isRenaming && (
            <button
              type="button"
              onClick={() => newNote(p.id, null)}
              aria-label={`New note in ${p.name}`}
              title="New note"
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground group-hover:opacity-100 max-md:hidden"
            >
              <Plus size={16} />
            </button>
          )}
          {!isRenaming && (
            <RowMenuButton
              onOpen={(e) =>
                openMenu(e, isOrg ? orgProjectMenu(p, pinned) : projectMenu(p))
              }
              label={`Actions for ${p.name}`}
            />
          )}
        </div>

        {expanded.has(p.id) && (
          <ul className="ml-3 border-l pl-1">
            {tree === "loading" ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">loading…</li>
            ) : tree === "error" ? (
              <li className="px-2 py-1 text-xs text-destructive">failed to load</li>
            ) : tree === undefined ? null : (
              renderLevel(p, tree, null)
            )}
          </ul>
        )}
      </li>
    );
  };

  // A flat favorite shortcut row: click opens (note) or reveals (folder/
  // workspace) in the tree; the filled star unfavorites; drag reorders.
  const renderFavoriteRow = (f: FavoriteItem, idx: number): ReactNode => (
    <li
      key={`${f.type}:${f.id}`}
      draggable
      onDragStart={(e) => onFavDragStart(e, idx)}
      onDragOver={(e) => onFavDragOver(e, idx)}
      onDrop={(e) => onFavDrop(e, idx)}
      onDragEnd={onFavDragEnd}
      className={cn(
        "rounded-md",
        favDrag === idx && "opacity-40",
        favOver === idx && favDrag !== idx && "ring-1 ring-primary/50",
      )}
    >
      <div className="group flex items-center rounded-md pr-1 hover:bg-sidebar-accent">
        <button
          type="button"
          onClick={() => openFavorite(f)}
          className="flex min-w-0 flex-1 items-center px-2 py-1 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          <MarqueeText text={f.label || "Untitled"} />
        </button>
        <button
          type="button"
          onClick={() => toggleFavorite(f.type, f.id)}
          aria-label="Remove from favorites"
          title="Remove from favorites"
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground group-hover:opacity-100 max-md:opacity-100"
        >
          <Star size={14} className="fill-current" />
        </button>
      </div>
    </li>
  );

  return (
    <>
      {/* Mobile scrim behind the drawer; tap to dismiss. Inert at md+. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          aria-hidden
          onClick={() => setNavOpen(false)}
        />
      )}
    <aside
      className={cn(
        "flex h-screen shrink-0 flex-col border-r border-tab-border bg-sidebar",
        // Below md: an off-canvas drawer that slides in from the left.
        "fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transition-transform duration-200 ease-out",
        navOpen ? "translate-x-0" : "-translate-x-full",
        // md+: the static rail, a fixed 288px.
        "md:static md:z-auto md:w-72 md:max-w-none md:translate-x-0 md:transition-none",
      )}
      // Clears the highlight when the cursor is over the sidebar but not a valid
      // drop target (targets call stopPropagation, so this only fires elsewhere).
      onDragOver={(e) => {
        const file = isFileDrag(e.dataTransfer);
        if (!drag && !file) return;
        e.preventDefault();
        if (file) {
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setFileDragCount(fileCount(e.dataTransfer));
        }
        moveGhost(e.clientX, e.clientY);
        if (dropTarget !== null) setDropTarget(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        endDrag();
      }}
    >
      {/* Band 1 — aligns with the editor tab bar (h-9). On mobile it drops to
          text-base to match the top bar's wordmark (the em-sized mark scales
          with it); the desktop rail keeps text-lg. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-4 text-base font-semibold tracking-tight md:text-lg">
        {/* Theme-aware re:call triangle mark (same as sign-in). Sized in em so it
            tracks the wordmark and stays within the h-9 band. */}
        <span className="recall-logo size-[1.1em] shrink-0" aria-hidden>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12.00,0.94 L23.70,22.00 L5.45,22.00 L6.56,20.00 L20.30,20.00 L12.00,5.06 L2.59,22.00 L0.30,22.00Z"
              fill="var(--foreground)"
            />
          </svg>
        </span>
        re:call
      </div>

      {/* Band 2 — toolbar; aligns with the note header ribbon (h-11). New note /
          New folder create where you're working (createTarget: the last clicked
          workspace/folder, else the open note's folder, else Personal); New
          workspace makes a new top-level (shareable) one. */}
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        {state.kind === "ready" && (
          <>
            {/* Group 1 — create */}
            <button
              type="button"
              onClick={() => setCreatingWorkspace(true)}
              aria-label="New workspace"
              title="New workspace"
              className={TOOLBAR_BTN}
            >
              <SquarePlus size={20} />
            </button>
            <button
              type="button"
              onClick={() => startNewFolder(createTarget.projectId, createTarget.folderId)}
              aria-label={`New folder in ${createTargetLabel}`}
              title={`New folder in ${createTargetLabel}`}
              className={TOOLBAR_BTN}
            >
              <FolderPlus size={20} />
            </button>
            <button
              type="button"
              onClick={() => newNote(createTarget.projectId, createTarget.folderId)}
              aria-label={`New note in ${createTargetLabel}`}
              title={`New note in ${createTargetLabel}`}
              className={TOOLBAR_BTN}
            >
              <FilePlus size={20} />
            </button>

            <div className={TOOLBAR_DIVIDER} aria-hidden />

            {/* Group 2 — explore */}
            <button
              type="button"
              onClick={() => openRootDock()}
              aria-label="Open graph of all workspaces"
              title="Graph (all workspaces)"
              className={TOOLBAR_BTN}
            >
              <Network size={20} />
            </button>
            <button
              type="button"
              onClick={() => openSearch()}
              aria-label="Search"
              title="Search (Ctrl/⌘K)"
              className={TOOLBAR_BTN}
            >
              <Search size={20} />
            </button>
            <button
              type="button"
              onClick={() => openBrowse()}
              aria-label="Browse organisation workspaces"
              title="Browse workspaces"
              className={TOOLBAR_BTN}
            >
              <Compass size={20} />
            </button>

            <div className={TOOLBAR_DIVIDER} aria-hidden />

            {/* Group 3 — view */}
            <button
              type="button"
              onClick={() => (anyExpanded ? collapseAll() : void expandAll())}
              aria-label={anyExpanded ? "Collapse all" : "Expand all"}
              title={anyExpanded ? "Collapse all" : "Expand all"}
              className={TOOLBAR_BTN}
            >
              {anyExpanded ? (
                <ChevronsDownUp size={20} />
              ) : (
                <ChevronsUpDown size={20} />
              )}
            </button>
            <NoteMenu
              trigger={<ArrowUpDown size={20} />}
              label="Change sort order"
              align="right"
              items={SORT_OPTIONS.flatMap((o, i) => {
                const item = {
                  label: o.label,
                  active: sort === o.mode,
                  onClick: () => changeSort(o.mode),
                };
                // Divider whenever the category (name/modified/created) changes.
                const newGroup =
                  i > 0 &&
                  o.mode.split("-")[0] !== SORT_OPTIONS[i - 1].mode.split("-")[0];
                return newGroup ? [{ divider: true as const }, item] : [item];
              })}
            />
          </>
        )}
      </div>

      <nav className="thin-scrollbar flex-1 overflow-y-auto px-2 pt-2">
        {creatingWorkspace && (
          <div className="px-2 pb-1">
            <InlineInput
              placeholder="Workspace name…"
              onCommit={createWorkspace}
              onCancel={() => setCreatingWorkspace(false)}
            />
          </div>
        )}

        {state.kind === "ready" ? (
          <>
            {/* Personal — always first, exempt from sort and favorites. */}
            {personalProject && (
              <ul className="space-y-0.5">{renderProject(personalProject, false)}</ul>
            )}

            {/* ⭐ Favorites — starred shortcuts, in the user's drag order. */}
            {favorites.length > 0 && (
              <div className="mt-3">
                <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                  Favorites
                </div>
                <ul className="space-y-0.5">
                  {favorites.map((f, i) => renderFavoriteRow(f, i))}
                </ul>
              </div>
            )}

            {/* Workspaces — the rest of your memberships, sorted. */}
            <ul className="mt-3 space-y-0.5">
              {[...workspaceProjects]
                .sort(cmp.projects)
                .map((p) => renderProject(p, false))}
            </ul>

            {/* Organisation — org-visible workspaces (pinned / show all). */}
            {orgShown.length > 0 && (
              <div className="mt-3">
                <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                  Organisation
                </div>
                <ul className="space-y-0.5">
                  {orgShown.map((o) => renderProject(orgToProject(o), true, o.pinned))}
                </ul>
              </div>
            )}
          </>
        ) : state.kind === "loading" ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">loading…</div>
        ) : state.kind === "anon" ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Sign in to see folders
          </div>
        ) : (
          <div className="px-2 py-1.5 text-xs text-destructive">{state.message}</div>
        )}
      </nav>

      {/* On phones the drawer sits at the screen's left edge, so the account
          name/email needs extra left + bottom room to clear the rounded corner;
          `max(…, env())` also tracks a real safe-area inset in an installed PWA.
          Desktop keeps the plain p-3. */}
      <div className="border-t p-3 max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-md:pl-[max(1.25rem,env(safe-area-inset-left))]">
        {state.kind === "ready" ? (
          <div className="flex items-center gap-1 px-1">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {state.me.user.name ?? state.me.user.upn}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {state.me.user.upn}
              </div>
            </div>
            <NoteMenu
              side="top"
              align="right"
              label="Account menu"
              trigger={<MoreHorizontal size={18} />}
              items={[
                {
                  label: "Settings",
                  icon: <Settings size={15} />,
                  onClick: openSettings,
                },
                {
                  label: "Trash",
                  icon: <Trash2 size={15} />,
                  onClick: openTrash,
                },
                { divider: true },
                {
                  label: "Log out",
                  icon: <LogOut size={15} />,
                  onClick: () => signOut(authMode),
                },
              ]}
            />
          </div>
        ) : state.kind === "anon" ? (
          <a
            href={authMode === "entra" ? "/api/auth/signin" : "/sign-in"}
            className={cn(buttonVariants({ size: "sm" }), "w-full")}
          >
            {authMode === "entra" ? "Log in with Microsoft" : "Log in"}
          </a>
        ) : (
          <div className="px-1 text-xs text-muted-foreground">…</div>
        )}
      </div>

      {/* Floating drag tooltip. For an internal note/folder drag: the item title
          + destination. For a markdown-import file drag: a document icon with a
          count badge + destination. */}
      {(drag || fileDragCount !== null) && (
        <div
          ref={ghostRef}
          style={{ visibility: "hidden" }}
          className="pointer-events-none fixed left-0 top-0 z-50 flex max-w-xs items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-md"
        >
          {drag ? (
            <div className="min-w-0">
              <div className="truncate font-semibold text-foreground">{drag.title}</div>
              <div className="truncate text-muted-foreground">
                {destName() ? <>Move to &ldquo;{destName()}&rdquo;</> : <>Drag to a folder…</>}
              </div>
            </div>
          ) : (
            <>
              <span className="relative flex shrink-0 items-center justify-center">
                <Files size={18} className="text-foreground" />
                <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                  {fileDragCount}
                </span>
              </span>
              <div className="min-w-0">
                <div className="truncate font-semibold text-foreground">
                  {fileDragCount} {fileDragCount === 1 ? "file" : "files"}
                </div>
                <div className="truncate text-muted-foreground">
                  {destName() ? <>Import to &ldquo;{destName()}&rdquo;</> : <>Drop on a folder…</>}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        multiple
        hidden
        onChange={onFilePicked}
      />

      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
    </>
  );
}
