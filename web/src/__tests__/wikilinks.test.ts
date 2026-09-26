import { describe, expect, it } from "vitest";

import { replaceProseWikilinks } from "@/lib/wikilinks";

const mark = (inner: string) => `<${inner}>`;

describe("replaceProseWikilinks", () => {
  it("replaces prose links and keeps alias text for the renderer", () => {
    expect(replaceProseWikilinks("see [[A]] and [[B|bee]]", mark)).toBe("see <A> and <B|bee>");
  });

  it("leaves inline code spans intact", () => {
    expect(replaceProseWikilinks("`[[A]]` ``[[B]]`` [[C]]", mark)).toBe("`[[A]]` ``[[B]]`` <C>");
  });

  it("leaves fenced blocks intact, backtick and tilde", () => {
    const body = "[[A]]\n```js\n[[B]]\n```\n~~~\n[[C]]\n~~~\n[[D]]\n";
    expect(replaceProseWikilinks(body, mark)).toBe("<A>\n```js\n[[B]]\n```\n~~~\n[[C]]\n~~~\n<D>\n");
  });

  it("needs a same-char, same-or-longer marker to close a fence", () => {
    const body = "````\n```\n[[A]]\n````\n[[B]]";
    expect(replaceProseWikilinks(body, mark)).toBe("````\n```\n[[A]]\n````\n<B>");
  });

  it("treats an unclosed fence as code to the end", () => {
    expect(replaceProseWikilinks("[[A]]\n```\n[[B]]\n[[C]]", mark)).toBe("<A>\n```\n[[B]]\n[[C]]");
  });
});
