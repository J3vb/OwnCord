/**
 * Pins markdown.ts's inline tokenizer to a frozen copy of the implementation
 * it had before it was split into per-construct steps. The tokenizer renders
 * untrusted text, so its output must stay identical for every input: the
 * copy below is deliberately verbatim and must not be edited to follow the
 * live code.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { parseInline, type InlineNode, type InlineStyle } from "../../src/lib/text/markdown";
import type { TimestampStyle } from "../../src/lib/text/discordTimestamp";

// ---- Frozen copy -------------------------------------------------------------

/** `<t:1700000000>` or `<t:1700000000:R>`, sticky: matched at `lastIndex`. */
const TIMESTAMP_RE = /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y;
/** `<https://…>`, sticky: matched at `lastIndex`. */
const ANGLE_URL_RE = /<(https?:\/\/[^\s<>]+)>/iy;

/** Characters a backslash can neutralise. Anything else keeps its backslash. */
const ESCAPABLE = "\\`*_~|[]()<>#-+.!";

/** Nesting cap — a guard against pathological input, not a style choice. */
const MAX_DEPTH = 6;

/** Bare-URL shape, kept in sync with URL_REGEX in content-parser. */
const URL_START = /^https?:\/\//i;

/** Shared empty map for `legacyParseInline` calls with nothing to bracket-match. */
const EMPTY_MATCHES: ReadonlyMap<number, number> = new Map();

interface DelimSpec {
  readonly marker: string;
  /** Outermost style first; `***x***` is bold wrapping italic. */
  readonly styles: readonly InlineStyle[];
}

/** Longest markers first — `***` must win over `**`, and `**` over `*`. */
const DELIMS: readonly DelimSpec[] = [
  { marker: "***", styles: ["strong", "em"] },
  { marker: "___", styles: ["underline", "em"] },
  { marker: "**", styles: ["strong"] },
  { marker: "__", styles: ["underline"] },
  { marker: "~~", styles: ["strike"] },
  { marker: "||", styles: ["spoiler"] },
  { marker: "*", styles: ["em"] },
  { marker: "_", styles: ["em"] },
];

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (i + n < src.length && src[i + n] === ch) n++;
  return n;
}

/**
 * End index (exclusive) of the code span opening at `i`, or -1 when it never
 * closes. Supports single and double backtick fences.
 */
function codeSpanEnd(src: string, i: number): number {
  const run = Math.min(runLength(src, i, "`"), 2);
  const fence = "`".repeat(run);
  const close = src.indexOf(fence, i + run);
  if (close < 0) return -1;
  return close + run;
}

/**
 * End index (exclusive) of a bare URL starting at `i`, or `i` when there is
 * none. Trailing delimiter runs are given back so `**https://a/b**` still
 * closes its bold — a URL swallowing the closer is worse than a URL losing a
 * trailing asterisk it almost certainly never had.
 */
function urlEnd(src: string, i: number): number {
  if (!URL_START.test(src.slice(i, i + 8))) return i;
  let end = i;
  while (end < src.length && !/[\s<>"'`]/.test(src[end]!)) end++;
  const min = i + 8;
  for (;;) {
    const tail = src.slice(min, end);
    const run = /([*_~|])\1+$/.exec(tail);
    if (run !== null) {
      end -= run[0].length;
      continue;
    }
    if (end > min && (src[end - 1] === "*" || src[end - 1] === "_")) {
      end--;
      continue;
    }
    break;
  }
  return end;
}

/** The delimiter opening at `i`, or null. */
function matchDelim(src: string, i: number): DelimSpec | null {
  for (const d of DELIMS) {
    if (!src.startsWith(d.marker, i)) continue;
    // `snake_case_names` must stay literal: an underscore only opens emphasis
    // on a word boundary.
    if (d.marker[0] === "_" && isWordChar(src[i - 1])) continue;
    return d;
  }
  return null;
}

/**
 * Index of the delimiter run that closes `marker`, searching from `from`, or
 * -1. Escapes, code spans and bare URLs are skipped so a closer hiding inside
 * them is not mistaken for the real one.
 */
function scanClose(src: string, from: number, marker: string): number {
  const ch = marker[0]!;
  const len = marker.length;
  let j = from;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      const end = codeSpanEnd(src, j);
      if (end > 0) {
        j = end;
        continue;
      }
    }
    if (c === "<") {
      ANGLE_URL_RE.lastIndex = j;
      const angle = ANGLE_URL_RE.exec(src);
      if (angle !== null) {
        j += angle[0].length;
        continue;
      }
    }
    const u = urlEnd(src, j);
    if (u > j) {
      j = u;
      continue;
    }
    if (c === ch) {
      const run = runLength(src, j, ch);
      const usable = len > 1 ? run >= len : run === 1;
      if (usable && (ch !== "_" || !isWordChar(src[j + len]))) return j;
      j += run;
      continue;
    }
    j++;
  }
  return -1;
}

