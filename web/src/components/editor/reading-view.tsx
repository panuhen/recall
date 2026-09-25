"use client";

import { isValidElement } from "react";
import Markdown, { type Options as MarkdownOptions } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import { MermaidDiagram } from "./mermaid-diagram";

type RehypePlugins = NonNullable<MarkdownOptions["rehypePlugins"]>;

// rehype-highlight config: `detect` auto-detects the language of *untagged*
// fenced blocks (so ```lang tagging stays optional); `ignoreMissing` leaves a
// block with an unregistered language (notably ```mermaid) untouched — its
// text node stays intact so the mermaid override below still reads the raw
// source. Only block code (code inside <pre>) is processed; inline code is
// left alone.
const HIGHLIGHT_PLUGIN: RehypePlugins[number] = [
  rehypeHighlight,
  { detect: true, ignoreMissing: true },
];

// Fully-rendered read-only view (Reading mode). Standard CommonMark + GFM via
// react-markdown, so it matches what VSCode/GitHub render for an exported file.

// Frontmatter is surfaced in the Properties panel, not the rendered body.
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
// Obsidian wikilinks aren't standard markdown; render them as styled text.
const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

function preprocess(body: string): string {
  return body.replace(FRONTMATTER, "").replace(WIKILINK, (_m, inner: string) => {
    const [target, alias] = inner.split("|");
    const label = (alias ?? target).trim();
    return `[${label}](wikilink:${encodeURIComponent(target.trim())})`;
  });
}

// Only pass through safe protocols (react-markdown's default plus our wikilink).
const allowUrl = (url: string) =>
  /^(https?:|mailto:|wikilink:|#)/i.test(url) ? url : "";

// Same-page anchor (TOC entry). Scroll to the heading rehype-slug gave that id,
// rather than letting the browser treat it like a navigation. scroll-margin-top
// (globals.css) keeps the target clear of the sticky header.
function scrollToAnchor(href: string) {
  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // malformed escape — fall back to the raw fragment
  }
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  history.replaceState(null, "", href);
  return true;
}

// Resolve a wikilink target (a note title/slug in this workspace) to a note id,
// or null when nothing matches — that link is "unresolved" and rendered inert.
export type LinkResolver = (target: string) => string | null;

export function ReadingView({
  body,
  resolveLink,
  onOpenNote,
  onCreateNote,
  highlight = true,
}: {
  body: string;
  resolveLink?: LinkResolver;
  onOpenNote?: (id: string) => void;
  // Click on a link to a note that doesn't exist yet → create it (editors
  // only; without it such links stay inert).
  onCreateNote?: (target: string) => void;
  // Syntax-highlight rendered code blocks (Settings → Appearance). When off,
  // code blocks render as plain monospace.
  highlight?: boolean;
}) {
  const rehypePlugins: RehypePlugins = highlight
    ? [rehypeSlug, HIGHLIGHT_PLUGIN]
    : [rehypeSlug];
  return (
    <div className="md-reading">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        urlTransform={allowUrl}
        components={{
          a({ href, children }) {
            if (href?.startsWith("wikilink:")) {
              const target = decodeURIComponent(href.slice("wikilink:".length));
              const id = resolveLink?.(target) ?? null;
              // Resolved → a clickable link that opens the target note (a plain
              // click here navigates; the source stays open as a tab). Unresolved
              // → dimmed like Obsidian's; clicking creates the note when the
              // reader may edit, else it's inert.
              if (id && onOpenNote) {
                return (
                  <span
                    role="link"
                    tabIndex={0}
                    className="md-wikilink md-wikilink-live"
                    onClick={() => onOpenNote(id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenNote(id);
                      }
                    }}
                  >
                    {children}
                  </span>
                );
              }
              if (onCreateNote) {
                return (
                  <span
                    role="link"
                    tabIndex={0}
                    className="md-wikilink md-wikilink-dead cursor-pointer"
                    title="No note with this title yet. Click to create it"
                    onClick={() => onCreateNote(target)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onCreateNote(target);
                      }
                    }}
                  >
                    {children}
                  </span>
                );
              }
              return (
                <span
                  className="md-wikilink md-wikilink-dead"
                  title="No note with this title in this workspace"
                >
                  {children}
                </span>
              );
            }
            if (href?.startsWith("#")) {
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    // Only intercept when the target exists on this page; a
                    // dangling anchor keeps the default (harmless) behavior.
                    if (scrollToAnchor(href)) e.preventDefault();
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          // A ```mermaid fenced block renders as a diagram; every other code
          // block/inline stays a plain <code> (unchanged behavior).
          code({ className, children }) {
            if (/(^|\s)language-mermaid(\s|$)/.test(className ?? "")) {
              return <MermaidDiagram code={String(children).replace(/\n$/, "")} />;
            }
            return <code className={className}>{children}</code>;
          },
          // Drop the <pre> chrome around a mermaid diagram (the code() override
          // above already returned the diagram); keep it for real code blocks.
          pre({ children }) {
            const only = Array.isArray(children)
              ? children.find((c) => isValidElement(c))
              : children;
            if (isValidElement(only) && only.type === MermaidDiagram) {
              return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {preprocess(body)}
      </Markdown>
    </div>
  );
}
