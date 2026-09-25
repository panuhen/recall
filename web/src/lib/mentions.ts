// Highlighting for the "Unlinked mentions" snippets on the note page. The
// server picks the mention and trims the snippet; this only marks where the
// matched text (and any other occurrence of the note's name) sits in it, with
// the same rules as the backend matcher: case-insensitive, whole words only
// (Unicode letters/digits/_ count as word characters, so "worker" is not lit
// inside "coworkers" and Finnish "ä"/"ö" behave like any letter).

export type HighlightPart = { text: string; hit: boolean };

const WORD = "[\\p{L}\\p{N}_]";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split `text` into plain and highlighted parts for every whole-word,
// case-insensitive occurrence of any of `terms`. Longer terms win where they
// overlap; words inside a term match across any whitespace run.
export function highlightTerms(text: string, terms: string[]): HighlightPart[] {
  const alts = [...new Set(terms.map((t) => t.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.split(/\s+/).map(escapeRegExp).join("\\s+"));
  if (!text || alts.length === 0) return text ? [{ text, hit: false }] : [];
  const re = new RegExp(`(?<!${WORD})(?:${alts.join("|")})(?!${WORD})`, "giu");
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), hit: false });
    parts.push({ text: m[0], hit: true });
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