/**
 * Matches for every `openCh` in `src` to its balanced `closeCh`, computed in
 * one linear pass with a stack (an opener that never closes just never gets
 * an entry). A run's mismatched openers therefore cost O(1) each to look up
 * instead of a fresh O(n) rescan apiece — the same semantics as calling a
 * depth-counting scan from every individual opener (nesting balances the
 * same way, escapes swallow the following character unconditionally, and a
 * bare newline strands whatever is still open across it), just computed once
 * per `legacyParseInline` invocation instead of once per opener.
 */
function buildMatches(src: string, openCh: string, closeCh: string): ReadonlyMap<number, number> {
  const matches = new Map<number, number>();
  const stack: number[] = [];
  for (let j = 0; j < src.length; j++) {
    const c = src[j]!;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n") {
      // Nothing left open can span a newline; abandon it rather than let it
      // match something on a later line.
      stack.length = 0;
      continue;
    }
    if (c === openCh) stack.push(j);
    else if (c === closeCh) {
      const open = stack.pop();
      if (open !== undefined) matches.set(open, j);
    }
  }
  return matches;
}

/** Parse `[text](url)` at `i`. The URL is *not* validated here — that is the
 * renderer's job, which is why the raw source travels with the node. */
function parseLink(
  src: string,
  i: number,
  depth: number,
  bracketMatches: ReadonlyMap<number, number>,
  parenMatches: ReadonlyMap<number, number>,
): { node: InlineNode; end: number } | null {
  const close = bracketMatches.get(i) ?? -1;
  if (close < 0 || src[close + 1] !== "(") return null;
  const urlClose = parenMatches.get(close + 1) ?? -1;
  if (urlClose < 0) return null;
  const url = src.slice(close + 2, urlClose).trim();
  if (url.length === 0 || /\s/.test(url)) return null;
  const text = src.slice(i + 1, close);
  if (text.length === 0) return null;
  return {
    node: {
      type: "link",
      url,
      raw: src.slice(i, urlClose + 1),
      children: legacyParseInline(text, depth + 1),
    },
    end: urlClose + 1,
  };
}

/**
 * Tokenize one run of inline text (no block constructs, no newline meaning).
 */
