"use client";

import type { EditorView } from "@codemirror/view";
import {
  Bold,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Code,
  Copy,
  ExternalLink,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Plus,
  Quote,
  Scissors,
  SquareCode,
  Strikethrough,
  Table,
  TextSelect,
  Workflow,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  bulletList,
  copySelection,
  cutSelection,
  insertCodeBlock,
  insertDiagram,
  insertExternalLink,
  insertHorizontalRule,
  insertTable,
  numberedList,
  pasteText,
  selectAll,
  setHeading,
  toggleQuote,
} from "./editor-commands";
import { toggleWrap, wrapWikilink } from "./format-commands";

type RunFn = (v: EditorView) => void | Promise<void>;
type Leaf = { label: string; icon: ReactNode; run: RunFn };
type MenuNode =
  | { divider: true }
  | Leaf
  | { label: string; icon: ReactNode; items: Leaf[] };

const MENU: MenuNode[] = [
  { label: "Add link", icon: <Link size={15} />, run: (v) => void wrapWikilink(v) },
  { label: "Add external link", icon: <ExternalLink size={15} />, run: insertExternalLink },
  { divider: true },
  { label: "Bold", icon: <Bold size={15} />, run: (v) => void toggleWrap("**")(v) },
  { label: "Italic", icon: <Italic size={15} />, run: (v) => void toggleWrap("*")(v) },
  { label: "Strikethrough", icon: <Strikethrough size={15} />, run: (v) => void toggleWrap("~~")(v) },
  { label: "Inline code", icon: <Code size={15} />, run: (v) => void toggleWrap("`")(v) },
  { divider: true },
  {
    label: "Paragraph",
    icon: <Pilcrow size={15} />,
    items: [
      { label: "Heading 1", icon: <Heading1 size={15} />, run: setHeading(1) },
      { label: "Heading 2", icon: <Heading2 size={15} />, run: setHeading(2) },
      { label: "Heading 3", icon: <Heading3 size={15} />, run: setHeading(3) },
      { label: "Quote", icon: <Quote size={15} />, run: toggleQuote },
      { label: "Bullet list", icon: <List size={15} />, run: bulletList },
      { label: "Numbered list", icon: <ListOrdered size={15} />, run: numberedList },
    ],
  },
  {
    label: "Insert",
    icon: <Plus size={15} />,
    items: [
      { label: "Code block", icon: <SquareCode size={15} />, run: insertCodeBlock },
      { label: "Table", icon: <Table size={15} />, run: insertTable },
      { label: "Diagram", icon: <Workflow size={15} />, run: insertDiagram },
      { label: "Horizontal rule", icon: <Minus size={15} />, run: insertHorizontalRule },
    ],
  },
  { divider: true },
  { label: "Cut", icon: <Scissors size={15} />, run: cutSelection },
  { label: "Copy", icon: <Copy size={15} />, run: copySelection },
  { label: "Paste", icon: <ClipboardPaste size={15} />, run: pasteText },
  { label: "Paste as plain text", icon: <Clipboard size={15} />, run: pasteText },
  { divider: true },
  { label: "Select all", icon: <TextSelect size={15} />, run: selectAll },
];

const ROW =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent";

function Row({ icon, label, trailing }: { icon: ReactNode; label: string; trailing?: ReactNode }) {
  return (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </>
  );
}

export function EditorContextMenu({
  view,
  x,
  y,
  onClose,
}: {
  view: EditorView;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [openSub, setOpenSub] = useState<string | null>(null);

  // Clamp into the viewport once we know the menu's size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const runLeaf = (leaf: Leaf) => async () => {
    await leaf.run(view);
    view.focus();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-52 rounded-md border bg-card p-1 text-sm shadow-md"
    >
      {MENU.map((node, i) => {
        if ("divider" in node) return <div key={i} className="my-1 h-px bg-border" />;

        if ("items" in node) {
          const open = openSub === node.label;
          return (
            <div
              key={node.label}
              className="relative"
              onMouseEnter={() => setOpenSub(node.label)}
            >
              <button
                type="button"
                className={ROW}
                onClick={() => setOpenSub(open ? null : node.label)}
              >
                <Row
                  icon={node.icon}
                  label={node.label}
                  trailing={<ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
                />
              </button>
              {open && (
                <div
                  role="menu"
                  className="absolute left-full top-0 z-50 min-w-48 rounded-md border bg-card p-1 shadow-md"
                >
                  {node.items.map((leaf) => (
                    <button key={leaf.label} type="button" className={ROW} onClick={runLeaf(leaf)}>
                      <Row icon={leaf.icon} label={leaf.label} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }

        return (
          <button
            key={node.label}
            type="button"
            className={ROW}
            onMouseEnter={() => setOpenSub(null)}
            onClick={runLeaf(node)}
          >
            <Row icon={node.icon} label={node.label} />
          </button>
        );
      })}
    </div>
  );
}
