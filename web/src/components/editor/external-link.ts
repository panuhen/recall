import { Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Bridge for the external-link dialog, mirroring link-picker.ts. The editor asks
// through this facet; MarkdownEditor installs a handler that opens
// <ExternalLinkDialog>. Nothing is written until the user confirms a URL.

// Carries any selected text (pre-fills the link label) and the doc range the
// resulting `[text](url)` replaces.
export type ExternalLinkRequest = { text: string; from: number; to: number };
type Handler = (req: ExternalLinkRequest) => void;

export const externalLinkHandler = Facet.define<Handler, Handler | null>({
  combine: (values) => values[0] ?? null,
});

export function requestExternalLink(view: EditorView): boolean {
  const handler = view.state.facet(externalLinkHandler);
  if (!handler) return false;
  const { from, to } = view.state.selection.main;
  handler({ text: view.state.sliceDoc(from, to), from, to });
  return true;
}
