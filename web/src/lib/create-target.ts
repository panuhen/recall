// Where the sidebar toolbar's New note / New folder create things: where the
// user is working, like VS Code or Obsidian's "same folder as current file".
// The most recent of these wins, in this order:
//   1. a workspace or folder row clicked in the sidebar
//   2. the open note's folder (or its workspace root)
//   3. the open workspace page's root
// falling back to Personal when none applies or the target is read-only.

import type { FolderSummary } from "@/lib/api";

export type CreateTarget = { projectId: string; folderId: string | null };

export function resolveCreateTarget(opts: {
  focus: CreateTarget | null;
  note: CreateTarget | null;
  workspacePage: string | null;
  personalId: string;
  canWrite: (projectId: string) => boolean;
  // Drops a folder that no longer exists (deleted, moved to another workspace)
  // back to its workspace root. Unknown (tree not loaded) counts as existing.
  folderExists?: (projectId: string, folderId: string) => boolean;
}): CreateTarget {
  const { focus, note, workspacePage, personalId, canWrite, folderExists } = opts;
  const candidate =
    focus ?? note ?? (workspacePage ? { projectId: workspacePage, folderId: null } : null);
  if (!candidate || !canWrite(candidate.projectId)) {
    return { projectId: personalId, folderId: null };
  }
  if (candidate.folderId && folderExists && !folderExists(candidate.projectId, candidate.folderId)) {
    return { projectId: candidate.projectId, folderId: null };
  }
  return candidate;
}

// "Workspace / Parent / Folder" for the toolbar tooltips.
export function describeTarget(
  workspaceName: string,
  folderId: string | null,
  folders: FolderSummary[] | undefined,
): string {
  if (!folderId || !folders) return workspaceName;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: string[] = [];
  let cur: string | null = folderId;
  while (cur && path.length < 50) {
    const f = byId.get(cur);
    if (!f) break;
    path.unshift(f.name);
    cur = f.parent_id;
  }
  return [workspaceName, ...path].join(" / ");
}
