import { syntaxTree } from "@codemirror/language";
import { EditorState, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { nextMermaidId, renderMermaid } from "./mermaid";

// Obsidian-style inline live preview: style markdown in place and hide the
// syntax markers — except on the element (or line, for block markers) the
// selection currently touches, where the raw markdown is revealed.

const STYLE: Record<string, string> = {
  StrongEmphasis: "cm-lp-strong",
  Emphasis: "cm-lp-em",
  Strikethrough: "cm-lp-strike",
  InlineCode: "cm-lp-code",
};

const MARK_CHILD: Record<string, string> = {
  StrongEmphasis: "EmphasisMark",
  Emphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
};

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function lineActive(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-bullet";
    s.textContent = "•";
    return s;
  }
}

class CheckWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckWidget) {
    return o.checked === this.checked;
  }
  toDOM() {
    // A disabled native checkbox — same element Reading view renders, so the two
    // modes look identical. It sits in a clickable wrapper; the input's
    // pointer-events are turned off (see theme) so the click lands on the wrapper
    // and reaches taskToggle, while the disabled input never self-toggles.
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.disabled = true;
    wrap.appendChild(box);
    return wrap;
  }
  // Let the click reach the editor's mousedown handler (see taskToggle).
  ignoreEvent() {
    return false;
  }
}

// Renders a GFM pipe table as an HTML <table>. Cell text is plain (no inline
// markdown) — a deliberately simple first pass; Reading mode uses react-markdown.
class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.src === this.src;
  }
  toDOM() {
    const rows = this.src.split("\n").filter((l) => l.trim() !== "");
    const cells = (line: string) => {
      let s = line.trim();
      if (s.startsWith("|")) s = s.slice(1);
      if (s.endsWith("|")) s = s.slice(0, -1);
      return s.split("|").map((c) => c.trim());
    };
    const table = document.createElement("table");
    table.className = "cm-lp-table";
    if (rows.length > 0) {
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      for (const c of cells(rows[0])) {
        const th = document.createElement("th");
        th.textContent = c;
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    const tbody = document.createElement("tbody");
    for (let i = 2; i < rows.length; i++) {
      // row 1 is the |---| delimiter — skip it
      const tr = document.createElement("tr");
      for (const c of cells(rows[i])) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }
  // Let clicks reach the editor so the cursor lands in the table and reveals
  // the raw pipe markdown for editing.
  ignoreEvent() {
    return false;
  }
}

// Renders a ```mermaid fenced block as a diagram (Live Preview). Mermaid is
// loaded lazily inside renderMermaid; on a parse error we show the raw source so
// the block stays visible and editable rather than blank.
class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-mermaid";
    renderMermaid(this.code, nextMermaidId())
      .then((svg) => {
        wrap.innerHTML = svg;
      })
      .catch(() => {
        wrap.classList.add("cm-lp-mermaid-error");
        wrap.textContent = this.code;
      });
    return wrap;
  }
  // Let clicks reach the editor so the cursor lands in the block and reveals the
  // raw ```mermaid source for editing (same as the table widget).
  ignoreEvent() {
    return false;
  }
}

// Renders `---` / `***` / `___` as a horizontal rule (replaces the raw dashes).
class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-hr";
    return s;
  }
}

// Small external-link glyph (lucide "external-link") appended after external
// markdown links in live preview, matching the reading-view affordance.
class ExternalLinkWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-extlink";
    s.setAttribute("aria-hidden", "true");
    s.innerHTML =
      '<svg viewBox="0 0 24 24" width="0.8em" height="0.8em" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg>';
    return s;
  }
}

// Toggle `[ ]`/`[x]` when a rendered checkbox widget is clicked, then persist
// via the normal onChange → autosave path.
export const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const t = event.target as HTMLElement | null;
    if (!t || !t.classList?.contains("cm-lp-check")) return false;
    const line = view.state.doc.lineAt(view.posAtDOM(t));
    const rel = line.text.search(/\[[ xX]\]/); // task marker at the item start
    if (rel === -1) return false;
    const at = line.from + rel + 1; // the state char between the brackets
    const checked = /[xX]/.test(view.state.doc.sliceString(at, at + 1));
    view.dispatch({ changes: { from: at, to: at + 1, insert: checked ? " " : "x" } });
    event.preventDefault();
    return true;
  },
});

