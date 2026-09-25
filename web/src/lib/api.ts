export type NoteSummary = {
  id: string;
  title: string;
  slug: string;
  type: string | null;
  tags: string[];
  status: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
};

export type OrgAccess = "none" | "viewer";

export type ProjectSummary = {
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

// A workspace shared org-wide that the caller isn't a member of — the Browse
// list. `pinned` reflects whether the caller keeps it in their sidebar.
export type OrgProject = {
  id: string;
  name: string;
  slug: string;
  owner_name: string;
  member_count: number;
  pinned: boolean;
  updated_at: string;
};

export type FolderSummary = {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
};

export type Tree = { folders: FolderSummary[]; notes: NoteSummary[] };

export type Backlink = { id: string; title: string; slug: string };

// A note's own [[wikilink]] as a server-resolved edge: the raw target text as
// written in the body → the target's note id (null while dangling or trashed),
// plus the target's CURRENT title/slug. Shipped with the note read so link
// resolution never depends on a separately-cached note list.
export type OutboundLink = {
  target_title: string;
  id: string | null;
  title: string | null;
  slug: string | null;
};

// Knowledge-graph payload for a project: notes as nodes, resolved [[wikilinks]]
// as edges. `source`/`target` are note ids.
export type GraphNode = {
  id: string;
  title: string;
  folder_id: string | null;
  tags: string[];
};
export type GraphLink = { source: string; target: string };
export type GraphData = { nodes: GraphNode[]; links: GraphLink[] };

// Whole-account structure graph: workspaces + folders + notes as kinded nodes,
// containment + wikilink edges. Node ids are raw row uuids (a note node's id
// opens that note).
export type GraphNodeKind = "project" | "folder" | "note";
export type RootGraphNode = { id: string; label: string; kind: GraphNodeKind };
export type RootGraphLink = {
  source: string;
  target: string;
  kind: "contains" | "link";
};
export type RootGraphData = { nodes: RootGraphNode[]; links: RootGraphLink[] };

// One hit from hybrid (keyword + semantic) search. `project_name` labels the
// workspace a result lives in (search is global by default). `score` is the
// fused RRF rank — for ordering only, not a calibrated relevance percentage.
export type SearchResult = {
  id: string;
  title: string;
  slug: string;
  project_id: string;
  project_name: string;
  folder_id: string | null;
  snippet: string;
  updated_at: string;
  score: number;
};
export type SearchResponse = { results: SearchResult[]; semantic: boolean };

// System provenance: who created/last-edited a note. Null for rows with no
// recorded actor (e.g. older seed data).
export type NoteActor = { id: string; name: string };

export type Note = NoteSummary & {
  project_id: string;
  body: string;
  metadata: Record<string, unknown>;
  created_at: string;
  created_by: NoteActor | null;
  updated_by: NoteActor | null;
  // MCP client (AI assistant) that made the write, self-reported (e.g.
  // "Claude"). Null = written in the web UI (or before attribution existed).
  created_via: string | null;
  updated_via: string | null;
  backlinks?: Backlink[];
  // Resolved outbound edges for this note's [[wikilinks]]. Only the GET-note
  // endpoint sets it (like backlinks).
  links?: OutboundLink[];
  // Whether the caller may edit this note (owner/editor). Only the GET-note
  // endpoint sets it; mutating responses omit it (the caller is an editor by
  // definition), so treat `undefined` as editable.
  can_edit?: boolean;
  // The workspace guide's view of this note (GET, PATCH and mark-reviewed set
  // these). All empty/null when the workspace has no usable guide.
  review?: NoteReview | null;
  hints?: ConventionHint[];
  conventions?: GuideConventions | null;
  guide_id?: string | null;
};

// ── Workspace guide + health ────────────────────────────────

// Where the note departs from its workspace guide. Advisory: never blocks.
export type ConventionHint = { code: string; field: string | null; message: string };

// Present when the note sets `review_every` (e.g. 6mo). A note never reviewed
// counts from its creation date.
export type NoteReview = {
  every: string;
  every_text: string;
  reviewed: string | null;
  due: string;
  overdue: boolean;
};

// From the guide's flat `workspace_types` / `workspace_tags` lists.
export type GuideConventions = {
  owner: string | null;
  types: string[];
  tags: string[];
};

export type WorkspaceGuide = {
  id: string;
  title: string;
  summary: string;
  owner: string | null;
  owner_left: boolean;
  problems: string[];
  conventions: GuideConventions | null;
  guide_count: number;
  updated_at: string;
};

export type HealthNote = {
  id: string;
  title: string;
  type: string | null;
  updated_at: string;
};
export type WorkspaceHealth = {
  stale_after_months: number;
  counts: Record<HealthListKey, number>;
  overdue: (HealthNote & {
    reviewed: string | null;
    due: string;
    every: string;
    every_text: string;
    owner: string | null;
  })[];
  not_edited: HealthNote[];
  old_drafts: HealthNote[];
  orphans: HealthNote[];
  broken_links: { id: string; title: string; target_title: string; reason: "missing" | "trashed" }[];
  owner_left: (HealthNote & { owner: string })[];
};
export type HealthListKey =
  | "overdue"
  | "not_edited"
  | "old_drafts"
  | "orphans"
  | "broken_links"
  | "owner_left";

// A semantic neighbor of a note: same workspace, similar content, not already
// linked from it. Drives the "Related" section under Backlinks. `score` is
// cosine similarity (0–1), used for ordering only.
export type RelatedNote = { id: string; title: string; slug: string; score: number };

// A note that names this one in plain text (title or a frontmatter alias)
// without linking it. `term` is the title/alias matched, `match` the text as
// written, `snippet` ~120 chars of context. `can_edit` = the caller may turn
// the mention into a [[wikilink]] (editor+ on the mentioning note).
export type UnlinkedMention = {
  id: string;
  title: string;
  slug: string;
  term: string;
  match: string;
  snippet: string;
  updated_at: string;
  can_edit: boolean;
};

// A point-in-time snapshot of a note's body. `trigger` records why it was
// taken; `label` is set only for manual "Save version" snapshots. The list
// endpoint omits `body` (kept light); fetch a single revision to get it.
export type RevisionTrigger = "auto" | "manual" | "session_start" | "status_change";
export type Revision = {
  id: string;
  trigger: RevisionTrigger;
  label: string | null;
  created_at: string;
  author: NoteActor | null;
  // MCP client that wrote this body (e.g. "Claude"); null = web UI.
  client: string | null;
};
export type RevisionDetail = Revision & { body: string };

export type RecentNote = NoteSummary & {
  project_id: string;
  project_name: string;
};

// A non-2xx response. `status` lets a page tell "no access" (403/404) apart
// from a failure. Message and name stay those of the plain `Error("HTTP …")`
// it replaces, so existing `String(e)` displays read the same.
export class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}