function legacyParseInline(src: string, depth = 0): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ type: "text", value: buf });
      buf = "";
    }
  };

  // Built once per invocation (not once per `[`) — see buildMatches. Skipped
  // entirely when the substring has nothing to match, which is the common
  // case for recursive calls into styled/link text.
  const bracketMatches = src.includes("[") ? buildMatches(src, "[", "]") : EMPTY_MATCHES;
  const parenMatches = src.includes("(") ? buildMatches(src, "(", ")") : EMPTY_MATCHES;

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    if (c === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1]!)) {
      buf += src[i + 1]!;
      i += 2;
      continue;
    }

    if (c === "`") {
      const end = codeSpanEnd(src, i);
      if (end > i) {
        const run = Math.min(runLength(src, i, "`"), 2);
        flush();
        out.push({ type: "code", value: src.slice(i + run, end - run) });
        i = end;
        continue;
      }
    }

    if (c === "<") {
      TIMESTAMP_RE.lastIndex = i;
      const ts = TIMESTAMP_RE.exec(src);
      // Past what a Date can hold (±8.64e12 s) the token stays text.
      if (ts !== null && Math.abs(Number(ts[1])) <= 8.64e12) {
        flush();
        const style = (ts[2] ?? "f") as TimestampStyle;
        out.push({ type: "timestamp", unix: Number(ts[1]), style });
        i += ts[0].length;
        continue;
      }
      ANGLE_URL_RE.lastIndex = i;
      const angle = ANGLE_URL_RE.exec(src);
      if (angle !== null) {
        flush();
        out.push({ type: "url", url: angle[1]!, raw: angle[0] });
        i += angle[0].length;
        continue;
      }
    }

    // A bare URL is opaque: its underscores and asterisks are address, not
    // markup, and it is autolinked later by the renderer.
    const u = urlEnd(src, i);
    if (u > i) {
      buf += src.slice(i, u);
      i = u;
      continue;
    }

    if (depth < MAX_DEPTH && c === "[") {
      const link = parseLink(src, i, depth, bracketMatches, parenMatches);
      if (link !== null) {
        flush();
        out.push(link.node);
        i = link.end;
        continue;
      }
    }

    if (depth < MAX_DEPTH) {
      const d = matchDelim(src, i);
      if (d !== null) {
        const innerStart = i + d.marker.length;
        const close = scanClose(src, innerStart, d.marker);
        if (close > innerStart) {
          flush();
          const children = legacyParseInline(src.slice(innerStart, close), depth + 1);
          let node: InlineNode = { type: d.styles[d.styles.length - 1]!, children };
          for (let k = d.styles.length - 2; k >= 0; k--) {
            node = { type: d.styles[k]!, children: [node] };
          }
          out.push(node);
          i = close + d.marker.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

// ---- Comparison --------------------------------------------------------------

const ALPHABET = [
  "*",
  "_",
  "~",
  "|",
  "`",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "\\",
  "\n",
  " ",
  "a",
  "b",
  "1",
  ":",
  "/",
  "!",
  ".",
  "t",
  "h",
  "p",
  "s",
  "-",
  "R",
];

const fragment = fc.string({ unit: fc.constantFrom(...ALPHABET), maxLength: 120 });

const snippets = [
  "**bold**",
  "*em*",
  "***both***",
  "__u__",
  "~~s~~",
  "||spoiler||",
  "`code`",
  "``a`b``",
  "[text](https://x.y/z)",
  "[a [b] c](u)",
  "<https://a.b/c>",
  "<t:1700000000>",
  "<t:1700000000:R>",
  "<t:99999999999999>",
  "https://a.b/**c**",
  "snake_case_name",
  "\\*escaped\\*",
  "\\q",
  "[unclosed",
  "(paren)",
  "**unclosed",
  "_a_",
  "foo_bar_",
];

const composed = fc
  .array(fc.oneof(fc.constantFrom(...snippets), fragment), { maxLength: 8 })
  .map((parts) => parts.join(""));

describe("parseInline against its frozen predecessor", () => {
  it("matches on random markdown-significant input", () => {
    fc.assert(
      fc.property(fragment, fc.integer({ min: 0, max: 7 }), (src, depth) => {
        expect(parseInline(src, depth)).toStrictEqual(legacyParseInline(src, depth));
      }),
      { numRuns: 2000 },
    );
  }, 60_000);

  it("matches on composed constructs, nested and broken", () => {
    fc.assert(
      fc.property(composed, (src) => {
        expect(parseInline(src)).toStrictEqual(legacyParseInline(src));
      }),
      { numRuns: 2000 },
    );
  }, 60_000);

  it("matches on arbitrary unicode strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (src) => {
        expect(parseInline(src)).toStrictEqual(legacyParseInline(src));
      }),
      { numRuns: 500 },
    );
  }, 60_000);

  it.each(snippets)("matches on the fixed construct %j", (src) => {
    expect(parseInline(src)).toStrictEqual(legacyParseInline(src));
  });
});