// Follow a `[[wikilink]]` from the editor. Plain clicks must still place the
// cursor for editing, so navigation is gated to Cmd/Ctrl+click or middle-click
// (Obsidian's convention). The Reading view navigates on a plain click instead,
// since nothing there is editable.
export function wikilinkNav(navigate: (target: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const el = event.target as HTMLElement | null;
      if (!el?.closest(".cm-lp-wikilink")) return false;
      const follow = event.metaKey || event.ctrlKey || event.button === 1;
      if (!follow) return false;
      const pos = view.posAtDOM(el);
      const line = view.state.doc.lineAt(pos);
      const re = /\[\[([^\]\n]+)\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line.text)) !== null) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        if (pos >= s && pos <= e) {
          event.preventDefault();
          navigate(m[1].split("|")[0].trim());
          return true;
        }
      }
      return false;
    },
  });
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // Tables are rendered by a block widget (tableRender state field); skip
        // their internals here so decorations don't overlap the replacement.
        if (name === "Table") return false;

        const h = /^ATXHeading(\d)$/.exec(name);
        if (h) {
          const line = state.doc.lineAt(node.from);
          decos.push(Decoration.line({ class: "cm-lp-hline" }).range(line.from));
          decos.push(
            Decoration.mark({ class: `cm-lp-h${h[1]}` }).range(node.from, node.to),
          );
          if (!touches(state, node.from, node.to)) {
            const mark = node.node.getChild("HeaderMark");
            if (mark) {
              let end = mark.to;
              if (state.doc.sliceString(end, end + 1) === " ") end += 1;
              if (end > mark.from)
                decos.push(Decoration.replace({}).range(mark.from, end));
            }
          }
          return;
        }

        const cls = STYLE[name];
        if (cls) {
          decos.push(Decoration.mark({ class: cls }).range(node.from, node.to));
          if (!touches(state, node.from, node.to)) {
            for (const m of node.node.getChildren(MARK_CHILD[name])) {
              if (m.to > m.from)
                decos.push(Decoration.replace({}).range(m.from, m.to));
            }
          }
          return;
        }

        if (name === "Link") {
          decos.push(
            Decoration.mark({ class: "cm-lp-link" }).range(node.from, node.to),
          );
          if (!touches(state, node.from, node.to)) {
            for (const c of node.node.getChildren("LinkMark")) {
              if (c.to > c.from)
                decos.push(Decoration.replace({}).range(c.from, c.to));
            }
            const url = node.node.getChild("URL");
            if (url && url.to > url.from) {
              decos.push(Decoration.replace({}).range(url.from, url.to));
              // External links get a trailing out-arrow glyph in preview.
              if (/^https?:\/\//i.test(state.doc.sliceString(url.from, url.to))) {
                decos.push(
                  Decoration.widget({
                    widget: new ExternalLinkWidget(),
                    side: 1,
                  }).range(node.to),
                );
              }
            }
          } else {
            // Editing the link: raw `[text](url)` is shown. Dim the URL so it
            // reads as syntax instead of the saturated (and dark, in dark mode)
            // link colour inherited from the surrounding cm-lp-link span.
            const url = node.node.getChild("URL");
            if (url && url.to > url.from)
              decos.push(
                Decoration.mark({ class: "cm-lp-url" }).range(url.from, url.to),
              );
          }
          return;
        }

        if (name === "Blockquote") {
          decos.push(
            Decoration.mark({ class: "cm-lp-quote" }).range(node.from, node.to),
          );
          return;
        }

        if (name === "FencedCode") {
          // ```mermaid blocks are replaced by a rendered diagram (mermaidRender
          // state field); skip the generic code-block styling to avoid
          // overlapping decorations on the same range.
          const langNode = node.node.getChild("CodeInfo");
          const lang = langNode
            ? state.doc.sliceString(langNode.from, langNode.to).trim().toLowerCase()
            : "";
          // Highlight the ```lang fence syntax (markers + language label) in the
          // link accent while it's visible — i.e. being edited. When not editing
          // it's hidden below (code) or replaced by the rendered diagram
          // (mermaid), so a mark there would never show.
          if (touches(state, node.from, node.to)) {
            for (const m of node.node.getChildren("CodeMark")) {
              if (m.to > m.from)
                decos.push(Decoration.mark({ class: "cm-lp-fence" }).range(m.from, m.to));
            }
            if (langNode && langNode.to > langNode.from)
              decos.push(
                Decoration.mark({ class: "cm-lp-fence" }).range(langNode.from, langNode.to),
              );
          }
          if (lang === "mermaid") return;
          // Shade the code text lines (not the fence lines).
          const text = node.node.getChild("CodeText");
          if (text) {
            const first = state.doc.lineAt(text.from).number;
            const last = state.doc.lineAt(text.to).number;
            for (let l = first; l <= last; l++) {
              decos.push(
                Decoration.line({ class: "cm-lp-codeblock" }).range(state.doc.line(l).from),
              );
            }
          }
          // Hide the ``` fences + language when not editing the block.
          if (!touches(state, node.from, node.to)) {
            for (const m of node.node.getChildren("CodeMark")) {
              if (m.to > m.from) decos.push(Decoration.replace({}).range(m.from, m.to));
            }
            const info = node.node.getChild("CodeInfo");
            if (info && info.to > info.from)
              decos.push(Decoration.replace({}).range(info.from, info.to));
          }
          return;
        }

        if (name === "HorizontalRule") {
          if (!lineActive(state, node.from)) {
            decos.push(
              Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to),
            );
          }
          return;
        }

        if (name === "QuoteMark") {
          if (!lineActive(state, node.from)) {
            let end = node.to;
            if (state.doc.sliceString(end, end + 1) === " ") end += 1;
            decos.push(Decoration.replace({}).range(node.from, end));
          }
          return;
        }

        if (name === "ListMark") {
          const mt = state.doc.sliceString(node.from, node.to);
          if (/^[-*+]$/.test(mt) && !lineActive(state, node.from)) {
            decos.push(
              Decoration.replace({ widget: new BulletWidget() }).range(
                node.from,
                node.to,
              ),
            );
          }
          return;
        }

        if (name === "TaskMarker") {
          const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
          if (checked) {
            // Strike through the completed item's text (rest of the line).
            const line = state.doc.lineAt(node.from);
            if (node.to < line.to)
              decos.push(
                Decoration.mark({ class: "cm-lp-task-done" }).range(node.to, line.to),
              );
          }
          if (!lineActive(state, node.from)) {
            decos.push(
              Decoration.replace({ widget: new CheckWidget(checked) }).range(
                node.from,
                node.to,
              ),
            );
          }
          return;
        }
      },
    });

    const text = state.doc.sliceString(from, to);
    WIKILINK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK.exec(text)) !== null) {
      const s = from + m.index;
      const e = s + m[0].length;
      decos.push(Decoration.mark({ class: "cm-lp-wikilink" }).range(s, e));
      if (!touches(state, s, e)) {
        decos.push(Decoration.replace({}).range(s, s + 2));
        decos.push(Decoration.replace({}).range(e - 2, e));
      }
    }
  }

  return Decoration.set(decos, true);
}

