import { getNote } from "@/lib/api";

// Filename-safe version of a title, mirroring the backend's _safe_filename.
function safeName(name: string): string {
  const s = (name || "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return s || "untitled";
}

function clickDownload(href: string, filename?: string) {
  const a = document.createElement("a");
  a.href = href;
  if (filename !== undefined) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Single note → a client-built `.md` download from its markdown body.
export async function downloadNoteMarkdown(id: string): Promise<void> {
  const note = await getNote(id);
  const blob = new Blob([note.body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    clickDownload(url, `${safeName(note.title)}.md`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Folder / workspace → the backend zip endpoint. No `download` attribute: the
// response's `Content-Disposition: attachment; filename=…` drives the download
// (and keeps the current page).
export const folderZipPath = (id: string) => `/api/folders/${id}/export`;
export const projectZipPath = (id: string) => `/api/projects/${id}/export`;
export function downloadZip(path: string): void {
  clickDownload(path);
}
