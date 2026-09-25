import { describe, expect, it } from "vitest";

import { highlightTerms } from "@/lib/mentions";

const hits = (text: string, terms: string[]) =>
  highlightTerms(text, terms)
    .filter((p) => p.hit)
    .map((p) => p.text);

describe("highlightTerms", () => {
  it("marks whole-word, case-insensitive matches and keeps the text intact", () => {
    const parts = highlightTerms("When the Worker restarts, the worker logs.", ["worker"]);
    expect(parts.map((p) => p.text).join("")).toBe(
      "When the Worker restarts, the worker logs.",
    );
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["Worker", "worker"]);
  });

  it("does not match inside longer words", () => {
    expect(hits("my coworker and the workers", ["worker"])).toEqual([]);
    expect(hits("worker_pool", ["worker"])).toEqual([]);
  });

  it("treats accented letters as word characters", () => {
    expect(hits("Koko JÄRJESTELMÄ toimii", ["Järjestelmä"])).toEqual(["JÄRJESTELMÄ"]);
    expect(hits("järjestelmän osa", ["Järjestelmä"])).toEqual([]);
    expect(hits("äkivi ja kivi", ["kivi"])).toEqual(["kivi"]);
  });

  it("prefers the longest term and matches phrases across whitespace", () => {
    expect(hits("the worker   pool is busy", ["worker", "worker pool"])).toEqual([
      "worker   pool",
    ]);
  });

  it("escapes regex characters in terms", () => {
    expect(hits("use C.NET (v2) today", ["C.NET (v2)"])).toEqual(["C.NET (v2)"]);
    expect(hits("use CxNET today", ["C.NET"])).toEqual([]);
  });

  it("handles empty input", () => {
    expect(highlightTerms("", ["x"])).toEqual([]);
    expect(highlightTerms("plain", [])).toEqual([{ text: "plain", hit: false }]);
    expect(highlightTerms("plain", ["  "])).toEqual([{ text: "plain", hit: false }]);
  });
});
