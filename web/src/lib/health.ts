// Wording for the workspace Health section and a note's review line. Pure, so
// the phrasing is tested once and shared by the landing page and note page.

import type { HealthListKey, Member, NoteReview } from "@/lib/api";
import { relativeTime } from "@/lib/time";

// Display order: what needs a decision first, housekeeping last.
export const HEALTH_ORDER: HealthListKey[] = [
  "overdue",
  "owner_left",
  "broken_links",
  "old_drafts",
  "not_edited",
  "orphans",
];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Short label for a count in the collapsed summary line.
export function countLabel(key: HealthListKey, n: number): string {
  switch (key) {
    case "overdue":
      return `${n} overdue`;
    case "owner_left":
      return plural(n, "owner left", "owners left");
    case "broken_links":
      return plural(n, "broken link", "broken links");
    case "old_drafts":
      return plural(n, "old draft", "old drafts");
    case "not_edited":
      return `${n} not edited`;
    case "orphans":
      return plural(n, "orphan", "orphans");
  }
}

// Heading for each expanded list.
export function listTitle(key: HealthListKey, staleMonths: number): string {
  switch (key) {
    case "overdue":
      return "Overdue for review";
    case "owner_left":
      return "Owner has left";
    case "broken_links":
      return "Broken links";
    case "old_drafts":
      return `Drafts untouched for ${staleMonths} months`;
    case "not_edited":
      return `Not edited in ${staleMonths} months`;
    case "orphans":
      return "Orphans (no links in or out)";
  }
}

// The non-zero counts, in display order.
export function healthSummary(
  counts: Partial<Record<HealthListKey, number>>,
): { key: HealthListKey; count: number; label: string }[] {
  return HEALTH_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => ({
    key: k,
    count: counts[k]!,
    label: countLabel(k, counts[k]!),
  }));
}

// "Reviewed 8 months ago" / "Never reviewed", for a note's review line and
// the overdue list. `now` is injectable for tests.
export function reviewedText(reviewed: string | null, now?: number): string {
  if (!reviewed) return "Never reviewed";
  // `reviewed` is a date, so anything within a day reads as today rather than
  // "20 hours ago".
  const at = now ?? Date.now();
  if (Math.abs(at - new Date(reviewed).getTime()) < 86_400_000) return "Reviewed today";
  return `Reviewed ${relativeTime(reviewed, at)}`;
}

export function reviewLine(review: NoteReview, now?: number): string {
  return `${reviewedText(review.reviewed, now)} · review every ${review.every_text}`;
}

// A calendar date ("2027-03-26") in the viewer's locale, without shifting it
// across time zones the way `new Date("2027-03-26")` (UTC midnight) would.
export function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: "medium" });
}

// The line under a note's `review_every` property saying how recall read it:
// "every 6 months · next review 26 Mar 2027". Null when there's nothing to
// confirm (no value, or recall couldn't read it; the hint covers that).
export function reviewConfirmation(review: NoteReview | null | undefined): string | null {
  if (!review) return null;
  const when = review.overdue
    ? `review was due ${formatDay(review.due)}`
    : `next review ${formatDay(review.due)}`;
  return `every ${review.every_text} · ${when}`;
}

// How a free-text `owner:` resolves against the workspace's members, matched
// like the backend's "Owner has left" check: email or display name, ignoring
// case. Null for an empty value.
export function ownerStatus(
  value: string,
  members: Pick<Member, "upn" | "display_name">[],
): { text: string; warn: boolean } | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const m = members.find(
    (x) => x.upn.toLowerCase() === v || (x.display_name ?? "").toLowerCase() === v,
  );
  return m
    ? { text: `${m.display_name || m.upn} · member`, warn: false }
    : { text: "not a member of this workspace", warn: true };
}

// Split a hint message on `backticks` so field and tag names render as code.
export function hintParts(message: string): { text: string; code: boolean }[] {
  return message
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1
        ? { text: part.slice(1, -1), code: true }
        : { text: part, code: false },
    );
}
