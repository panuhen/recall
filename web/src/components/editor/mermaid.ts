// Shared Mermaid rendering for recall. Used by both the Reading view
// (MermaidDiagram, React) and the Live Preview editor widget (plain DOM), so the
// theme + security config lives in exactly one place.
//
// Mermaid is heavy (~500KB), so it is loaded lazily on first render via a dynamic
// import — a note with no diagram never pays for it. Rendering is client-only.

// A minimal slice of Mermaid's API — enough to avoid importing its types eagerly.
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  parse: (text: string) => Promise<unknown>;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;

function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(
      (m) => (m as unknown as { default: MermaidApi }).default,
    );
  }
  return mermaidPromise;
}

// Monochrome palettes mirroring the oklch neutral tokens in globals.css. Values
// are hex (not oklch/var()) on purpose: Mermaid runs colour math (khroma) over
// these, which does not understand oklch or CSS custom properties. Diagrams stay
// fully grayscale to honour the design system's one-voice rule (the single --link accent
// is reserved for interactive text, not diagram fills).
const LIGHT = {
  background: "#ffffff",
  primaryColor: "#f5f5f5",
  primaryBorderColor: "#c6c6c6",
  primaryTextColor: "#232323",
  secondaryColor: "#ececec",
  tertiaryColor: "#fafafa",
  lineColor: "#8a8a8a",
  textColor: "#232323",
  mainBkg: "#f5f5f5",
  nodeBorder: "#c6c6c6",
  clusterBkg: "#fafafa",
  clusterBorder: "#e5e5e5",
  titleColor: "#232323",
  edgeLabelBackground: "#ffffff",
  fontFamily: "var(--font-sans)",
};

const DARK = {
  background: "#252525",
  primaryColor: "#343434",
  primaryBorderColor: "#5a5a5a",
  primaryTextColor: "#fafafa",
  secondaryColor: "#2e2e2e",
  tertiaryColor: "#2b2b2b",
  lineColor: "#a8a8a8",
  textColor: "#fafafa",
  mainBkg: "#343434",
  nodeBorder: "#5a5a5a",
  clusterBkg: "#2b2b2b",
  clusterBorder: "#454545",
  titleColor: "#fafafa",
  edgeLabelBackground: "#252525",
  fontFamily: "var(--font-sans)",
};

export function resolvedTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

let idSeq = 0;
export function nextMermaidId(): string {
  idSeq += 1;
  return `mermaid-${idSeq.toString(36)}`;
}

// Render Mermaid source to a sanitized SVG string. Throws on a parse/render
// error so callers can show a fallback. `securityLevel: 'strict'` makes Mermaid
// sanitize its output (DOMPurify) and disables click handlers + inline HTML
// labels — important because one member's note renders in another's browser.
export async function renderMermaid(code: string, id: string): Promise<string> {
  const mermaid = await getMermaid();
  const themeVariables = resolvedTheme() === "dark" ? DARK : LIGHT;
  // initialize() sets global config; we re-apply per render so a theme switch is
  // reflected. Both diagrams on a page share the current theme, so there is no
  // cross-diagram mismatch.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables,
    fontFamily: "var(--font-sans)",
  });
  await mermaid.parse(code); // throws with a clean message on a syntax error
  const { svg } = await mermaid.render(id, code);
  return svg;
}

// ── Export ──────────────────────────────────────────────────
// The Reading view already holds the rendered (sanitized) SVG string, so export
// is just a matter of packaging it. All client-only (DOMParser / canvas / Image).

// On-screen the SVG inherits `var(--font-sans)` from the page, but a downloaded
// file or a canvas-rasterized <img> is an isolated document where that CSS var
// never resolves. Swap it for a concrete stack so exports keep a sane font.
// Font names are single-quoted on purpose: mermaid can emit the family inside a
// double-quoted XML attribute (style="font-family: var(--font-sans)"), and
// double quotes in the replacement would break that attribute → invalid XML →
// the <img> rasterizer refuses to load it. Single quotes are valid both in a
// CSS <style> block and inside a double-quoted attribute.
const EXPORT_FONT =
  "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

function forExport(svg: string): string {
  return svg.replace(/var\(--font-sans\)/g, EXPORT_FONT);
}

// Intrinsic pixel size of a rendered Mermaid SVG. Mermaid always emits a
// viewBox; the root width/height are "100%"/absent, so the viewBox is the
// reliable source. Falls back to a sane default if it is ever missing.
function svgIntrinsicSize(svg: string): { width: number; height: number } {
  const m = /viewBox\s*=\s*["']([\d.eE+\- ]+)["']/.exec(svg);
  if (m) {
    const [, , w, h] = m[1].trim().split(/[\s,]+/).map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return { width: 800, height: 600 };
}

// Normalize a Mermaid SVG string into a valid *standalone* SVG document.
// Inline in the page the string renders fine — the HTML parser tolerates named
// entities (&nbsp;), unclosed tags, and an implied namespace — but an <img> or a
// downloaded file parses it as strict XML and rejects anything malformed, which
// is what produced the bare "SVG could not be loaded" error on some diagrams.
// Round-tripping through the HTML parser and re-serializing as XML fixes all of
// that at once: entities become real characters, tags close, and the SVG
// namespace is emitted. Optionally stamps explicit pixel width/height so an
// <img> rasterizes at full resolution (a "100%"-width SVG has no intrinsic size).
function normalizeSvg(svg: string, size?: { w: number; h: number }): string {
  if (typeof document === "undefined") return svg;
  const holder = document.createElement("div");
  holder.innerHTML = svg; // lenient HTML parse → a valid, namespaced SVG DOM
  const root = holder.querySelector("svg");
  if (!root) return svg;
  if (size) {
    root.setAttribute("width", String(size.w));
    root.setAttribute("height", String(size.h));
  }
  // The node is in the SVG namespace after the HTML parse, so XMLSerializer
  // emits the xmlns declaration itself — the output is well-formed standalone XML.
  return new XMLSerializer().serializeToString(root);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadSvg(svg: string, filename = "diagram.svg"): void {
  const out = normalizeSvg(forExport(svg));
  const withHeader = out.startsWith("<?xml")
    ? out
    : `<?xml version="1.0" encoding="UTF-8"?>\n${out}`;
  triggerDownload(
    new Blob([withHeader], { type: "image/svg+xml;charset=utf-8" }),
    filename,
  );
}

// Rasterize the SVG to a PNG Blob at `scale`× its intrinsic size, over an opaque
// themed background (the diagram's SVG has no full-canvas fill, so a bare canvas
// would be transparent).
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const { width, height } = svgIntrinsicSize(svg);
  const sized = normalizeSvg(forExport(svg), { w: width, h: height });
  // A UTF-8 data URL (not a blob: URL) is the most reliable source for an <img>
  // rasterizing an SVG — blob: SVGs intermittently fail to decode in <img>.
  // encodeURIComponent keeps multi-byte glyphs and reserved chars intact.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("SVG could not be loaded for export"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.fillStyle = resolvedTheme() === "dark" ? DARK.background : LIGHT.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))),
      "image/png",
    );
  });
}

export async function downloadPng(
  svg: string,
  filename = "diagram.png",
  scale = 2,
): Promise<void> {
  triggerDownload(await svgToPng(svg, scale), filename);
}
