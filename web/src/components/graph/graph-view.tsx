"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// react-force-graph-2d touches `window`/`canvas`, so it must be client-only.
// dynamic() erases the ref/generics, so we treat the component as `any`.
const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d").then((m) => m.default),
  { ssr: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) as any;

// Kinded graph payload — shared by the per-workspace graph (all nodes "note",
// links "link") and the root structure graph (workspaces/folders/notes, with
// "contains" + "link" edges).
export type GraphViewKind = "project" | "folder" | "note";
export type GraphViewNode = { id: string; label: string; kind: GraphViewKind };
export type GraphViewLink = {
  source: string;
  target: string;
  kind: "contains" | "link";
};
export type GraphViewData = { nodes: GraphViewNode[]; links: GraphViewLink[] };

type GNode = GraphViewNode & { deg: number; r: number; x?: number; y?: number };

// Show note/folder labels only past this zoom (or when highlighted); workspace
// labels always show as anchors, so a large graph stays tidy.
const LABEL_ZOOM = 1.5;
const BASE_R: Record<GraphViewKind, number> = { project: 7, folder: 4.5, note: 2.5 };
// Wikilink arrowhead geometry, in graph (world) units, so it scales with the
// nodes. Length along the edge + half-width across it.
const ARROW_LEN = 1;
const ARROW_HALF = 0.4;

type Colors = { fg: string; muted: string; font: string };

// Resolve theme colors to concrete rgb() strings and the UI font to its
// concrete family (via a probe element, so it tracks the active theme and is
// canvas-safe — canvas can't read CSS vars, but it can render the resolved
// family by name). The app palette is monochrome, so we encode node kind with
// size + tone and edge kind with solid vs dashed.
function readColors(host: HTMLElement): Colors {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.style.fontFamily = "var(--font-sans)";
  host.appendChild(probe);
  const read = (v: string) => {
    probe.style.color = `var(${v})`;
    return getComputedStyle(probe).color;
  };
  const colors: Colors = {
    fg: read("--foreground"),
    muted: read("--muted-foreground"),
    font: getComputedStyle(probe).fontFamily,
  };
  host.removeChild(probe);
  return colors;
}

// Edge (and matching arrowhead) style: which theme color, and how strongly it
// reads. Wikilinks ride on --foreground; the structural "contains" edges on the
// quieter --muted-foreground. On hover, the focused note's edges come forward
// and everything else recedes.
//
// Alpha is applied at paint time via ctx.globalAlpha — NOT spliced into the color
// string. Canvas renders the resolved token directly (as the solid node fills
// do), so we avoid parsing getComputedStyle's output, whose form varies by
// browser (oklch / oklab / lab / color()). The old string-munging built
// rgba(97.5, 0, 0, a) — dark red — when a browser serialized --foreground as
// lab(97.5 0 0), which is why edges rendered red in dark mode.
function edgeStyle(
  l: { kind: string },
  colors: Colors,
  hovering: boolean,
  highlighted: boolean,
): { color: string; alpha: number } {
  if (hovering) {
    return highlighted
      ? { color: colors.fg, alpha: 0.85 }
      : { color: colors.muted, alpha: 0.08 };
  }
  return l.kind === "link"
    ? { color: colors.fg, alpha: 0.55 }
    : { color: colors.muted, alpha: 0.4 };
}

