// One shared "something may have changed — refetch" signal for the whole app.
//
// Recall has no server push: the sidebar loads once, notes load once. So a
// workspace shared with you, or another person's edit, never reaches you until
// a manual reload. This module supplies the trigger that fixes that, cheaply
// and robustly: it fires when the tab regains focus, when it becomes visible,
// and on a gentle interval while visible (paused when hidden, so a backgrounded
// tab costs nothing).
//
// Consumers subscribe with a refetch callback and guard their own in-flight
// state. Crucially, the *reaction* (refetch this resource) is independent of
// the *trigger*: if we later add a live push channel (e.g. SSE backed by
// Postgres NOTIFY), it emits into this same seam and nothing downstream
// changes — it just makes the signal arrive sooner.

import { useEffect, useRef } from "react";

// How often to revalidate while the tab is visible. Long enough that idle tabs
// stay quiet, short enough that a colleague's change shows up on its own.
const INTERVAL_MS = 25_000;
// Collapse bursts: focus and visibilitychange often fire back-to-back, and we
// don't want two refetch storms a few ms apart.
const THROTTLE_MS = 1_000;

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastEmit = 0;
let wired = false;

function emit() {
  const now = Date.now();
  if (now - lastEmit < THROTTLE_MS) return;
  lastEmit = now;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A misbehaving subscriber must not stop the others from revalidating.
    }
  }
}

function startTimer() {
  if (timer == null) timer = setInterval(emit, INTERVAL_MS);
}

function stopTimer() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

function onVisibility() {
  if (document.visibilityState === "visible") {
    startTimer();
    emit(); // catch up immediately on return, don't wait out the interval
  } else {
    stopTimer();
  }
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("focus", emit);
  document.addEventListener("visibilitychange", onVisibility);
  if (document.visibilityState === "visible") startTimer();
}

/**
 * Register a refetch callback. Runs on tab focus, on becoming visible, and on a
 * ~25s interval while visible. Returns an unsubscribe function. The callback
 * should be cheap and guard against overlapping in-flight requests itself.
 */
export function subscribeRevalidate(fn: Listener): () => void {
  wire();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Fire the revalidate signal now — for after a local mutation whose effect
 * spans components (e.g. restoring from Trash should refresh the sidebar and
 * any open note immediately, not on the next focus/interval). Subject to the
 * same short throttle as the automatic triggers.
 */
export function triggerRevalidate(): void {
  emit();
}

/**
 * Hook form: subscribe for the lifetime of a component. The latest `fn` is
 * always used (kept in a ref), so callers can close over changing state
 * without re-subscribing on every render.
 */
export function useRevalidate(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribeRevalidate(() => ref.current()), []);
}
