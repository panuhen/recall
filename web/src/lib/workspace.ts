import type { NoteSummary, Tree } from "@/lib/api";

// A workspace landing page section: the notes directly in one folder, labelled
// by the folder's path from the workspace root ([] = the root itself).
export type NoteGroup = { folderId: string | null; path: string[]; notes: NoteSummary[] };

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

// Group a workspace tree's notes by folder: root notes first, then folders in
// path order (A, A / B, C), notes by title within each. Empty folders are left
// out. A folder whose parent is missing from the tree roots its path at itself.
export function groupNotesByFolder(tree: Tree): NoteGroup[] {
  const folders = new Map(tree.folders.map((f) => [f.id, f]));
  const pathOf = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur); // guard against a malformed parent cycle
      const f = folders.get(cur);
      if (!f) break;
      path.unshift(f.name);
      cur = f.parent_id;
    }
    return path;
  };

  const groups = new Map<string | null, NoteGroup>();
  for (const n of tree.notes) {
    const key = n.folder_id && folders.has(n.folder_id) ? n.folder_id : null;
    let g = groups.get(key);
    if (!g) {
      g = { folderId: key, path: key ? pathOf(key) : [], notes: [] };
      groups.set(key, g);
    }
    g.notes.push(n);
  }

  for (const g of groups.values())
    g.notes.sort((a, b) => byName(a.title || "", b.title || ""));
  return [...groups.values()].sort((a, b) => {
    if (a.path.length === 0) return -1;
    if (b.path.length === 0) return 1;
    // Compare segment by segment so "A / B" sorts right after "A".
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
      const c = byName(a.path[i], b.path[i]);
      if (c !== 0) return c;
    }
    return a.path.length - b.path.length;
  });
}
