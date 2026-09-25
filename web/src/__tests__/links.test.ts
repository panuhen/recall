import { describe, expect, it, vi } from "vitest";

import { copyText, linkPath, linkUrl } from "@/lib/links";

describe("linkPath / linkUrl", () => {
  it("builds workspace and note paths", () => {
    expect(linkPath("project", "abc")).toBe("/projects/abc");
    expect(linkPath("note", "n1")).toBe("/notes/n1");
  });

  it("prefixes the origin without doubling slashes", () => {
    expect(linkUrl("https://recall.example.com", "project", "p1")).toBe(
      "https://recall.example.com/projects/p1",
    );
    expect(linkUrl("http://localhost:3000/", "note", "n1")).toBe(
      "http://localhost:3000/notes/n1",
    );
  });

  it("encodes the id", () => {
    expect(linkPath("note", "a/b?c")).toBe("/notes/a%2Fb%3Fc");
  });
});

describe("copyText", () => {
  it("writes through the clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(copyText("hello", { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("reports failure when the clipboard rejects and there is no DOM", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(copyText("hello", { writeText })).resolves.toBe(false);
  });

  it("reports failure with no clipboard at all", async () => {
    await expect(copyText("hello", undefined)).resolves.toBe(false);
  });
});
