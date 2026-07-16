"use client";

import { useEffect, useState } from "react";

// Hand-rolled theming (the app hand-rolls its UI — no next-themes). A
// `data-theme="…"` attribute on <html> selects the CSS-variable set in
// globals.css; `[data-theme="dark"]` overrides the `:root` (light) defaults.
// The attribute holds the *resolved* concrete theme ("light" | "dark"); the
// user's *preference* ("system" | "light" | "dark") is what we persist. Using
// an attribute (not a binary class) leaves room for named themes later —
// add a `[data-theme="sepia"]` block + an entry in THEMES.
export const THEME_KEY = "recall.theme";

// The user's stored choice. "system" follows the OS; the rest pin a theme.
export type ThemePreference = "system" | "light" | "dark";
// The concrete theme actually applied to the document.
export type ResolvedTheme = "light" | "dark";

// Selectable preferences, in display order. Extend alongside a matching
// [data-theme="…"] block in globals.css to add a named theme.
export const THEMES: ThemePreference[] = ["system", "light", "dark"];

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === "light" || pref === "dark" ? pref : systemTheme();
}

// Inlined into the document as a blocking script (root layout) so the theme is
// correct on first paint. Dependency-free and defensive (private-mode
// localStorage throws). Mirrors resolve() above.
export const THEME_INIT_SCRIPT = `(function(){var p='system';try{var s=localStorage.getItem('${THEME_KEY}');if(s)p=s;}catch(e){}var t=p;if(p!=='light'&&p!=='dark'){try{t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch(e){t='light';}}document.documentElement.setAttribute('data-theme',t);})();`;

// A theme *selector*: exposes the stored preference, the resolved theme, the
// list of choices, and a setter. Mirrors whatever the pre-paint script applied.
export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  // Sync state to the persisted preference + whatever the init script applied.
  useEffect(() => {
    let pref: ThemePreference = "system";
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") {
        pref = stored;
      }
    } catch {
      // ignore storage errors (private mode / quota)
    }
    setThemeState(pref);
    setResolvedTheme(
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "dark"
        : "light",
    );
  }, []);

  // While following the OS, react to system changes live. No initial apply —
  // the pre-paint script already set the correct attribute, so this only
  // handles later flips (avoids a first-frame override before the sync above).
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const t: ResolvedTheme = mq.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", t);
      setResolvedTheme(t);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function setTheme(pref: ThemePreference) {
    setThemeState(pref);
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch {
      // ignore storage errors (private mode / quota)
    }
    const t = resolve(pref);
    document.documentElement.setAttribute("data-theme", t);
    setResolvedTheme(t);
  }

  return { theme, resolvedTheme, setTheme, themes: THEMES };
}
