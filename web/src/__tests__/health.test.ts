import { describe, expect, it } from "vitest";

import {
  formatDay,
  healthSummary,
  hintParts,
  listTitle,
  ownerStatus,
  reviewConfirmation,
  reviewedText,
  reviewLine,
} from "@/lib/health";

const NOW = new Date("2026-09-25T12:00:00Z").getTime();

describe("healthSummary", () => {
  it("lists non-zero counts in display order with plurals", () => {
    expect(
      healthSummary({ orphans: 3, overdue: 2, broken_links: 1, not_edited: 0 }).map(
        (s) => s.label,
      ),
    ).toEqual(["2 overdue", "1 missing link", "3 orphans"]);
  });

  it("is empty when everything is healthy", () => {
    expect(healthSummary({ overdue: 0, orphans: 0 })).toEqual([]);
  });

  it("names the stale window in list titles", () => {
    expect(listTitle("not_edited", 6)).toBe("Not edited in 6 months");
  });
});

describe("review wording", () => {
  it("says never reviewed", () => {
    expect(reviewedText(null, NOW)).toBe("Never reviewed");
  });

  it("treats a date within a day as today", () => {
    expect(reviewedText("2026-09-25", NOW)).toBe("Reviewed today");
  });

  it("uses relative time for older reviews", () => {
    expect(reviewedText("2026-01-20", NOW)).toMatch(/^Reviewed 8 months ago$/);
  });

  it("adds the interval", () => {
    expect(
      reviewLine(
        { every: "6mo", every_text: "6 months", reviewed: null, due: "2026-01-01", overdue: true },
        NOW,
      ),
    ).toBe("Never reviewed · review every 6 months");
  });
});

describe("hintParts", () => {
  it("splits backticked names into code parts", () => {
    expect(hintParts("`infrastructure` isn't a tag here. Did you mean `infra`?")).toEqual([
      { text: "infrastructure", code: true },
      { text: " isn't a tag here. Did you mean ", code: false },
      { text: "infra", code: true },
      { text: "?", code: false },
    ]);
  });

  it("leaves text without backticks alone", () => {
    expect(hintParts("plain")).toEqual([{ text: "plain", code: false }]);
  });
});

describe("reviewConfirmation", () => {
  const base = { every: "6mo", every_text: "6 months", reviewed: null };

  it("says how the period was read and when the next review is", () => {
    expect(reviewConfirmation({ ...base, due: "2027-03-26", overdue: false })).toBe(
      `every 6 months · next review ${formatDay("2027-03-26")}`,
    );
  });

  it("says when an overdue review was due", () => {
    expect(reviewConfirmation({ ...base, due: "2026-07-01", overdue: true })).toBe(
      `every 6 months · review was due ${formatDay("2026-07-01")}`,
    );
  });

  it("is empty without a readable period", () => {
    expect(reviewConfirmation(null)).toBeNull();
  });

  it("keeps the calendar day regardless of time zone", () => {
    expect(formatDay("2027-03-26")).toBe(
      new Date(2027, 2, 26).toLocaleDateString(undefined, { dateStyle: "medium" }),
    );
  });
});

describe("ownerStatus", () => {
  const members = [
    { upn: "panu@example.com", display_name: "Panu H" },
    { upn: "sam@example.com", display_name: null },
  ];

  it("names a member matched by email or name, ignoring case", () => {
    expect(ownerStatus("Panu@Example.com", members)).toEqual({
      text: "Panu H · member",
      warn: false,
    });
    expect(ownerStatus("panu h", members)?.text).toBe("Panu H · member");
    expect(ownerStatus("sam@example.com", members)?.text).toBe("sam@example.com · member");
  });

  it("warns when nobody matches", () => {
    expect(ownerStatus("former@example.com", members)).toEqual({
      text: "not a member of this workspace",
      warn: true,
    });
  });

  it("says nothing for an empty value", () => {
    expect(ownerStatus("  ", members)).toBeNull();
  });
});
