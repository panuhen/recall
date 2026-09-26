// Wikilinks inside code are example text, not links (as in Obsidian). Mirrors
// the backend's scanner (src/markdown.py: _iter_code_fence_segments and
// _CODE_OR_WIKILINK_RE), so what the Reading view renders as a link is exactly
// what the backend indexes as one.

// A line opening with 3+ backticks or tildes toggles a fence; a same-char,
// same-or-longer marker closes it. An unclosed fence runs to the end.
const FENCE = /^\s*(`{3,}|~{3,})/;
// Inline code span (one line) OR a wikilink; the span wins when it contains one.
const CODE_OR_WIKILINK = /(`+).+?\1|\[\[([^\]\n]+)\]\]/g;

// Replace each prose `[[inner]]` with `render(inner)`, leaving fenced blocks
// and inline code spans byte-for-byte intact.
export function replaceProseWikilinks(
  body: string,
  render: (inner: string) => string,
): string {
  let fence: { ch: string; len: number } | null = null;
  return body
    .split(/(?<=\n)/)
    .map((line) => {
      const m = FENCE.exec(line);
      if (fence) {
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
        return line;
      }
      if (m) {
        fence = { ch: m[1][0], len: m[1].length };
        return line;
      }
      return line.replace(CODE_OR_WIKILINK, (all, _ticks, inner?: string) =>
        inner === undefined ? all : render(inner),
      );
    })
    .join("");
}
