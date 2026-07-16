// Time formatting for note provenance: a scannable relative form ("2 hours
// ago") for the collapsed hint, and an exact absolute form for tooltips and the
// metadata popover. Both follow the viewer's locale.

const REL = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ABS = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

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

export function absoluteTime(iso: string): string {
  return ABS.format(new Date(iso));
}
