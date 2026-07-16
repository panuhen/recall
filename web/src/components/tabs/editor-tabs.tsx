"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ChevronLeft, ChevronRight, FolderTree, X } from "lucide-react";
import { useParams, useRouter } from "next/navigation";

import { SidebarContextMenu, type MenuItem } from "@/components/sidebar-context-menu";
import { cn } from "@/lib/utils";
import { useTabs } from "./tabs-context";

// Obsidian-style editor tab strip. Tabs are a fixed width; when they don't all
// fit, the strip scrolls horizontally (no scrollbar) and reveals chevron
// buttons that page through them — the strip height stays h-9 so it keeps
// aligning with the sidebar's wordmark band. Hidden below md (the fixed-width,
// chevron-paged model doesn't suit touch); there the drawer + search navigate,
// and the open-tab set persists for when you're back on desktop.
export function EditorTabs() {
  const { tabs, closeTab, closeAllTabs } = useTabs();
  const router = useRouter();
  const params = useParams();
  const activeId = typeof params.noteId === "string" ? params.noteId : null;

  const scrollerRef = useRef<HTMLDivElement>(null);
  // Whether there's hidden content to either side (drives the chevrons).
  const [more, setMore] = useState({ left: false, right: false });
  // Right-click menu: cursor position + the tab it was opened on (null = closed).
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setMore({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  // Re-measure on tab-count changes and whenever the strip is resized.
  useLayoutEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tabs.length]);

  // Keep the active tab in view when the route changes.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !activeId) return;
    const node = el.querySelector<HTMLElement>(`[data-tab="${activeId}"]`);
    if (node) {
      const n = node.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      if (n.left < e.left) el.scrollBy({ left: n.left - e.left - 8 });
      else if (n.right > e.right) el.scrollBy({ left: n.right - e.right + 8 });
    }
    measure();
  }, [activeId, tabs.length, measure]);

  if (tabs.length === 0) return null;

  function close(id: string) {
    if (id === activeId) {
      const i = tabs.findIndex((t) => t.id === id);
      const next = tabs[i + 1] ?? tabs[i - 1];
      closeTab(id);
      router.push(next ? `/notes/${next.id}` : "/");
    } else {
      closeTab(id);
    }
  }

  function closeAll() {
    closeAllTabs();
    router.push("/");
  }

  const menuItems: MenuItem[] = menu
    ? [
        {
          label: "Show in Explorer",
          icon: <FolderTree size={15} />,
          // The sidebar owns the tree/expand state, so ask it to reveal the note.
          onSelect: () =>
            window.dispatchEvent(
              new CustomEvent("recall:reveal-note", { detail: menu.id }),
            ),
        },
        { divider: true },
        { label: "Close", icon: <X size={15} />, onSelect: () => close(menu.id) },
        {
          label: `Close all tabs (${tabs.length})`,
          icon: <X size={15} />,
          onSelect: closeAll,
        },
      ]
    : [];

  function page(dir: -1 | 1) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: "smooth" });
  }

  const showNav = more.left || more.right;

  return (
    <div className="relative flex h-9 shrink-0 items-stretch bg-tab-bar pt-1 max-md:hidden">
      {/* Baseline along the bottom of the strip. It sits behind the tabs: the
          opaque active tab hides its segment (so the tab merges with content),
          transparent inactive tabs let it show — the line runs left and right
          of the active tab, like Obsidian. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-tab-border"
      />

      <div
        ref={scrollerRef}
        onScroll={measure}
        className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden px-1.5"
      >
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const prevActive = i > 0 && tabs[i - 1].id === activeId;
          const showDivider = i > 0 && !active && !prevActive;
          const label = t.title || "Untitled";
          return (
            <Fragment key={t.id}>
              {showDivider && <div aria-hidden className="my-2 w-px shrink-0 bg-tab-border" />}
              <div
                data-tab={t.id}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    close(t.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, id: t.id });
                }}
                className={cn(
                  "group relative flex w-40 shrink-0 items-center gap-1 pl-3 pr-1.5 text-sm",
                  active
                    ? "rounded-t-lg border border-b-0 border-tab-border bg-background text-foreground"
                    : "mx-1 mb-1 rounded-md text-muted-foreground hover:bg-background/50",
                )}
              >
                <button
                  type="button"
                  onClick={() => router.push(`/notes/${t.id}`)}
                  className="min-w-0 flex-1 cursor-pointer truncate py-1.5 text-left"
                  title={label}
                >
                  {label}
                </button>
                <button
                  type="button"
                  onClick={() => close(t.id)}
                  aria-label={`Close ${label}`}
                  className={cn(
                    "shrink-0 rounded p-0.5 hover:bg-muted",
                    active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70",
                  )}
                >
                  <X size={14} />
                </button>
              </div>
            </Fragment>
          );
        })}
      </div>

      {showNav && (
        <div className="flex shrink-0 items-center gap-0.5 border-l border-tab-border pl-1 pr-1.5">
          <button
            type="button"
            onClick={() => page(-1)}
            disabled={!more.left}
            aria-label="Scroll tabs left"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => page(1)}
            disabled={!more.right}
            aria-label="Scroll tabs right"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