// The signed-in user and their memberships (the sidebar's source). Also
// provisions the user + personal workspace and accepts pending invitations.
export type MeResponse = {
  user: { id: string; upn: string; name: string | null };
  personal_project_id: string;
  projects: ProjectSummary[];
};

export const getMe = () =>
  fetch(`/api/me`, { cache: "no-store" }).then((r) => json<MeResponse>(r));

export const createProject = (name: string) =>
  fetch(`/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => json<ProjectSummary>(r));

export const listNotes = (projectId: string) =>
  fetch(`/api/projects/${projectId}/notes`, { cache: "no-store" }).then((r) =>
    json<{ notes: NoteSummary[] }>(r),
  );

export const getGraph = (projectId: string) =>
  fetch(`/api/projects/${projectId}/graph`, { cache: "no-store" }).then((r) =>
    json<GraphData>(r),
  );

export const getRootGraph = () =>
  fetch(`/api/graph`, { cache: "no-store" }).then((r) => json<RootGraphData>(r));

// Hybrid search. Global across the caller's workspaces unless `projectId` scopes
// it to one. Returns `{ results, semantic }` — `semantic` is false when the
// query couldn't be embedded (keyword-only fallback).
export const search = (
  query: string,
  opts: { projectId?: string; limit?: number } = {},
) => {
  const params = new URLSearchParams({ q: query });
  if (opts.projectId) params.set("project_id", opts.projectId);
  if (opts.limit) params.set("limit", String(opts.limit));
  return fetch(`/api/search?${params}`, { cache: "no-store" }).then((r) =>
    json<SearchResponse>(r),
  );
};

export const listRecentNotes = () =>
  fetch(`/api/notes/recent`, { cache: "no-store" }).then((r) =>
    json<{ notes: RecentNote[] }>(r),
  );

export const createNote = (
  projectId: string,
  title: string,
  body: string,
  folderId?: string | null,
) =>
  fetch(`/api/projects/${projectId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body, folder_id: folderId ?? null }),
  }).then((r) => json<Note>(r));

