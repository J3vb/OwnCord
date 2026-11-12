/**
 * Message text is untrusted, and every reader parses it on the main thread.
 * A message at the server's length limit has to parse quickly whatever it
 * holds: openers that never close used to cost a full rescan each, and a bare
 * URL with a long tail of delimiters a regex pass per stripped run.
 */

import { describe, it, expect } from "vitest";

import { markdownToPlainText, parseInline } from "../../src/lib/text/markdown";

const MAX_MESSAGE_LEN = 4000;
// Generous for a slow CI runner; before the fix the URL-tail input took 16 s.
const BUDGET_MS = 500;

const HOSTILE: Readonly<Record<string, string>> = {
  "unclosed underscore openers": " __a".repeat(997),
  "unclosed openers before a URL with a delimiter tail":
    " __a".repeat(332) + " https://x" + "*~~".repeat(883),
  "URL with a delimiter tail": "a https://x" + "*~~".repeat(1300),
  "unclosed openers of every marker": "*a **a ***a ~~a ||a _a ".repeat(173),
};

function elapsedMs(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("markdown parse time on hostile text", () => {
  for (const [name, text] of Object.entries(HOSTILE)) {
    it(`parses ${name} within budget`, () => {
      expect([...text].length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
      expect(elapsedMs(() => parseInline(text))).toBeLessThan(BUDGET_MS);
      expect(elapsedMs(() => markdownToPlainText(text, "spoiler"))).toBeLessThan(BUDGET_MS);
    });
  }

  it("still gives back trailing delimiters of a URL", () => {
    expect(parseInline("**https://a.example/b**")).toEqual([
      { type: "strong", children: [{ type: "text", value: "https://a.example/b" }] },
    ]);
    expect(parseInline("see https://a.example/b~~*")).toEqual([
      { type: "text", value: "see https://a.example/b~~*" },
    ]);
  });
});
