// Time formatting for note provenance: a scannable relative form ("2 hours
// ago") for the collapsed hint, and an exact absolute form for tooltips and the
// metadata popover. Both follow the viewer's locale; the absolute form's clock
// (12- vs 24-hour) can be forced in Settings → Appearance.

import { readPreferences, type TimeFormat } from "@/lib/use-preferences";

const REL = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const HOUR_CYCLE: Record<TimeFormat, Intl.DateTimeFormatOptions["hourCycle"]> = {
  auto: undefined,
  "12h": "h12",
  "24h": "h23",
};

// One formatter per clock setting, built on first use.
const ABS = new Map<TimeFormat, Intl.DateTimeFormat>();

function absFormatter(format: TimeFormat): Intl.DateTimeFormat {
  let f = ABS.get(format);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      hourCycle: HOUR_CYCLE[format],
    });
    ABS.set(format, f);
  }
  return f;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

export function relativeTime(iso: string): string {
  const secs = (new Date(iso).getTime() - Date.now()) / 1000; // <0 = past
  if (Math.abs(secs) < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size) return REL.format(Math.round(secs / size), unit);
  }
  return "just now";
}

// Reads the clock preference per call, so a change in Settings applies to the
// next render without reloading. `format` overrides it (tests, previews).
export function absoluteTime(iso: string, format?: TimeFormat): string {
  return absFormatter(format ?? readPreferences().timeFormat).format(new Date(iso));
}
