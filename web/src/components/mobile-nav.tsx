"use client";

import { Menu, Search } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useSearch } from "@/components/search/search-dialog";
import { cn } from "@/lib/utils";

// Below `md` the sidebar is an off-canvas drawer rather than a fixed rail; this
// context is the single source of truth for whether that drawer is open. The
// sidebar reads it to slide in/out and render its scrim; the top bar's hamburger
// (and opening a note) flips it. On `md`+ the drawer classes are inert, so this
// state simply goes unused.
type MobileNavCtx = { open: boolean; setOpen: (open: boolean) => void };

const Ctx = createContext<MobileNavCtx | null>(null);

export function useMobileNav() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMobileNav must be used within MobileNavProvider");
  return ctx;
}

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Slim top bar shown only below `md`, where the rail collapses to a drawer. It
// keeps every mobile screen — including the empty home page — one tap from
// navigation (hamburger → drawer) and from search, the primary way back to a
// note. Hidden at `md`+, where the rail and its own toolbar take over.
export function MobileTopBar() {
  const { setOpen } = useMobileNav();
  const { openSearch } = useSearch();
  const btn =
    "flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground";
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-tab-border bg-sidebar px-2 md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className={btn}
      >
        <Menu size={20} />
      </button>
      {/* Same theme-aware triangle mark + wordmark as the sidebar's band 1. */}
      <span className="flex items-center gap-1.5 text-base font-semibold tracking-tight">
        <span className="recall-logo size-[1.1em] shrink-0" aria-hidden>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12.00,0.94 L23.70,22.00 L5.45,22.00 L6.56,20.00 L20.30,20.00 L12.00,5.06 L2.59,22.00 L0.30,22.00Z"
              fill="var(--foreground)"
            />
          </svg>
        </span>
        re:call
      </span>
      <button
        type="button"
        onClick={() => openSearch()}
        aria-label="Search"
        className={cn(btn, "ml-auto")}
      >
        <Search size={20} />
      </button>
    </div>
  );
}
