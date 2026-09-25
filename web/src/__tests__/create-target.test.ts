import { describe, expect, it } from "vitest";

import type { FolderSummary } from "@/lib/api";
import { describeTarget, resolveCreateTarget } from "@/lib/create-target";

const PERSONAL = "personal";
const writable = new Set([PERSONAL, "ws", "other"]);
const base = {
  focus: null,
  note: null,
  workspacePage: null,
  personalId: PERSONAL,
  canWrite: (id: string) => writable.has(id),
};

describe("resolveCreateTarget", () => {
  it("falls back to Personal with nothing active", () => {
    expect(resolveCreateTarget(base)).toEqual({ projectId: PERSONAL, folderId: null });
  });

  it("uses the open note's folder", () => {
    expect(
      resolveCreateTarget({ ...base, note: { projectId: "ws", folderId: "f1" } }),
    ).toEqual({ projectId: "ws", folderId: "f1" });
  });

  it("uses the open workspace page's root", () => {
    expect(resolveCreateTarget({ ...base, workspacePage: "ws" })).toEqual({
      projectId: "ws",
      folderId: null,
    });
  });

  it("a clicked sidebar row beats the open note", () => {
    expect(
      resolveCreateTarget({
        ...base,
        focus: { projectId: "other", folderId: "f9" },
        note: { projectId: "ws", folderId: "f1" },
      }),
    ).toEqual({ projectId: "other", folderId: "f9" });
  });

  it("the open note beats the workspace page", () => {
    expect(
      resolveCreateTarget({
        ...base,
        note: { projectId: "ws", folderId: null },
        workspacePage: "other",
      }),
    ).toEqual({ projectId: "ws", folderId: null });
  });

  it("a read-only target falls back to Personal", () => {
    expect(
      resolveCreateTarget({ ...base, note: { projectId: "viewer-only", folderId: "f1" } }),
    ).toEqual({ projectId: PERSONAL, folderId: null });
  });

  it("a folder that no longer exists falls back to its workspace root", () => {
    expect(
      resolveCreateTarget({
        ...base,
        focus: { projectId: "ws", folderId: "gone" },
        folderExists: () => false,
      }),
    ).toEqual({ projectId: "ws", folderId: null });
  });
});

describe("describeTarget", () => {
  const folder = (id: string, name: string, parent_id: string | null): FolderSummary => ({
    id,
    name,
    parent_id,
    project_id: "ws",
    created_at: "",
    updated_at: "",
  });
  const folders = [folder("a", "Projects", null), folder("b", "2026", "a")];

  it("names the workspace for its root", () => {
    expect(describeTarget("Team", null, folders)).toBe("Team");
  });

  it("walks the folder chain", () => {
    expect(describeTarget("Team", "b", folders)).toBe("Team / Projects / 2026");
  });

  it("stops at a missing folder", () => {
    expect(describeTarget("Team", "zzz", folders)).toBe("Team");
  });
});
