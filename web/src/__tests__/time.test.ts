import { afterEach, describe, expect, it, vi } from "vitest";

import { absoluteTime } from "@/lib/time";
import { PREFS_KEY } from "@/lib/use-preferences";

// 15:04 local time, so the clock setting is visible whatever the machine's TZ.
const AFTERNOON = new Date(2026, 8, 25, 15, 4).toISOString();

function reference(hourCycle?: "h12" | "h23"): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle,
  }).format(new Date(AFTERNOON));
}

function stubPrefs(value: unknown) {
  const store: Record<string, string> = { [PREFS_KEY]: JSON.stringify(value) };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("absoluteTime", () => {
  it("auto follows the locale default", () => {
    expect(absoluteTime(AFTERNOON, "auto")).toBe(reference());
  });

  it("12h and 24h force the clock", () => {
    expect(absoluteTime(AFTERNOON, "12h")).toBe(reference("h12"));
    expect(absoluteTime(AFTERNOON, "24h")).toBe(reference("h23"));
    expect(absoluteTime(AFTERNOON, "24h")).toMatch(/15/);
    expect(absoluteTime(AFTERNOON, "12h")).not.toBe(absoluteTime(AFTERNOON, "24h"));
  });

  it("reads the saved preference when no format is passed", () => {
    stubPrefs({ timeFormat: "24h" });
    expect(absoluteTime(AFTERNOON)).toBe(reference("h23"));
    stubPrefs({ timeFormat: "12h" });
    expect(absoluteTime(AFTERNOON)).toBe(reference("h12"));
  });

  it("falls back to auto for a missing or unknown value", () => {
    stubPrefs({ timeFormat: "36h" });
    expect(absoluteTime(AFTERNOON)).toBe(reference());
  });

  it("falls back to auto when storage throws (private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(absoluteTime(AFTERNOON)).toBe(reference());
  });
});
