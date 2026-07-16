// Mirror of the backend's slugify (src/markdown.py) so client-side wikilink
// resolution agrees with how link edges are resolved server-side. Python's \w
// ≈ \p{L}\p{N}_ — exotic-script mismatches fall back to the title match.
export function slugify(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "untitled";
}
