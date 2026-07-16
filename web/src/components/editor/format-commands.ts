import { EditorSelection, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { requestLinkPicker } from "./link-picker";

// Inline-formatting commands, keyed like Obsidian / most editors. They wrap the
// selection (or the empty cursor) in a marker and are toggle-aware: pressing the
// same key again on already-wrapped text unwraps it. They work in both Source
// and Live Preview modes, since both are the same editable CodeMirror instance.

export function toggleWrap(marker: string) {
  const len = marker.length;
  return (view: EditorView): boolean => {
    const { doc } = view.state;
    view.dispatch(
      view.state.changeByRange((range) => {
        const { from, to } = range;

        // Empty cursor: drop in the markers and sit between them.
        if (from === to) {
          return {
            changes: { from, insert: marker + marker },
            range: EditorSelection.cursor(from + len),
          };
        }

        // Markers immediately outside the selection → unwrap them.
        if (
          doc.sliceString(Math.max(0, from - len), from) === marker &&
          doc.sliceString(to, to + len) === marker
        ) {
          return {
            changes: [
              { from: from - len, to: from, insert: "" },
              { from: to, to: to + len, insert: "" },
            ],
            range: EditorSelection.range(from - len, to - len),
          };
        }

        // Selection already includes the markers → strip them.
        const selected = doc.sliceString(from, to);
        if (
          selected.length >= 2 * len &&
          selected.startsWith(marker) &&
          selected.endsWith(marker)
        ) {
          const inner = selected.slice(len, selected.length - len);
          return {
            changes: { from, to, insert: inner },
            range: EditorSelection.range(from, from + inner.length),
          };
        }

        // Otherwise wrap the selection.
        return {
          changes: [
            { from, insert: marker },
            { from: to, insert: marker },
          ],
          range: EditorSelection.range(from + len, to + len),
        };
      }),
    );
    return true;
  };
}

// Open the note picker to insert a `[[wikilink]]` (recall's primary linking
// mechanism). Any selected text becomes the picker's initial query — so
// "highlight a phrase → link it" flows straight into a search. Nothing is
// written to the doc until a note is picked, so cancelling leaves no brackets.
export function wrapWikilink(view: EditorView): boolean {
  return requestLinkPicker(view);
}

export const formatKeymap = Prec.high(
  keymap.of([
    { key: "Mod-b", run: toggleWrap("**") },
    { key: "Mod-i", run: toggleWrap("*") },
    { key: "Mod-Shift-x", run: toggleWrap("~~") },
    { key: "Mod-`", run: toggleWrap("`") },
    { key: "Mod-k", run: wrapWikilink },
  ]),
);