export const getNote = (id: string) =>
  fetch(`/api/notes/${id}`, { cache: "no-store" }).then((r) => json<Note>(r));

// Thrown by updateNote on a 409: the note moved on the server since the caller
// loaded it (someone else saved). Carries the current server note so the UI can
// name the other editor and let the user reconcile.
export class NoteConflictError extends Error {
  note: Note | null;
  constructor(note: Note | null) {
    super("conflict");
    this.name = "NoteConflictError";
    this.note = note;
  }
}

// Save a note edit. Pass `baseUpdatedAt` (the `updated_at` you last loaded) to
// opt into the concurrency guard: if the note moved since, this throws
// NoteConflictError instead of overwriting the other edit. Omit it for
// best-effort flushes / deliberate renames (last-writer-wins).
export const updateNote = async (
  id: string,
  patch: { title?: string; body?: string },
  baseUpdatedAt?: string,
) => {
  const r = await fetch(`/api/notes/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...patch, base_updated_at: baseUpdatedAt ?? null }),
  });
  if (r.status === 409) {
    const payload = (await r.json().catch(() => ({}))) as { note?: Note };
    throw new NoteConflictError(payload.note ?? null);
  }
  return json<Note>(r);
};

export const moveNote = (
  id: string,
  opts: { projectId?: string; folderId?: string | null },
) =>
  fetch(`/api/notes/${id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: opts.projectId,
      folder_id: opts.folderId ?? null,
    }),
  }).then((r) => json<Note>(r));

export const copyNote = (id: string) =>
  fetch(`/api/notes/${id}/copy`, { method: "POST" }).then((r) => json<Note>(r));

export const deleteNote = (id: string) =>
  fetch(`/api/notes/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));

// Semantic neighbors for the "Related" section (top 5, workspace-scoped).
export const getRelated = (noteId: string) =>
  fetch(`/api/notes/${noteId}/related`, { cache: "no-store" }).then((r) =>
    json<{ related: RelatedNote[] }>(r),
  );

// Notes mentioning this one in plain text but not linking it (same workspace).
export const getUnlinkedMentions = (noteId: string) =>
  fetch(`/api/notes/${noteId}/unlinked-mentions`, { cache: "no-store" }).then((r) =>
    json<{ mentions: UnlinkedMention[] }>(r),
  );

// Rewrite the first plain mention of `noteId` inside `sourceNoteId` into a
// [[wikilink]]. Returns the updated source note.
export const linkUnlinkedMention = (noteId: string, sourceNoteId: string) =>
  fetch(`/api/notes/${noteId}/unlinked-mentions/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_note_id: sourceNoteId }),
  }).then((r) => json<Note>(r));

export const getWorkspaceHealth = (projectId: string) =>
  fetch(`/api/projects/${projectId}/health`, { cache: "no-store" }).then((r) =>
    json<{ guide: WorkspaceGuide | null; health: WorkspaceHealth; can_edit: boolean }>(r),
  );

// Create the workspace's guide note, pre-filled from the types and tags in use.
export const createGuide = (projectId: string) =>
  fetch(`/api/projects/${projectId}/guide`, { method: "POST" }).then((r) => json<Note>(r));

// Set `reviewed:` to today. Throws HttpError(409) if the note changed meanwhile
// or its frontmatter is broken.
export const markReviewed = (noteId: string) =>
  fetch(`/api/notes/${noteId}/reviewed`, { method: "POST" }).then((r) => json<Note>(r));

// ── Version history ─────────────────────────────────────────

