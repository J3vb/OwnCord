/**
 * Code colouring runs synchronously on untrusted text: fenced code in
 * messages and up to 64 KB of an attached text file. Every language must
 * colour a full-size file of one repeated unit quickly, which is where a
 * pattern that rescans the rest of a run at every index shows up.
 */

import { describe, it, expect } from "vitest";

import {
  highlightCode,
  resolveLanguage,
} from "../../src/features/messaging/content/syntaxHighlight";

const LANGUAGES = [
  "javascript",
  "typescript",
  "go",
  "python",
  "rust",
  "json",
  "bash",
  "css",
  "html",
  "c",
  "cpp",
  "java",
  "csharp",
  "sql",
  "yaml",
  "diff",
  "ansi",
] as const;

const UNITS = [
  "-",
  "a-",
  "${",
  "$",
  '"',
  "/*",
  "#",
  "<!--",
  'r"',
  '"""',
  "@",
  "\\",
  "a:",
  "\u001b[",
];

// The text preview's byte cap; before the fix one CSS line of hyphens took 6 s.
const SIZE = 65_536;
const BUDGET_MS = 400;

function slowestUnit(lang: string): { unit: string; ms: number } {
  let slowest = { unit: "", ms: 0 };
  for (const unit of UNITS) {
    const code = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
    const start = performance.now();
    highlightCode(code, lang);
    const ms = performance.now() - start;
    if (ms > slowest.ms) slowest = { unit, ms };
  }
  return slowest;
}

describe("code colouring time on long repeated input", () => {
  for (const lang of LANGUAGES) {
    it(`colours ${lang} within budget`, { timeout: 10_000 }, () => {
      expect(resolveLanguage(lang)).toBe(lang);
      const { unit, ms } = slowestUnit(lang);
      expect(ms, `slowest unit ${JSON.stringify(unit)}`).toBeLessThan(BUDGET_MS);
    });
  }

  it("still colours a CSS property and a shell parameter", () => {
    expect(highlightCode("a { margin-top: 0 }", "css")).toContainEqual({
      text: "margin-top",
      cls: "keyword",
    });
    expect(highlightCode("echo ${HOME}", "bash")).toContainEqual({
      text: "${HOME}",
      cls: "keyword",
    });
  });
});
