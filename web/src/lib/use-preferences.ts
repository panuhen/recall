"use client";

import { useEffect, useState } from "react";

// User preferences for what a note shows when it opens. These are the *global
// defaults*; individual notes still remember per-note deviations (see the note
// page's recall.noteViewPrefs). Precedence at open time: per-note > these >
// built-in. Persisted in localStorage; read once per note-open (readPreferences)
// and edited reactively from the Settings dialog (usePreferences).
export const PREFS_KEY = "recall.prefs";

// Properties has a smart "auto" default (show only when the note has any),
// alongside explicit Always / Never. Backlinks and Metadata are plain on/off.
export type PropertiesDefault = "auto" | "always" | "never";

// How org-visible ("public") workspaces appear in your sidebar: only the ones
// you've pinned (default — the rest live in Browse), or all of them.
export type OrgWorkspacesMode = "pinned" | "all";

// Clock for absolute timestamps (Settings → Appearance). "auto" follows the
// browser locale (en-US → 12-hour, fi-FI → 24-hour); the others force it.
export type TimeFormat = "auto" | "12h" | "24h";

export type Preferences = {
  properties: PropertiesDefault;
  backlinks: boolean;
  // Whether the Related (semantic neighbors) section shows beneath Backlinks
  // (plain on/off, off by default like the other note sections).
  related: boolean;
  metadata: boolean;
  // Syntax-highlight rendered code blocks (Settings → Appearance). On by
  // default — a standard, expected enhancement for a markdown app.
  codeHighlight: boolean;
  timeFormat: TimeFormat;
  orgWorkspaces: OrgWorkspacesMode;
  showRecentOnHome: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  properties: "auto",
  backlinks: false,
  related: false,
  metadata: false,
  codeHighlight: true,
  timeFormat: "auto",
  orgWorkspaces: "pinned",
  showRecentOnHome: false,
};

// Defensive read: tolerate missing keys, bad JSON, and unknown values (private
// mode throws; a hand-edited value could be anything).
export function readPreferences(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    if (!p || typeof p !== "object") return { ...DEFAULT_PREFERENCES };
    return {
      properties:
        p.properties === "always" || p.properties === "never" ? p.properties : "auto",
      backlinks: p.backlinks === true,
      related: p.related === true,
      metadata: p.metadata === true,
      codeHighlight: p.codeHighlight !== false, // default on when key is missing
      timeFormat: p.timeFormat === "12h" || p.timeFormat === "24h" ? p.timeFormat : "auto",
      orgWorkspaces: p.orgWorkspaces === "all" ? "all" : "pinned",
      showRecentOnHome: p.showRecentOnHome === true,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function writePreferences(prefs: Preferences) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    // Same-tab broadcast so live readers (e.g. the sidebar's org-workspaces
    // mode) update immediately; the storage event only fires in *other* tabs.
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event("recall:prefs"));
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

// Reactive accessor for the Settings dialog. Note pages read the plain
// readPreferences() at open time instead, so a changed default applies to the
// next note opened rather than retroactively to already-open tabs.
export function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    setPrefs(readPreferences());
  }, []);

  function setPref<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    // Persist + broadcast here in the event handler — NOT inside the setPrefs
    // updater, which React runs during render (dispatching there fires a live
    // listener's setState mid-render → the "setState in render" warning).
    const next = { ...prefs, [key]: value };
    writePreferences(next);
    setPrefs(next);
  }

  return { prefs, setPref };
}
