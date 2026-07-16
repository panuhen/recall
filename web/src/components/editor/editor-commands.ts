import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { requestExternalLink } from "./external-link";

// Editing actions used by the right-click context menu. Inline formatting lives
// in format-commands (shared with the keymap); this covers links, block
// inserts, and clipboard/selection.

// Open the external-link dialog (any selection pre-fills the label). It inserts
// `[text](url)` on confirm; nothing is written if cancelled.
export function insertExternalLink(view: EditorView) {
  requestExternalLink(view);
}

// Fenced code block around the selection; caret on the language slot.
export function insertCodeBlock(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: "```\n" + text + "\n```" },
        range: EditorSelection.cursor(range.from + 3),
      };
    }),
  );
}

// Prefix every line the selection touches. Used for quote/list transforms.
function prefixLines(view: EditorView, prefix: (n: number) => string) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const changes = [];
  for (let n = first, i = 0; n <= last; n++, i++) {
    changes.push({ from: state.doc.line(n).from, insert: prefix(i) });
  }
  view.dispatch({ changes });
}

export function toggleQuote(view: EditorView) {
  prefixLines(view, () => "> ");
}

export function bulletList(view: EditorView) {
  prefixLines(view, () => "- ");
}

export function numberedList(view: EditorView) {
  prefixLines(view, (i) => `${i + 1}. `);
}

// Set the heading level on each selected line, replacing any existing marker.
export function setHeading(level: number) {
  return (view: EditorView) => {
    const { state } = view;
    const { from, to } = state.selection.main;
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    const marker = "#".repeat(level) + " ";
    const changes = [];
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      const existing = /^#{1,6}\s+/.exec(line.text);
      changes.push({
        from: line.from,
        to: line.from + (existing ? existing[0].length : 0),
        insert: marker,
      });
    }
    view.dispatch({ changes });
  };
}

export function insertTable(view: EditorView) {
  const pos = view.state.selection.main.to;
  const tpl = "\n| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |\n";
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: EditorSelection.cursor(pos + tpl.length),
  });
}

// A ```mermaid block seeded with a small flowchart, so the diagram renders
// immediately and the sample shows the syntax to edit from.
export function insertDiagram(view: EditorView) {
  const pos = view.state.selection.main.to;
  const tpl =
    "\n```mermaid\nflowchart TD\n  A[Start] --> B{Decision}\n" +
    "  B -->|Yes| C[Do this]\n  B -->|No| D[Do that]\n```\n";
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: EditorSelection.cursor(pos + tpl.length),
  });
}

export function insertHorizontalRule(view: EditorView) {
  const pos = view.state.selection.main.to;
  const insert = "\n\n---\n";
  view.dispatch({
    changes: { from: pos, insert },
    selection: EditorSelection.cursor(pos + insert.length),
  });
}

export function selectAll(view: EditorView) {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
}

export async function copySelection(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  if (text) await navigator.clipboard.writeText(text);
}

export async function cutSelection(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  if (!text) return;
  await navigator.clipboard.writeText(text);
  view.dispatch({
    changes: { from, to, insert: "" },
    selection: EditorSelection.cursor(from),
  });
}

// Our editor is plain-text, so paste and "paste as plain text" are the same.
export async function pasteText(view: EditorView) {
  const text = await navigator.clipboard.readText();
  if (text) view.dispatch(view.state.replaceSelection(text));
}
