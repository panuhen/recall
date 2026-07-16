"use client";

// Root structure graph (all workspaces), full-screen. Dock counterpart: graph-dock.tsx.
import { Columns2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useGraphDock } from "@/components/graph/graph-dock-context";
import { GraphView } from "@/components/graph/graph-view";
import { getRootGraph, type RootGraphData } from "@/lib/api";

export default function RootGraphPage() {
  const router = useRouter();
  const { openRootDock } = useGraphDock();
  const [data, setData] = useState<RootGraphData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    getRootGraph()
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-8">
        <span className="text-sm font-medium">All workspaces</span>
        {data && (
          <span className="text-sm text-muted-foreground">
            {data.nodes.length} {data.nodes.length === 1 ? "node" : "nodes"} ·{" "}
            {data.links.length} {data.links.length === 1 ? "link" : "links"}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            openRootDock();
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
          <GraphView
            data={data}
            onSelect={(n) => n.kind === "note" && router.push(`/notes/${n.id}`)}
          />
        )}
      </div>
    </div>
  );
}
