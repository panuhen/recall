// Minimal, dependency-free rewriter for a note's YAML frontmatter block.
//
// The full markdown body (frontmatter + content) is the source of truth; the
// backend reprojects type/tags/status from it on save. This helper edits only
// the top-level `key: value` lines the Properties panel manages and preserves
// everything else — unknown keys, comments, ordering, and the note content —
// verbatim. It deliberately does NOT implement general YAML: the managed
// fields are scalars or a simple list, which is all the data model uses.

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export type FrontmatterValue = string | string[] | number | boolean | null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEmpty(v: FrontmatterValue): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  return false; // numbers (incl. 0) and booleans (incl. false) are meaningful
}

// Quote a scalar when leaving it bare would change how YAML parses it.
function needsQuote(v: string): boolean {
  return (
    v === "" ||
    /^\s|\s$/.test(v) ||
    /[:#[\]{}&*!|>'"%@`,]/.test(v) ||
    /^[-?]/.test(v) ||
    /^[\d.+-]/.test(v) || // could read as a number/date
    /^(true|false|null|yes|no|on|off|~)$/i.test(v)
  );
}

function scalar(v: string): string {
  return needsQuote(v) ? JSON.stringify(v) : v; // JSON string = valid YAML double-quoted
}

function serialize(key: string, value: Exclude<FrontmatterValue, null>): string {
  if (Array.isArray(value)) return `${key}: [${value.map(scalar).join(", ")}]`;
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  return `${key}: ${scalar(value)}`;
}

// End (exclusive) of the value block for a top-level key at `startIdx`: the key
// line plus any following indented continuation or `- ` sequence lines. Lets us
// replace a block-style list (`tags:\n  - a\n  - b`) without orphaning entries.
function blockEnd(lines: string[], startIdx: number): number {
  let end = startIdx + 1;
  while (end < lines.length && /^(\s|-\s)/.test(lines[end])) end++;
  return end;
}

/**
 * Return `body` with the given frontmatter fields updated. A value of `null`,
 * `""`, or `[]` removes the key. Creates the frontmatter block if absent and
 * removes it entirely if the last key is cleared.
 */
export function updateFrontmatter(
  body: string,
  updates: Record<string, FrontmatterValue>,
): string {
  const m = FRONTMATTER_RE.exec(body);
  const rest = m ? body.slice(m[0].length) : body;
  const lines = m && m[1].length ? m[1].split(/\r?\n/) : [];

  for (const [key, value] of Object.entries(updates)) {
    const keyRe = new RegExp(`^${escapeRe(key)}[ \\t]*:`);
    const idx = lines.findIndex((l) => keyRe.test(l));
    if (idx !== -1) {
      lines.splice(idx, blockEnd(lines, idx) - idx); // drop old block
      if (!isEmpty(value)) lines.splice(idx, 0, serialize(key, value!));
    } else if (!isEmpty(value)) {
      lines.push(serialize(key, value!));
    }
  }

  if (lines.length === 0) return rest;
  return `---\n${lines.join("\n")}\n---\n${rest}`;
}
