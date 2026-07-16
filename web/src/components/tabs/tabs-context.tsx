"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Tab = { id: string; title: string };

type TabsCtx = {
  tabs: Tab[];
  openTab: (id: string, title: string) => void;
  closeTab: (id: string) => void;
  closeAllTabs: () => void;
  setTabTitle: (id: string, title: string) => void;
};

const Ctx = createContext<TabsCtx | null>(null);

const STORAGE_KEY = "recall.openTabs";

// Tracks the set of open notes as editor tabs, persisted across sessions. The
// active tab is derived from the route (the [noteId] param), so it isn't stored
// here — this only owns which notes are open and their display titles.
export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(parsed)) {
        setTabs(
          parsed
            .filter((t) => t && typeof t.id === "string")
            .map((t) => ({
              id: t.id as string,
              title: typeof t.title === "string" ? t.title : "",
            })),
        );
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // ignore quota / serialization errors
    }
  }, [tabs]);

  const openTab = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev.map((t) => (t.id === id && title ? { ...t, title } : t))
        : [...prev, { id, title }],
    );
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const closeAllTabs = useCallback(() => setTabs([]), []);

  const setTabTitle = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && t.title !== title ? { ...t, title } : t)),
    );
  }, []);

  const value = useMemo(
    () => ({ tabs, openTab, closeTab, closeAllTabs, setTabTitle }),
    [tabs, openTab, closeTab, closeAllTabs, setTabTitle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabs() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTabs must be used within TabsProvider");
  return ctx;
}
