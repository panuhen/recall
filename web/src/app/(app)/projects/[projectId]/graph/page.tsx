"use client";

// Per-workspace knowledge graph, full-screen. Split-dock counterpart: graph-dock.tsx.
import { Columns2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useState } from "react";

import { useGraphDock } from "@/components/graph/graph-dock-context";
import {
  GraphView,
  noteGraphToView,
  type GraphViewData,
} from "@/components/graph/graph-view";
import { getGraph, type GraphData } from "@/lib/api";

export default function GraphPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const { openDock } = useGraphDock();
  const [data, setData] = useState<GraphData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    getGraph(projectId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const view = useMemo<GraphViewData>(
    () => (data ? noteGraphToView(data) : { nodes: [], links: [] }),
    [data],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-8">
        <span className="text-sm font-medium">Graph</span>
        {data && (
          <span className="text-sm text-muted-foreground">
            {data.nodes.length} {data.nodes.length === 1 ? "note" : "notes"} ·{" "}
            {data.links.length} {data.links.length === 1 ? "link" : "links"}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            openDock(projectId);
            router.back();
          }}
          title="Open in split view"
          className="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Columns2 size={15} />
          Split view
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {err ? (
          <div className="p-8 text-sm text-destructive">{err}</div>
        ) : !data ? (
          <div className="p-8 text-sm text-muted-foreground">loading…</div>
        ) : (
          <GraphView data={view} onSelect={(n) => router.push(`/notes/${n.id}`)} />
        )}
      </div>
    </div>
  );
}
