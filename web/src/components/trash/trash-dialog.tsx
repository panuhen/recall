"use client";

import { FileText, Folder, Layers, RotateCcw, Search as SearchIcon, Trash2 } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Dialog } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  listTrash,
  purgeTrashItem,
  restoreTrashItem,
  type TrashItem,
  type TrashKind,
  type TrashResponse,
} from "@/lib/api";
import { triggerRevalidate } from "@/lib/revalidate";
import { relativeTime } from "@/lib/time";

// Owns the Trash dialog's open state and renders it. Mounted once in
// (app)/layout.tsx; the sidebar's "Trash" action calls openTrash(). Mirrors
// SettingsProvider / ShareDialogProvider.
type TrashCtx = { openTrash: () => void };
const Ctx = createContext<TrashCtx | null>(null);

export function useTrash() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTrash must be used within TrashProvider");
  return ctx;
}

export function TrashProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ openTrash: () => setOpen(true) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <TrashDialog open={open} onClose={() => setOpen(false)} />
    </Ctx.Provider>
  );
}

const ICON: Record<TrashKind, ReactNode> = {
  project: <Layers size={16} className="text-muted-foreground" />,
  folder: <Folder size={16} className="text-muted-foreground" />,
  note: <FileText size={16} className="text-muted-foreground" />,
};

// What a restore / permanent-delete brings along, so the confirm copy is honest
// about the blast radius (folders and workspaces take their contents with them).
const SCOPE: Record<TrashKind, string> = {
  project: "this workspace and everything inside it",
  folder: "this folder and everything inside it",
  note: "this note",
};

function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<TrashResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // The id currently being restored/purged, so its row can disable + show state.
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const confirm = useConfirm();
  const { toast } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    listTrash()
      .then(setData)
      .catch(() => toast("Couldn’t load Trash.", "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    if (open) {
      setQuery("");
      load();
    }
  }, [open, load]);

  const items: TrashItem[] = useMemo(() => {
    if (!data) return [];
    // Workspaces first, then folders, then notes — each already newest-first.
    return [...data.projects, ...data.folders, ...data.notes];
  }, [data]);

  // Client-side filter over the loaded list, on item name + its workspace name.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        (i.project_name ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  async function restore(item: TrashItem) {
    setBusy(item.id);
    try {
      await restoreTrashItem(item.type, item.id);
      toast(`Restored “${item.label}”.`);
      triggerRevalidate(); // refresh the sidebar + any open note immediately
      load();
    } catch {
      toast("Couldn’t restore — the workspace may need restoring first.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function purge(item: TrashItem) {
    const ok = await confirm({
      title: `Delete “${item.label}” permanently?`,
      description: `This will permanently delete ${SCOPE[item.type]}. This can’t be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      await purgeTrashItem(item.type, item.id);
      toast(`Deleted “${item.label}” permanently.`);
      triggerRevalidate();
      load();
    } catch {
      toast("Couldn’t delete permanently.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Trash"
      description="Deleted items are kept here until you restore or permanently delete them."
      className="max-w-lg"
    >
      {items.length > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-md border px-2.5">
          <SearchIcon size={15} className="shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter deleted items…"
            aria-label="Filter deleted items"
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <div className="mt-3 max-h-[60vh] overflow-y-auto">
        {loading && !data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Trash is empty.
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No items match “{query.trim()}”.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((item) => (
              <li
                key={`${item.type}:${item.id}`}
                className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
              >
                {ICON[item.type]}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{item.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {item.project_name ? `${item.project_name} · ` : ""}
                    deleted {relativeTime(item.archived_at)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => void restore(item)}
                  title="Restore"
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                >
                  <RotateCcw size={14} />
                  Restore
                </button>
                <button
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => void purge(item)}
                  title="Delete permanently"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
