import { createNote, type Note } from "@/lib/api";

// Markdown import: read dropped/picked files and create a note per file. The
// backend's createNote already parses frontmatter, projects metadata, resolves
// [[wikilinks]], and enqueues embedding — so this is purely client-side.

const ACCEPTED = /\.(md|markdown|txt)$/i;

// Split a dropped/picked file list into what we can import vs. what we can't,
// so callers can act on the supported files and report the rest.
export function partitionFiles(files: File[]): {
  supported: File[];
  unsupported: File[];
} {
  const supported: File[] = [];
  const unsupported: File[] = [];
  for (const f of files) (ACCEPTED.test(f.name) ? supported : unsupported).push(f);
  return { supported, unsupported };
}

// Best note title for an imported file: frontmatter `title:` → first `# H1` →
// filename (sans extension).
export function deriveTitle(body: string, filename: string): string {
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^title:\s*(.+)$/m);
    if (m) {
      const t = m[1].trim().replace(/^["']|["']$/g, "").trim();
      if (t) return t;
    }
  }
  const rest = fm ? body.slice(fm[0].length) : body;
  const h1 = rest.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return filename.replace(ACCEPTED, "").trim() || "Untitled";
}

// Create a note for each accepted (.md/.markdown/.txt) file, in order, into the
// given project + folder. Non-markdown files are ignored. Returns the notes
// created. Throws if any createNote call fails (caller surfaces the error).
export async function importMarkdownFiles(
  files: File[],
  projectId: string,
  folderId: string | null,
): Promise<Note[]> {
  const created: Note[] = [];
  for (const f of files) {
    if (!ACCEPTED.test(f.name)) continue;
    const text = await f.text();
    created.push(await createNote(projectId, deriveTitle(text, f.name), text, folderId));
  }
  return created;
}
