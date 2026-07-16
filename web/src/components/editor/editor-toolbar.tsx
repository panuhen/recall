"use client";

import type { EditorView } from "@codemirror/view";
import {
  Bold,
  Code,
  ExternalLink,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Quote,
  SquareCode,
  Strikethrough,
  Table,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useMobileNav } from "@/components/mobile-nav";
import {
  bulletList,
  insertCodeBlock,
  insertExternalLink,
  insertHorizontalRule,
  insertTable,
  numberedList,
  setHeading,
  toggleQuote,
} from "./editor-commands";
import { toggleWrap, wrapWikilink } from "./format-commands";

type Run = (v: EditorView) => void | Promise<void>;
type Leaf = { label: string; icon: ReactNode; run: Run };
// A submenu: one toolbar button that opens a popover of related commands
// (heading levels, list types, or the overflow "More" actions).
type Menu = { label: string; icon: ReactNode; items: Leaf[] };
// A toolbar slot is either a one-tap command or a submenu button.
type Slot = Leaf | Menu;

const isMenu = (slot: Slot): slot is Menu => "items" in slot;

// The formatting commands from the desktop right-click menu (minus
// clipboard/select, which the mobile OS handles via native selection). The row
// keeps the common ones inline — links, bold/italic/strikethrough, Heading,
// List — and tucks the rest (inline code, Code block, Quote, Table, Horizontal
// rule) behind a "More" (⋯) menu so it fits without scrolling on a phone.
// Heading, List, and More each open a popover.
const SLOTS: Slot[] = [
  { label: "Add link", icon: <Link size={18} />, run: (v) => void wrapWikilink(v) },
  { label: "Add external link", icon: <ExternalLink size={18} />, run: insertExternalLink },
  { label: "Bold", icon: <Bold size={18} />, run: (v) => void toggleWrap("**")(v) },
  { label: "Italic", icon: <Italic size={18} />, run: (v) => void toggleWrap("*")(v) },
  { label: "Strikethrough", icon: <Strikethrough size={18} />, run: (v) => void toggleWrap("~~")(v) },
  {
    label: "Heading",
    icon: <Heading size={18} />,
    items: [
      { label: "Heading 1", icon: <Heading1 size={16} />, run: setHeading(1) },
      { label: "Heading 2", icon: <Heading2 size={16} />, run: setHeading(2) },
      { label: "Heading 3", icon: <Heading3 size={16} />, run: setHeading(3) },
    ],
  },
  {
    label: "List",
    icon: <List size={18} />,
    items: [
      { label: "Bullet list", icon: <List size={16} />, run: bulletList },
      { label: "Numbered list", icon: <ListOrdered size={16} />, run: numberedList },
    ],
  },
  {
    label: "More",
    icon: <MoreHorizontal size={18} />,
    items: [
      { label: "Inline code", icon: <Code size={16} />, run: (v) => void toggleWrap("`")(v) },
      { label: "Code block", icon: <SquareCode size={16} />, run: insertCodeBlock },
      { label: "Quote", icon: <Quote size={16} />, run: toggleQuote },
      { label: "Table", icon: <Table size={16} />, run: insertTable },
      { label: "Horizontal rule", icon: <Minus size={16} />, run: insertHorizontalRule },
    ],
  },
];

const BTN =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground";

// Mobile-only formatting toolbar. Touch has no right-click, so the formatting
// commands otherwise behind the editor context menu live here. Pinned to the
// bottom of the *visual* viewport so it rides above the on-screen keyboard —
// iOS Safari shrinks the visual viewport but not the layout one, so a plain
// `fixed bottom-0` would hide behind the keyboard. Hidden at md+, where
// right-click and keyboard shortcuts take over.
export function EditorToolbar({ view }: { view: EditorView }) {
  const { open: navOpen } = useMobileNav();
  const [bottom, setBottom] = useState(0);
  // The open submenu popover (heading levels, list types) with its viewport
  // anchor; null when none is open.
  const [menu, setMenu] = useState<
    { items: Leaf[]; label: string; left: number; bottom: number } | null
  >(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // The gap between the layout-viewport bottom and the visual-viewport bottom
    // is ~the keyboard height; sit just above it (0 when the keyboard is down).
    const update = () =>
      setBottom(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // The bar is fixed to the bottom at the drawer's z-layer; while the mobile nav
  // drawer is open it would sit on top of the drawer footer, so step aside.
  if (navOpen) return null;

  // Run a command and hand focus back so the keyboard stays and the edit lands.
  const run = (fn: Run) => {
    void fn(view);
    view.focus();
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Formatting"
        style={{ bottom }}
        // Horizontal buffer so the outer icons clear the phone's rounded
        // corners; `max(…, env())` keeps a base 12px in portrait and grows to
        // the safe-area inset (e.g. a landscape notch) where the device reports
        // one.
        className="no-scrollbar fixed inset-x-0 z-40 flex items-stretch justify-center gap-0.5 overflow-x-auto border-t border-tab-border bg-sidebar pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] md:hidden"
      >
        {SLOTS.map((slot) => {
          if (isMenu(slot)) {
            return (
              <button
                key={slot.label}
                type="button"
                aria-label={slot.label}
                title={slot.label}
                aria-haspopup="menu"
                aria-expanded={menu?.label === slot.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  // Toggle: a second tap on the open menu's button closes it.
                  if (menu?.label === slot.label) {
                    setMenu(null);
                    return;
                  }
                  // Anchor the popover just above this button; the scroll
                  // container would clip an in-flow popover, so it's fixed.
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({
                    items: slot.items,
                    label: slot.label,
                    left: r.left,
                    bottom: window.innerHeight - r.top + 6,
                  });
                }}
                className={BTN}
              >
                {slot.icon}
              </button>
            );
          }
          return (
            <button
              key={slot.label}
              type="button"
              aria-label={slot.label}
              title={slot.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(slot.run)}
              className={BTN}
            >
              {slot.icon}
            </button>
          );
        })}
      </div>

      {menu && (
        <>
          {/* Tap-away backdrop (transparent). */}
          <div
            className="fixed inset-0 z-40 md:hidden"
            aria-hidden
            onClick={() => setMenu(null)}
          />
          <div
            role="menu"
            aria-label={`${menu.label} options`}
            style={{
              left: Math.max(8, Math.min(menu.left, window.innerWidth - 152)),
              bottom: menu.bottom,
            }}
            className="fixed z-50 min-w-36 rounded-md border bg-card p-1 text-sm shadow-md md:hidden"
          >
            {menu.items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  run(item.run);
                  setMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