export const listRevisions = (noteId: string) =>
  fetch(`/api/notes/${noteId}/revisions`, { cache: "no-store" }).then((r) =>
    json<{ revisions: Revision[] }>(r),
  );

export const getRevision = (noteId: string, revId: string) =>
  fetch(`/api/notes/${noteId}/revisions/${revId}`, { cache: "no-store" }).then((r) =>
    json<RevisionDetail>(r),
  );

// Manual "Save version": snapshot the current body; returns the refreshed list.
export const saveRevision = (noteId: string, label?: string) =>
  fetch(`/api/notes/${noteId}/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: label ?? null }),
  }).then((r) => json<{ revisions: Revision[] }>(r));

// Non-destructive restore; returns the updated note (current body = revision).
export const restoreRevision = (noteId: string, revId: string) =>
  fetch(`/api/notes/${noteId}/revisions/${revId}/restore`, { method: "POST" }).then(
    (r) => json<Note>(r),
  );

export const renameProject = (id: string, name: string) =>
  fetch(`/api/projects/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => json<ProjectSummary>(r));

export const deleteProject = (id: string) =>
  fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));

export const listTree = (projectId: string) =>
  fetch(`/api/projects/${projectId}/tree`, { cache: "no-store" }).then((r) =>
    json<Tree>(r),
  );

export const createFolder = (
  projectId: string,
  name: string,
  parentId?: string | null,
) =>
  fetch(`/api/projects/${projectId}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, parent_id: parentId ?? null }),
  }).then((r) => json<FolderSummary>(r));

export const renameFolder = (id: string, name: string) =>
  fetch(`/api/folders/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => json<FolderSummary>(r));

export const deleteFolder = (id: string) =>
  fetch(`/api/folders/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));

export const copyFolder = (id: string) =>
  fetch(`/api/folders/${id}/copy`, { method: "POST" }).then((r) =>
    json<FolderSummary>(r),
  );

export const moveFolder = (
  id: string,
  opts: { projectId?: string; parentId: string | null },
) =>
  fetch(`/api/folders/${id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: opts.projectId, parent_id: opts.parentId }),
  }).then((r) => json<FolderSummary>(r));

// ── Sharing / members ───────────────────────────────────────

export type MemberRole = "owner" | "editor" | "viewer";
export type ShareRole = "editor" | "viewer"; // roles a share can grant

export type Member = {
  user_id: string;
  upn: string;
  display_name: string | null;
  role: MemberRole;
  added_at: string;
};

// An invitation waiting for the invitee's first sign-in to become a membership.
export type PendingInvite = {
  id: string;
  invited_upn: string;
  role: ShareRole;
  created_at: string;
};

export type MembersResponse = {
  members: Member[];
  invitations: PendingInvite[];
  your_role: MemberRole;
};

// A directory match from the people picker (Microsoft Graph, via the BFF).
export type DirectoryHit = { oid: string; upn: string; name: string };

export const listMembers = (projectId: string) =>
  fetch(`/api/projects/${projectId}/members`, { cache: "no-store" }).then((r) =>
    json<MembersResponse>(r),
  );

// Share with a colleague: adds them now if they have an account, else records a
// pending invitation. `kind` says which happened.
export const addMember = (projectId: string, upn: string, role: ShareRole) =>
  fetch(`/api/projects/${projectId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upn, role }),
  }).then((r) => json<{ kind: "member" | "invitation" }>(r));

// Change an existing member's role — including promoting to / demoting from
// Owner (the backend refuses to demote the last owner).
export const updateMemberRole = (
  projectId: string,
  userId: string,
  role: MemberRole,
) =>
  fetch(`/api/projects/${projectId}/members/${userId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  }).then((r) => json<{ ok: true }>(r));

// Remove a member; passing the caller's own id is "leave workspace".
export const removeMember = (projectId: string, userId: string) =>
  fetch(`/api/projects/${projectId}/members/${userId}`, { method: "DELETE" }).then(
    (r) => json<{ ok: true }>(r),
  );

export const revokeInvitation = (projectId: string, inviteId: string) =>
  fetch(`/api/projects/${projectId}/invitations/${inviteId}`, {
    method: "DELETE",
  }).then((r) => json<{ ok: true }>(r));

