import { EditorView } from "@codemirror/view";

// Document-style typography, tuned to read like a rendered note (Obsidian's
// reading view): sans-serif, comfortable measure, clear heading hierarchy with
// breathing room above headings. Colors use the app's theme vars so it works in
// both light and dark.
export const lpTheme = EditorView.theme({
  "&": { fontSize: "16px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "var(--font-sans)",
    lineHeight: "1.6",
    padding: "0",
    color: "var(--foreground)",
    caretColor: "var(--foreground)",
  },
  ".cm-line": { padding: "0" },
  ".cm-scroller": { lineHeight: "1.6" },

  // drawSelection (from basicSetup) draws its own caret and hides the native
  // one, so style it explicitly — otherwise it falls back to an unreliable
  // default color and reads as "no cursor". CodeMirror's blink animation
  // applies to this element when the editor is focused.
  ".cm-cursor, .cm-cursor-primary": {
    borderLeftColor: "var(--foreground)",
    borderLeftWidth: "2px",
  },

  ".cm-lp-h1": { fontSize: "1.9em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h2": { fontSize: "1.55em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h3": { fontSize: "1.28em", fontWeight: "600", lineHeight: "1.35" },
  ".cm-lp-h4, .cm-lp-h5, .cm-lp-h6": { fontWeight: "600" },

  // Space above heading lines, so sections separate like a rendered document.
  ".cm-lp-hline": { paddingTop: "0.8em" },

  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", opacity: "0.7" },
  ".cm-lp-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    background: "var(--code-bg)",
    padding: "0.05em 0.35em",
    borderRadius: "4px",
  },

  ".cm-lp-link": { color: "var(--link)", textDecoration: "underline" },
  ".cm-lp-wikilink": { color: "var(--link)", textDecoration: "underline" },
  ".cm-lp-extlink": { color: "var(--link)", paddingLeft: "0.15em", whiteSpace: "nowrap" },
  // The raw URL inside a link's (…) while editing — dimmed syntax rather than
  // the saturated link colour, so it stays legible (esp. on the dark ground).
  ".cm-lp-url": { color: "var(--muted-foreground)", textDecoration: "none" },
  // Preflight defaults svg to display:block, which would break the text line;
  // keep this inline glyph in the flow.
  ".cm-lp-extlink svg": { display: "inline-block", verticalAlign: "-0.12em" },

  ".cm-lp-codeblock": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    background: "var(--code-block-bg)",
  },
  // The ```lang fence syntax (markers + language label) shown while editing a
  // code block — highlighted in the link accent, theme-aware and readable in
  // dark (unlike CodeMirror's default dark-blue token colour, now disabled).
  ".cm-lp-fence": { color: "var(--link)" },
  ".cm-lp-hr": {
    display: "inline-block",
    width: "100%",
    borderTop: "2px solid var(--border)",
    verticalAlign: "middle",
  },

  ".cm-lp-table": { borderCollapse: "collapse", margin: "0.5em 0", fontSize: "0.95em" },
  ".cm-lp-table th, .cm-lp-table td": {
    border: "1px solid var(--border)",
    padding: "0.3em 0.6em",
    textAlign: "left",
  },
  ".cm-lp-table th": { fontWeight: "600", background: "var(--code-block-bg)" },

  ".cm-lp-quote": { color: "var(--quote)", fontStyle: "italic" },
  ".cm-lp-bullet": { color: "var(--quote)", paddingRight: "0.15em" },
  ".cm-lp-check": { marginRight: "0.4em", cursor: "pointer", userSelect: "none" },
  // The inner checkbox is a disabled native <input>; disable pointer-events so
  // the click lands on the wrapper (which taskToggle listens for).
  ".cm-lp-check input": {
    margin: "0",
    verticalAlign: "-0.1em",
    pointerEvents: "none",
  },
  ".cm-lp-check:hover": { opacity: "0.7" },
  ".cm-lp-task-done": { textDecoration: "line-through", opacity: "0.6" },

  // Rendered ```mermaid diagram (block widget). Centered; a pointer cue that
  // clicking reveals the source for editing. On a parse error the widget shows
  // the raw source instead (cm-lp-mermaid-error).
  ".cm-lp-mermaid": {
    display: "flex",
    justifyContent: "center",
    margin: "0.5em 0",
    padding: "0.2em 0",
    cursor: "pointer",
  },
  ".cm-lp-mermaid svg": { maxWidth: "100%", height: "auto" },
  ".cm-lp-mermaid-error": {
    display: "block",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    whiteSpace: "pre-wrap",
    background: "var(--code-block-bg)",
    padding: "0.6em 0.9em",
    borderRadius: "8px",
    color: "var(--muted-foreground)",
    cursor: "text",
  },
});

