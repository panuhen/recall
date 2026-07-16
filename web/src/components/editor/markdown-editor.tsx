"use client";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EditorContextMenu } from "./editor-context-menu";
import { EditorToolbar } from "./editor-toolbar";
import { lpTheme } from "./editor-theme";
import {
  externalLinkHandler,
  type ExternalLinkRequest,
} from "./external-link";
import { ExternalLinkDialog } from "./external-link-dialog";
import { formatKeymap } from "./format-commands";
import { LinkPickerDialog } from "./link-picker-dialog";
import {
  linkPickerHandler,
  wikilinkTypeTrigger,
  type LinkPickerRequest,
  type LinkTarget,
} from "./link-picker";
import {
  hideFrontmatter,
  livePreview,
  mermaidRender,
  tableRender,
  taskToggle,
  wikilinkNav,
} from "./live-preview";

export type EditorMode = "live" | "read" | "source";

// "read" is handled by <ReadingView> (react-markdown) at the page level, so it
// never reaches this editor — only "live" and "source" mount here.
function forMode(mode: EditorMode) {
  if (mode === "live")
    return [livePreview, taskToggle, hideFrontmatter, tableRender, mermaidRender];
  return []; // source: raw markdown, no decorations
}

export function MarkdownEditor({
  value,
  onChange,
  mode = "live",
  onFollowLink,
  linkTargets,
}: {
  value: string;
  onChange: (v: string) => void;
  mode?: EditorMode;
  // Follow a `[[wikilink]]` (Cmd/Ctrl or middle click). Given the target text;
  // the caller resolves it to a note and navigates.
  onFollowLink?: (target: string) => void;
  // This workspace's notes, for the `[[` picker.
  linkTargets?: LinkTarget[];
}) {
  const ref = useRef<ReactCodeMirrorRef>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The live EditorView, captured on create so the mobile toolbar can run
  // commands against it (the ref isn't populated on the first render).
  const [view, setView] = useState<EditorView | null>(null);
  // The active link-picker request (which doc range a picked `[[Title]]` fills,
  // and whether to clean up on cancel), or null when the picker is closed.
  const [picker, setPicker] = useState<LinkPickerRequest | null>(null);
  // The active external-link request (fills `[text](url)` on confirm).
  const [externalLink, setExternalLink] = useState<ExternalLinkRequest | null>(null);
  // A compartment lets us switch live-preview on/off without recreating the
  // editor, so the cursor and scroll position survive the toggle.
  const preview = useMemo(() => new Compartment(), []);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // The editor is built once; keep a live ref so the (stable) nav handler always
  // calls the latest callback.
  const followRef = useRef<((target: string) => void) | undefined>(onFollowLink);
  followRef.current = onFollowLink;

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      formatKeymap,
      wikilinkNav((target) => followRef.current?.(target)),
      // `[[` typing opens the picker; commands/menu request it via the facet.
      wikilinkTypeTrigger,
      linkPickerHandler.of((req) => setPicker(req)),
      externalLinkHandler.of((req) => setExternalLink(req)),
      preview.of(forMode(modeRef.current)),
      lpTheme,
    ],
    // Built once; the correct mode is applied on create + on change below.
    [preview],
  );

  useEffect(() => {
    const view = ref.current?.view;
    if (view) view.dispatch({ effects: preview.reconfigure(forMode(mode)) });
  }, [mode, preview]);

  // Picked a note: replace the request's range with `[[Title]]`.
  const insertLink = useCallback(
    (title: string) => {
      const view = ref.current?.view;
      if (view && picker) {
        const text = `[[${title}]]`;
        view.dispatch({
          changes: { from: picker.from, to: picker.to, insert: text },
          selection: { anchor: picker.from + text.length },
        });
      }
      setPicker(null);
      view?.focus();
    },
    [picker],
  );

  // Dismissed: write nothing. Remove the auto-inserted `[[` (never a selection).
  const cancelLink = useCallback(() => {
    const view = ref.current?.view;
    if (view && picker?.removeOnCancel) {
      view.dispatch({ changes: { from: picker.from, to: picker.to, insert: "" } });
    }
    setPicker(null);
    view?.focus();
  }, [picker]);

  // Confirmed an external link: replace the range with `[text](url)`.
  const insertExternalLink = useCallback(
    (link: { text: string; url: string }) => {
      const view = ref.current?.view;
      if (view && externalLink) {
        const text = `[${link.text}](${link.url})`;
        view.dispatch({
          changes: { from: externalLink.from, to: externalLink.to, insert: text },
          selection: { anchor: externalLink.from + text.length },
        });
      }
      setExternalLink(null);
      view?.focus();
    },
    [externalLink],
  );

  const cancelExternalLink = useCallback(() => {
    setExternalLink(null);
    ref.current?.view?.focus();
  }, []);

  return (
    <div
      className="relative"
      onContextMenu={(e) => {
        // Reading view stays read-only; let the native menu handle it.
        if (mode === "read" || !ref.current?.view) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <CodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        // "none" so react-codemirror injects no palette (its default "light"
        // hardcodes a white background). Our lpTheme + the theme-aware page
        // background then drive the look in both light and dark.
        theme="none"
        // The editor mounts lazily; sync to the latest mode once it exists and
        // hand the view to the mobile toolbar.
        onCreateEditor={(view) => {
          setView(view);
          view.dispatch({ effects: preview.reconfigure(forMode(modeRef.current)) });
        }}
        minHeight="320px"
        placeholder="Write in markdown…"
        extensions={extensions}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          indentOnInput: false,
          searchKeymap: false,
          // Note linking uses our own <LinkPickerDialog>, not CodeMirror
          // completion — keep the default autocompletion off.
          autocompletion: false,
          // Drop CodeMirror's default (light-theme) highlight style. All editor
          // styling comes from lpTheme's cm-lp-* decorations; the default only
          // added off-brand token colours (e.g. a dark-blue ```mermaid fence
          // label) that are unreadable in dark mode. Monochrome by design.
          syntaxHighlighting: false,
        }}
      />
      {menu && ref.current?.view && (
        <EditorContextMenu
          view={ref.current.view}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
      {view && <EditorToolbar view={view} />}
      <LinkPickerDialog
        open={picker !== null}
        initialQuery={picker?.query ?? ""}
        targets={linkTargets ?? []}
        onPick={insertLink}
        onClose={cancelLink}
      />
      <ExternalLinkDialog
        open={externalLink !== null}
        initialText={externalLink?.text ?? ""}
        onSubmit={insertExternalLink}
        onClose={cancelExternalLink}
      />
    </div>
  );
}
