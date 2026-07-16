"use client";

import { Globe, Loader2, Pin, PinOff, Search as SearchIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  listOrgProjects,
  type OrgProject,
  pinProject,
  unpinProject,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// Owns the Browse dialog and renders it. Mounted once in (app)/layout.tsx; the
// sidebar's Compass toolbar button calls openBrowse(). Mirrors SearchProvider.
// Pinning here broadcasts "recall:pins" so the sidebar refreshes its org list.
type BrowseCtx = { openBrowse: () => void };
const Ctx = createContext<BrowseCtx | null>(null);

export function useBrowse() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBrowse must be used within BrowseProvider");
  return ctx;
}

export function BrowseProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ openBrowse: () => setOpen(true) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <BrowseDialog open={open} onClose={() => setOpen(false)} />
    </Ctx.Provider>
  );
}

function BrowseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [items, setItems] = useState<OrgProject[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setQuery("");
    listOrgProjects()
      .then(({ projects }) => setItems(projects))
      .catch(() => setItems([]));
  }, [open]);

  // Client-side filter over the loaded list, on workspace name + owner.
  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (o) =>
        o.name.toLowerCase().includes(q) || o.owner_name.toLowerCase().includes(q),
    );
  }, [items, query]);

  async function toggle(o: OrgProject) {
    setBusy(o.id);
    try {
      if (o.pinned) await unpinProject(o.id);
      else await pinProject(o.id);
      setItems((prev) =>
        prev ? prev.map((x) => (x.id === o.id ? { ...x, pinned: !x.pinned } : x)) : prev,
      );
      window.dispatchEvent(new Event("recall:pins"));
    } catch {
      toast("Couldn’t update pin.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-lg"
      title={
        <span className="flex items-center gap-2">
          <Globe size={16} className="text-muted-foreground" />
          Browse workspaces
        </span>
      }
      description="Workspaces shared with everyone in your organisation. Pin the ones you want in your sidebar."
    >
      {items && items.length > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-md border px-2.5">
          <SearchIcon size={15} className="shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter workspaces…"
            aria-label="Filter workspaces"
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <div className="mt-3 max-h-[24rem] overflow-y-auto">
        {items === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No workspaces are shared organisation-wide yet.
          </div>
        ) : filtered && filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No workspaces match “{query.trim()}”.
          </div>
        ) : (
          <ul className="space-y-0.5">
            {(filtered ?? []).map((o) => (
              <li key={o.id} className="flex items-center gap-3 rounded-md px-1 py-1.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground">
                  <Globe size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{o.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {o.owner_name} · {o.member_count} member
                    {o.member_count === 1 ? "" : "s"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void toggle(o)}
                  disabled={busy === o.id}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                    o.pinned
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                    busy === o.id && "opacity-50",
                  )}
                >
                  {o.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  {o.pinned ? "Pinned" : "Pin"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
