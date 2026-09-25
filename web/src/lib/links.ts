// Shareable links to a workspace landing page or a note. A link grants no
// access by itself: the page it opens shows content only to members (or to
// anyone in the org for an org-visible workspace).
export type LinkTarget = "project" | "note";

export function linkPath(kind: LinkTarget, id: string): string {
  return `/${kind === "project" ? "projects" : "notes"}/${encodeURIComponent(id)}`;
}

// Absolute URL for `kind`/`id` under `origin` (e.g. window.location.origin).
export function linkUrl(origin: string, kind: LinkTarget, id: string): string {
  return origin.replace(/\/+$/, "") + linkPath(kind, id);
}

type ClipboardLike = { writeText: (text: string) => Promise<void> };

// Copy text; true on success. Uses the async Clipboard API when present (secure
// contexts), else the legacy execCommand path so a plain-http self-hosted
// instance still works. `clipboard` is injectable for tests.
export async function copyText(
  text: string,
  clipboard: ClipboardLike | undefined = typeof navigator !== "undefined"
    ? navigator.clipboard
    : undefined,
): Promise<boolean> {
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // permission denied / not focused — try the fallback below
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
