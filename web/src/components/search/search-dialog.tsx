"use client";

import { FileText, Loader2, Search as SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useTabs } from "@/components/tabs/tabs-context";
import { search, type SearchResult } from "@/lib/api";
import { cn } from "@/lib/utils";

// Owns the search palette's open state and the global ⌘K/Ctrl+K shortcut, and
// renders the dialog. Mounted once in (app)/layout.tsx (inside TabsProvider, so
// selecting a result can open an editor tab). The sidebar Search button and the
// shortcut both call `openSearch`.
type SearchCtx = { openSearch: () => void };
const Ctx = createContext<SearchCtx | null>(null);

export function useSearch() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSearch must be used within SearchProvider");
  return ctx;
}

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo(() => ({ openSearch: () => setOpen(true) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <SearchDialog open={open} onClose={() => setOpen(false)} />
    </Ctx.Provider>
  );
}

const DEBOUNCE_MS = 180;

function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { openTab } = useTabs();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  // Guards against out-of-order responses: only the latest request may commit.
  const reqId = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Fresh state each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setResults([]);
    setActive(0);
    setLoading(false);
  }, [open]);

  // Escape closes; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // Debounced hybrid search on every query change.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqId.current;
    const t = setTimeout(() => {
      search(query, { limit: 20 })
        .then((r) => {
          if (id !== reqId.current) return; // a newer query superseded this one
          setResults(r.results);
          setActive(0);
          setLoading(false);
        })
        .catch(() => {
          if (id !== reqId.current) return;
          setResults([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, open]);

  const openResult = useCallback(
    (r: SearchResult) => {
      openTab(r.id, r.title || "Untitled");
      router.push(`/notes/${r.id}`);
      onClose();
    },
    [openTab, router, onClose],
  );

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) openResult(r);
    }
  }

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open || typeof document === "undefined") return null;

  const query = q.trim();
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search notes"
        className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon size={18} className="shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search notes…"
            aria-label="Search query"
            // text-base (16px) on mobile: a smaller font makes iOS auto-zoom the
            // viewport when the input autofocuses, which shifts the dialog off
            // the left edge. Back to text-sm at md+.
            className="h-12 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          />
          {loading && (
            <Loader2 size={16} className="shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>

        {query && (
          <ul ref={listRef} className="max-h-[50vh] overflow-y-auto p-1">
            {results.length === 0 ? (
              !loading && (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No results
                </li>
              )
            ) : (
              results.map((r, i) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onMouseMove={() => setActive(i)}
                    onClick={() => openResult(r)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left",
                      i === active ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <div className="flex w-full items-center gap-2">
                      <FileText size={14} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {r.title || "Untitled"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {r.project_name}
                      </span>
                    </div>
                    {r.snippet && (
                      <span className="truncate pl-6 text-xs text-muted-foreground">
                        {r.snippet}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
