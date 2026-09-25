import { describe, expect, it } from "vitest";

import type { FolderSummary, NoteSummary, Tree } from "@/lib/api";
import { groupNotesByFolder } from "@/lib/workspace";

const T = "2026-01-01T00:00:00Z";

const folder = (id: string, name: string, parent_id: string | null = null): FolderSummary => ({
  id,
  project_id: "p",
  parent_id,
  name,
  created_at: T,
  updated_at: T,
});

const note = (id: string, title: string, folder_id: string | null = null): NoteSummary => ({
  id,
  title,
  slug: id,
  type: null,
  tags: [],
  status: null,
  folder_id,
  created_at: T,
  updated_at: T,
});

describe("groupNotesByFolder", () => {
  it("puts root notes first, then folders in path order", () => {
    const tree: Tree = {
      folders: [folder("b", "Beta"), folder("a", "Alpha"), folder("a2", "Sub", "a")],
      notes: [
        note("1", "In beta", "b"),
        note("2", "zeta"),
        note("3", "In sub", "a2"),
        note("4", "Alpha note", "a"),
        note("5", "Apple"),
      ],
    };
    const groups = groupNotesByFolder(tree);
    expect(groups.map((g) => g.path.join(" / "))).toEqual(["", "Alpha", "Alpha / Sub", "Beta"]);
    expect(groups[0].notes.map((n) => n.title)).toEqual(["Apple", "zeta"]);
    expect(groups[2].folderId).toBe("a2");
  });

  it("skips empty folders and returns nothing for an empty tree", () => {
    expect(groupNotesByFolder({ folders: [folder("a", "A")], notes: [] })).toEqual([]);
  });

  it("files a note in an unknown folder under the root", () => {
    const groups = groupNotesByFolder({ folders: [], notes: [note("1", "x", "gone")] });
    expect(groups).toHaveLength(1);
    expect(groups[0].path).toEqual([]);
  });

  it("survives a parent cycle", () => {
    const tree: Tree = {
      folders: [folder("a", "A", "b"), folder("b", "B", "a")],
      notes: [note("1", "x", "a")],
    };
    expect(groupNotesByFolder(tree)[0].path).toEqual(["B", "A"]);
  });
});