export function GraphView({
  data,
  onSelect,
}: {
  data: GraphViewData;
  onSelect: (node: GraphViewNode) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [colors, setColors] = useState<Colors | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const hi = useRef<{ nodes: Set<string>; links: Set<object> }>({
    nodes: new Set(),
    links: new Set(),
  });

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const refresh = () => setColors(readColors(el));
    refresh();
    // Theme lives in the data-theme attribute on <html> (see use-theme.ts);
    // refresh the resolved colors/font when it flips.
    const obs = new MutationObserver(refresh);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  const { graphData, adjacency } = useMemo(() => {
    const deg = new Map<string, number>();
    for (const l of data.links) {
      deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
      deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
    }
    const nodes: GNode[] = data.nodes.map((n) => {
      const d = deg.get(n.id) ?? 0;
      const r =
        n.kind === "note" ? BASE_R.note + Math.min(Math.sqrt(d) * 1.0, 4) : BASE_R[n.kind];
      return { ...n, deg: d, r };
    });
    const links = data.links.map((l) => ({ source: l.source, target: l.target, kind: l.kind }));
    const adjacency = new Map<string, Set<string>>();
    const connect = (a: string, b: string) => {
      let set = adjacency.get(a);
      if (!set) {
        set = new Set();
        adjacency.set(a, set);
      }
      set.add(b);
    };
    for (const l of data.links) {
      connect(l.source, l.target);
      connect(l.target, l.source);
    }
    return { graphData: { nodes, links }, adjacency };
  }, [data]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleHover(node: any) {
    if (!node) {
      hi.current = { nodes: new Set(), links: new Set() };
      setHover(null);
      return;
    }
    const nodes = new Set<string>([node.id, ...(adjacency.get(node.id) ?? [])]);
    const links = new Set<object>();
    for (const l of graphData.links) {
      const src = l.source as unknown;
      const tgt = l.target as unknown;
      const s = typeof src === "object" && src ? (src as GNode).id : (src as string);
      const t = typeof tgt === "object" && tgt ? (tgt as GNode).id : (tgt as string);
      if (s === node.id || t === node.id) links.add(l);
    }
    hi.current = { nodes, links };
    setHover(node.id);
  }

  if (data.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Nothing to show yet.
      </div>
    );
  }

  return (
    <div ref={hostRef} className={`h-full w-full ${hover ? "cursor-pointer" : ""}`}>
      {colors && size.w > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graphData}
          nodeRelSize={1}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeLabel={(n: any) => n.label || "Untitled"}
          onNodeHover={handleHover}
          onNodeClick={(n: GNode) => onSelect(n)}
          onBackgroundClick={() => handleHover(null)}
          cooldownTicks={100}
          onEngineStop={() => fgRef.current?.zoomToFit(400, 48)}
          // Paint links by hand (replace mode). react-force-graph always runs
          // its own line the full center-to-center distance and draws its
          // arrowhead on top, so a translucent arrow lets the line bleed through
          // (the reason the old fix forced an opaque arrow that then popped out
          // when edges dimmed). Owning the paint lets the line stop at the
          // arrowhead's base and the arrow share the edge's exact color/alpha,
          // so the head dims and brightens together with its line.
          linkCanvasObjectMode={() => "replace"}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkCanvasObject={(l: any, ctx: CanvasRenderingContext2D, scale: number) => {
            const s = l.source;
            const t = l.target;
            if (!s || !t || typeof s.x !== "number" || typeof t.x !== "number") return;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const len = Math.hypot(dx, dy);
            const sr = typeof s.r === "number" ? s.r : BASE_R.note;
            const tr = typeof t.r === "number" ? t.r : BASE_R.note;
            if (len <= sr + tr) return; // nodes overlap — nothing between them
            const ux = dx / len;
            const uy = dy / len;

            const isLink = l.kind === "link";
            const highlighted = hi.current.links.has(l);
            const { color, alpha } = edgeStyle(l, colors, !!hover, highlighted);

            // Segment runs edge-to-edge; wikilinks reserve the last ARROW_LEN
            // for the arrowhead, so the line ends at its base (the tip lands on
            // the target node's edge, the head shrinks for very short links).
            const startX = s.x + ux * sr;
            const startY = s.y + uy * sr;
            const tipX = t.x - ux * tr;
            const tipY = t.y - uy * tr;
            const arrow = isLink ? Math.min(ARROW_LEN, len - sr - tr) : 0;
            const endX = tipX - ux * arrow;
            const endY = tipY - uy * arrow;

            ctx.globalAlpha = alpha; // translucency via the alpha channel, not the color string
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.strokeStyle = color;
            ctx.lineWidth = (hover && highlighted ? 1.5 : 1) / scale;
            ctx.setLineDash(isLink ? [4, 3] : []); // dashed wikilinks, solid "contains"
            ctx.stroke();
            ctx.setLineDash([]); // don't leak the dash into the next paint

            if (arrow > 0) {
              const px = -uy; // unit normal to the edge
              const py = ux;
              ctx.beginPath();
              ctx.moveTo(tipX, tipY);
              ctx.lineTo(endX + px * ARROW_HALF, endY + py * ARROW_HALF);
              ctx.lineTo(endX - px * ARROW_HALF, endY - py * ARROW_HALF);
              ctx.closePath();
              ctx.fillStyle = color;
              ctx.fill();
            }
            ctx.globalAlpha = 1; // reset so it doesn't bleed into the next paint
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
            const dimmed = hover && !hi.current.nodes.has(node.id);
            const lit = hover && hi.current.nodes.has(node.id);
            ctx.globalAlpha = dimmed ? 0.2 : 1;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.r, 0, 2 * Math.PI);
            ctx.fillStyle = lit || node.kind === "project" ? colors.fg : colors.muted;
            ctx.fill();
            if (node.kind === "project" || lit || scale >= LABEL_ZOOM) {
              const fontSize = 12 / scale;
              ctx.font = `${fontSize}px ${colors.font}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = lit || node.kind === "project" ? colors.fg : colors.muted;
              ctx.fillText(node.label || "Untitled", node.x, node.y + node.r + 2 / scale);
            }
            ctx.globalAlpha = 1;
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.r + 2, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />
      )}
    </div>
  );
}

// Adapt the per-workspace note graph (notes + wikilinks) into the kinded view
// shape: every node is a "note", every edge a "link".
export function noteGraphToView(d: {
  nodes: { id: string; title: string }[];
  links: { source: string; target: string }[];
}): GraphViewData {
  return {
    nodes: d.nodes.map((n) => ({ id: n.id, label: n.title, kind: "note" })),
    links: d.links.map((l) => ({ source: l.source, target: l.target, kind: "link" })),
  };
}
