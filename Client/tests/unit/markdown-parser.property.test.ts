/**
 * Property tests for the markdown tokenizer (markdown.ts) and the
 * XSS-safe DOM renderer built on top of it (content-parser.ts).
 *
 * These are fuzz-style invariants, not example-based checks:
 *  - the parsers never throw on arbitrary input
 *  - the DOM they build never contains a <script>, an on* attribute, or an
 *    href that isn't a safe http(s) URL (no javascript:/data:/vbscript:)
 *  - pathological input (long delimiter runs, long unmatched brackets) stays
 *    within a generous time budget — a regression guard on the O(n^2) fix
 *    already in place for bracket matching.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { parseInline, parseBlocks } from "../../src/lib/text/markdown";
import {
  renderInlineContent,
  renderMessageContent,
} from "../../src/features/messaging/content/contentParser";
import { useContentContainer } from "../helpers/contentRenderHarness";

useContentContainer();

/** Small alphabet of markdown-significant characters, weighted heavily toward
 *  the tokens the grammar actually branches on — random unicode alone rarely
 *  hits the interesting cases (unbalanced delimiters, escapes, nested links). */
const MARKDOWN_CHARS = [
  "*",
  "_",
  "~",
  "|",
  "`",
  "[",
  "]",
  "(",
  ")",
  ">",
  "#",
  "-",
  "+",
  ".",
  "!",
  "\\",
  "@",
  ":",
  " ",
  "\n",
  "a",
  "b",
  "1",
  "<",
  '"',
  "'",
  "\t",
];

const markdownFragment = fc.string({ unit: fc.constantFrom(...MARKDOWN_CHARS), maxLength: 200 });

/** Any string at all — the wider net for pure "never throws". */
const anyString = fc.string({ maxLength: 500 });

function allElements(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll("*"));
}

function assertDomIsSafe(root: ParentNode): void {
  expect(root.querySelector("script")).toBeNull();

  for (const el of allElements(root)) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
    }
  }

  for (const anchor of Array.from(root.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href");
    if (href === null) continue;
    expect(/^https?:/i.test(href)).toBe(true);
    expect(/^\s*javascript:/i.test(href)).toBe(false);
    expect(/^\s*data:/i.test(href)).toBe(false);
    expect(/^\s*vbscript:/i.test(href)).toBe(false);
  }
}

describe("parseInline / parseBlocks — never throw", () => {
  it("parseInline never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(() => parseInline(s)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("parseInline never throws on markdown-shaped fragments", () => {
    fc.assert(
      fc.property(markdownFragment, (s) => {
        expect(() => parseInline(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it("parseBlocks never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(() => parseBlocks(s)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("parseBlocks never throws on markdown-shaped fragments", () => {
    fc.assert(
      fc.property(markdownFragment, (s) => {
        expect(() => parseBlocks(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe("renderMessageContent / renderInlineContent — never throw, always safe", () => {
  it("renderMessageContent never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(() => renderMessageContent(s)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("renderMessageContent never throws on markdown-shaped fragments", () => {
    fc.assert(
      fc.property(markdownFragment, (s) => {
        expect(() => renderMessageContent(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it("the rendered DOM never contains a <script>, an on* attribute, or an unsafe href", () => {
    fc.assert(
      fc.property(markdownFragment, (s) => {
        const host = document.createElement("div");
        host.appendChild(renderMessageContent(s));
        assertDomIsSafe(host);
      }),
      { numRuns: 500 },
    );
  });

  it("renderInlineContent never throws and stays safe, including for explicit XSS shapes", () => {
    const xssShapes = fc.constantFrom(
      "<script>alert(1)</script>",
      "[click](javascript:alert(1))",
      "[click](JaVaScRiPt:alert(1))",
      "[click](data:text/html,<script>alert(1)</script>)",
      "[click](vbscript:msgbox(1))",
      "<img src=x onerror=alert(1)>",
      '<a href="javascript:alert(1)">x</a>',
      "javascript://alert(1)",
      "**<img src=x onerror=alert(1)>**",
      "[xss](  javascript:alert(1)  )",
    );
    fc.assert(
      fc.property(xssShapes, (s) => {
        const host = document.createElement("div");
        expect(() => host.appendChild(renderInlineContent(s))).not.toThrow();
        assertDomIsSafe(host);
      }),
      { numRuns: 10 },
    );
  });
});

describe("bounded time on pathological input", () => {
  // Stryker's instrumentation makes the wall-clock bound meaningless, so it gets a far larger budget.
  const BUDGET_MS = process.env.OC_MUTATION_RUN ? 60_000 : 3000;
  // The suite's 2 s test timeout would end a run before the budget is measured.
  const TIMEOUT_MS = BUDGET_MS + 5000;

  it.each([
    ["a long run of unmatched '[' stays within budget", "[".repeat(5000)],
    ["a long run of unmatched '*' stays within budget", "*".repeat(5000)],
    ["a long run of unmatched '(' stays within budget", "[x](".repeat(5000)],
    [
      "deeply nested emphasis stays within budget (MAX_DEPTH guards recursion)",
      "*".repeat(2000) + "x" + "*".repeat(2000),
    ],
    ["a long mix of brackets and parens stays within budget", "[".repeat(2500) + "(".repeat(2500)],
  ])(
    "%s",
    (_name, input) => {
      const start = Date.now();
      expect(() => renderMessageContent(input)).not.toThrow();
      expect(Date.now() - start).toBeLessThan(BUDGET_MS);
    },
    TIMEOUT_MS,
  );
});
