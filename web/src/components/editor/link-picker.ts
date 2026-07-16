import { Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Bridge between the CodeMirror editor and the React link-picker dialog. The
// editor (commands, `[[` typing) can't render a modal itself, so it asks through
// this facet; MarkdownEditor installs a handler that opens <LinkPickerDialog>.

export type LinkTarget = { id: string; title: string };

// A picker request carries the initial query (any selected text), the doc range
// the chosen `[[Title]]` replaces, and whether that range should be removed if
// the picker is dismissed (true only for the auto-inserted `[[`, so cancelling
// leaves no stray brackets — never for a user's own selected text).
export type LinkPickerRequest = {
  query: string;
  from: number;
  to: number;
  removeOnCancel: boolean;
};
type Handler = (req: LinkPickerRequest) => void;

export const linkPickerHandler = Facet.define<Handler, Handler | null>({
  combine: (values) => values[0] ?? null,
});

// Open the picker for the current selection (empty selection → insert at
// cursor). Nothing is written to the doc until a note is picked.
export function requestLinkPicker(view: EditorView): boolean {
  const handler = view.state.facet(linkPickerHandler);
  if (!handler) return false;
  const { from, to } = view.state.selection.main;
  handler({
    query: view.state.sliceDoc(from, to),
    from,
    to,
    removeOnCancel: false,
  });
  return true;
}

// Open the picker when the user types `[[` (the familiar wikilink trigger). On
// pick the `[[` becomes `[[Title]]`; on cancel it's cleaned up. Deferred so we
// never setState mid-CodeMirror-update.
export const wikilinkTypeTrigger = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (!update.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
  const handler = update.state.facet(linkPickerHandler);
  if (!handler) return;
  const pos = update.state.selection.main.head;
  if (pos < 2 || update.state.sliceDoc(pos - 2, pos) !== "[[") return;
  queueMicrotask(() =>
    handler({ query: "", from: pos - 2, to: pos, removeOnCancel: true }),
  );
});
