"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

// The dock shows either one workspace's graph or the whole-account root graph.
export type GraphTarget = { kind: "project"; projectId: string } | { kind: "root" };

type GraphDockCtx = {
  open: boolean;
  target: GraphTarget | null;
  width: number;
  openDock: (projectId: string) => void;
  openRootDock: () => void;
  close: () => void;
  setWidth: (w: number) => void;
};

const Ctx = createContext<GraphDockCtx | null>(null);

const WIDTH_KEY = "recall.graphDockWidth";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 760;

const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));

// Owns the docked graph panel: whether it's open, its target (a workspace or the
// root graph), and its persisted width. Opening it shows the graph beside the
// current note; the panel can pop out to the matching full-screen route.
export function GraphDockProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<GraphTarget | null>(null);
  const [width, setWidthState] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) setWidthState(clampWidth(saved));
  }, []);

  const openDock = useCallback((projectId: string) => {
    setTarget({ kind: "project", projectId });
    setOpen(true);
  }, []);

  const openRootDock = useCallback(() => {
    setTarget({ kind: "root" });
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const setWidth = useCallback((w: number) => {
    const c = clampWidth(w);
    setWidthState(c);
    try {
      localStorage.setItem(WIDTH_KEY, String(c));
    } catch {
      // ignore storage errors
    }
  }, []);

  const value = useMemo(
    () => ({ open, target, width, openDock, openRootDock, close, setWidth }),
    [open, target, width, openDock, openRootDock, close, setWidth],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGraphDock() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGraphDock must be used within GraphDockProvider");
  return ctx;
}