// Live Preview reveals the raw markdown where the cursor is (the element the
// selection touches) and keeps everything else rendered.
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Hide the leading YAML frontmatter block entirely (Live Preview): metadata is
// surfaced through the Properties panel, not shown as raw `---` text. Source
// mode leaves it visible since this extension is only active there. A
// line-crossing replace must come from a state field, not a view plugin.
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

function frontmatterHide(state: EditorState): DecorationSet {
  const head = state.doc.sliceString(0, Math.min(state.doc.length, 8000));
  const m = FRONTMATTER.exec(head);
  if (!m || m[0].length === 0) return Decoration.none;
  return Decoration.set([Decoration.replace({}).range(0, m[0].length)]);
}

const frontmatterField = StateField.define<DecorationSet>({
  create: frontmatterHide,
  update: (value, tr) => (tr.docChanged ? frontmatterHide(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

export const hideFrontmatter = [
  frontmatterField,
  // Treat the hidden block as atomic so the cursor skips over it.
  EditorView.atomicRanges.of((view) => view.state.field(frontmatterField)),
];

// ── Tables (Live Preview) ───────────────────────────────────
// Render GFM tables as a block widget; reveal the raw pipe markdown when the
// selection is inside so it stays editable. Block/cross-line decorations must
// come from a state field, not a view plugin.
function buildTables(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
      if (!touches(state, from, to)) {
        decos.push(
          Decoration.replace({
            widget: new TableWidget(state.doc.sliceString(from, to)),
            block: true,
          }).range(from, to),
        );
      }
      return false;
    },
  });
  return Decoration.set(decos, true);
}

export const tableRender = StateField.define<DecorationSet>({
  create: buildTables,
  update: (value, tr) =>
    tr.docChanged || tr.selection ? buildTables(tr.state) : value,
  provide: (f) => EditorView.decorations.from(f),
});

// ── Mermaid diagrams (Live Preview) ─────────────────────────
// Replace a ```mermaid fenced block with a rendered diagram (block widget);
// reveal the raw source when the selection is inside so it stays editable.
// Block/cross-line decorations must come from a state field, not a view plugin.
function buildMermaid(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      const lang = info
        ? state.doc.sliceString(info.from, info.to).trim().toLowerCase()
        : "";
      if (lang !== "mermaid") return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
      if (!touches(state, from, to)) {
        const text = node.node.getChild("CodeText");
        const code = text ? state.doc.sliceString(text.from, text.to) : "";
        decos.push(
          Decoration.replace({
            widget: new MermaidWidget(code),
            block: true,
          }).range(from, to),
        );
      }
      return false;
    },
  });
  return Decoration.set(decos, true);
}

export const mermaidRender = StateField.define<DecorationSet>({
  create: buildMermaid,
  update: (value, tr) =>
    tr.docChanged || tr.selection ? buildMermaid(tr.state) : value,
  provide: (f) => EditorView.decorations.from(f),
});
