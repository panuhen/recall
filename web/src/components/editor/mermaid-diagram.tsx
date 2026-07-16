"use client";

import { Maximize2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  downloadPng,
  downloadSvg,
  nextMermaidId,
  renderMermaid,
  resolvedTheme,
} from "./mermaid";
import { MermaidLightbox } from "./mermaid-lightbox";

// Renders a ```mermaid fenced block in the Reading view. Client-only: the heavy
// Mermaid library is loaded lazily (inside renderMermaid) on first paint, so a
// note without a diagram never downloads it. Re-renders when the app theme
// changes so the monochrome palette tracks light/dark.
export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(resolvedTheme);
  const [id] = useState(nextMermaidId);

  // Follow the app's resolved theme (the data-theme attribute on <html>).
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(resolvedTheme()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    renderMermaid(code, id)
      .then((out) => {
        if (!cancelled) setSvg(out);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // `id` is a stable useState value (never re-set), included to satisfy
    // exhaustive-deps; `theme` re-renders the diagram in the new palette.
  }, [code, id, theme]);

  // Parse/render error: never lose the content — show the raw source so the
  // author can fix it, rather than a broken or blank block.
  if (failed) {
    return (
      <div className="mermaid-error" role="note">
        <span className="mermaid-error-label">Diagram failed to render</span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (svg === null) {
    return <div className="mermaid-loading">Rendering diagram…</div>;
  }

  // svg is sanitized by Mermaid (securityLevel: 'strict') before it reaches here.
  // The figure wraps the diagram + a hover toolbar (expand / export). Clicking
  // the diagram itself opens the zoomable lightbox.
  return (
    <div className="mermaid-figure">
      <div
        className="mermaid-rendered"
        onClick={() => setExpanded(true)}
        role="button"
        tabIndex={0}
        aria-label="Expand diagram"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="mermaid-toolbar" role="group" aria-label="Diagram actions">
        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={() => setExpanded(true)}
          aria-label="Expand and zoom"
          title="Expand and zoom"
        >
          <Maximize2 size={15} />
        </button>
        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={() => downloadSvg(svg)}
          title="Download as SVG"
        >
          SVG
        </button>
        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={() => void downloadPng(svg)}
          title="Download as PNG"
        >
          PNG
        </button>
      </div>
      {expanded && (
        <MermaidLightbox svg={svg} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}