// Org directory typeahead. Returns [] in dev or when Graph is unavailable — the
// dialog still lets you type a full email address.
export const searchDirectory = (q: string) =>
  fetch(`/api/directory/search?${new URLSearchParams({ q })}`, {
    cache: "no-store",
  }).then((r) => json<{ results: DirectoryHit[] }>(r));

// ── Org-wide visibility & pins ──────────────────────────────

// Set a workspace's general access ("none" = restricted, "viewer" = anyone in
// the org can view). Owner only.
export const setOrgAccess = (projectId: string, value: OrgAccess) =>
  fetch(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org_access: value }),
  }).then((r) => json<ProjectSummary>(r));

// Org-visible workspaces the caller isn't a member of (Browse / show-all).
export const listOrgProjects = () =>
  fetch(`/api/projects/org`, { cache: "no-store" }).then((r) =>
    json<{ projects: OrgProject[] }>(r),
  );

export const pinProject = (projectId: string) =>
  fetch(`/api/projects/${projectId}/pin`, { method: "POST" }).then((r) =>
    json<{ ok: true }>(r),
  );

export const unpinProject = (projectId: string) =>
  fetch(`/api/projects/${projectId}/pin`, { method: "DELETE" }).then((r) =>
    json<{ ok: true }>(r),
  );

// ── Favorites (starred shortcuts) ───────────────────────────

export type FavoriteType = "note" | "folder" | "project";

// A starred shortcut resolved for display. `project_id` is the workspace to
// open/reveal (equals `id` when the favorite is a workspace).
export type FavoriteItem = {
  type: FavoriteType;
  id: string;
  label: string;
  project_id: string;
};

export const listFavorites = () =>
  fetch(`/api/favorites`, { cache: "no-store" }).then((r) =>
    json<{ favorites: FavoriteItem[] }>(r),
  );

export const addFavorite = (itemType: FavoriteType, itemId: string) =>
  fetch(`/api/favorites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item_type: itemType, item_id: itemId }),
  }).then((r) => json<{ ok: true }>(r));

export const removeFavorite = (itemType: FavoriteType, itemId: string) =>
  fetch(`/api/favorites/${itemType}/${itemId}`, { method: "DELETE" }).then((r) =>
    json<{ ok: true }>(r),
  );

// Persist a new favorites order (the full list, in the desired sequence).
export const reorderFavorites = (
  items: { item_type: FavoriteType; item_id: string }[],
) =>
  fetch(`/api/favorites/reorder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  }).then((r) => json<{ ok: true }>(r));

// ── Trash (soft-deleted items) ──────────────────────────────

export type TrashKind = "note" | "folder" | "project";

// One restorable item. `project_id`/`project_name` locate a note/folder's
// workspace; both are absent for a workspace item. `archived_at` is when it was
// deleted.
export type TrashItem = {
  type: TrashKind;
  id: string;
  label: string;
  project_id?: string;
  project_name?: string;
  archived_at: string;
};

export type TrashResponse = {
  projects: TrashItem[];
  folders: TrashItem[];
  notes: TrashItem[];
};

const trashPath = (type: TrashKind, id: string, action: "restore" | "purge") => {
  const base = type === "project" ? "projects" : type === "folder" ? "folders" : "notes";
  return `/api/${base}/${id}/${action}`;
};

export const listTrash = () =>
  fetch(`/api/trash`, { cache: "no-store" }).then((r) => json<TrashResponse>(r));

// Un-archive an item (a folder/workspace also brings back what was deleted with
// it). Restoring a note/folder needs its workspace to be alive.
export const restoreTrashItem = (type: TrashKind, id: string) =>
  fetch(trashPath(type, id, "restore"), { method: "POST" }).then((r) =>
    json<{ ok: boolean }>(r),
  );

// Permanently delete an archived item and everything under it. Irreversible.
export const purgeTrashItem = (type: TrashKind, id: string) =>
  fetch(trashPath(type, id, "purge"), { method: "DELETE" }).then((r) =>
    json<{ ok: true }>(r),
  );
