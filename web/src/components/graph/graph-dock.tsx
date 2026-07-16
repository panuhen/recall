"use client";

import { GripVertical, Maximize2, Network, Waypoints, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useGraphDock } from "@/components/graph/graph-dock-context";
import {
  GraphView,
  noteGraphToView,
  type GraphViewData,
} from "@/components/graph/graph-view";
import { getGraph, getRootGraph } from "@/lib/api";
import { cn } from "@/lib/utils";

// The docked graph panel: sits to the right of the note pane, resizable from its
// left edge. Shows a workspace graph or the root graph, and can pop out to the
// matching full-screen route.
export function GraphDock() {
  const { open, target, width, close, setWidth } = useGraphDock();
  const router = useRouter();
  const [data, setData] = useState<GraphViewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setData(null);
    setErr(null);
    const load: Promise<GraphViewData> =
      target.kind === "root"
        ? getRootGraph()
        : getGraph(target.projectId).then(noteGraphToView);
    load
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, target]);

  if (!open || !target) return null;

  // Drag the left edge to resize. The dock is flush to the viewport's right, so
  // its width is simply the distance from the pointer to that edge.
  function onResizeStart(e: React.PointerEvent) {
    e.preventDefault();
    setResizing(true);
    const onMove = (ev: PointerEvent) => setWidth(window.innerWidth - ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setResizing(false);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const isRoot = target.kind === "root";
  // Resolve the full-screen route here, where `target` is still narrowed (the
  // early return above rules out null, and the discriminant narrows the union).
  // A nested closure loses that narrowing, so we capture the string, not target.
  const graphHref =
    target.kind === "root" ? "/graph" : `/projects/${target.projectId}/graph`;

  function expand() {
    router.push(graphHref);
    close();
  }

  return (
    <aside
      style={{ width }}
      className={cn(
        "flex h-full shrink-0 flex-col border-l border-tab-border bg-background",
        // md+: an in-flow docked panel at the inline `width`.
        "md:relative",
        // Below md: a full-screen overlay — `!w-full` beats the inline width.
        "max-md:fixed max-md:inset-0 max-md:z-40 max-md:!w-full",
      )}
    >
      {/* Left-edge resize handle: a wide, grabbable hit area with a grip pill. */}
      <div
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize graph panel"
        className="group absolute left-0 top-0 z-10 hidden h-full w-3 -translate-x-1/2 cursor-col-resize items-center justify-center md:flex"
      >
        <div
          className={cn(
            "h-full w-px transition-colors",
            resizing ? "bg-primary/60" : "bg-transparent group-hover:bg-primary/40",
          )}
        />
        <div
          className={cn(
            "absolute flex h-7 w-4 items-center justify-center rounded border bg-background shadow-sm transition-opacity",
            resizing ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <GripVertical size={12} className="text-muted-foreground" />
        </div>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {isRoot ? (
          <Network size={16} className="shrink-0 text-muted-foreground" />
        ) : (
          <Waypoints size={16} className="shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">
          {isRoot ? "All workspaces" : "Graph"}
        </span>
        {data && (
          <span className="truncate text-xs text-muted-foreground">
            {data.nodes.length} · {data.links.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* On mobile the dock is already full-screen, so popping out to the
              full-screen route is redundant — hide it there, keep it on desktop
              where it expands the narrow docked panel. */}
          <button
            type="button"
            onClick={expand}
            aria-label="Open graph full screen"
            title="Full screen"
            className="hidden h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:flex"
          >
            <Maximize2 size={15} />
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close graph"
            title="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {err ? (
          <div className="p-4 text-sm text-destructive">{err}</div>
        ) : !data ? (
          <div className="p-4 text-sm text-muted-foreground">loading…</div>
        ) : (
          <GraphView
            data={data}
            onSelect={(n) => {
              if (n.kind !== "note") return;
              router.push(`/notes/${n.id}`);
              // On mobile the dock is a full-screen overlay (not a side panel),
              // so close it on select — otherwise it stays on top, hiding the
              // very note it just navigated to. Desktop keeps it docked open.
              if (window.matchMedia("(max-width: 767.98px)").matches) close();
            }}
          />
        )}
      </div>
    </aside>
  );
}
