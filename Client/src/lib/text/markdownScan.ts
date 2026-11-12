/**
 * The scanning primitives under the inline tokenizer (markdown.ts): delimiter
 * matching, closer search, code-span and bare-URL extents, and bracket
 * matching. Pure string functions, no node construction.
 */

import type { InlineStyle } from "./markdown";

/** `<https://…>`, sticky: matched at `lastIndex`. */
export const ANGLE_URL_RE = /<(https?:\/\/[^\s<>]+)>/iy;

/** Bare-URL shape, kept in sync with URL_REGEX in content-parser. */
const URL_START = /^https?:\/\//i;

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

export function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (i + n < src.length && src[i + n] === ch) n++;
  return n;
}

/**
 * End index (exclusive) of the code span opening at `i`, or -1 when it never
 * closes. Supports single and double backtick fences.
 */
export function codeSpanEnd(src: string, i: number): number {
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
export function urlEnd(src: string, i: number): number {
  if (!URL_START.test(src.slice(i, i + 8))) return i;
  let end = i;
  while (end < src.length && !/[\s<>"'`]/.test(src[end]!)) end++;
  return stripTrailingDelims(src, i + 8, end);
}

/**
 * Gives back trailing delimiter runs of 2+ (`**`, `~~`, `||`, `__`) and lone
 * `*` or `_`, repeatedly, never below `min`. One backward walk, so a long
 * tail of delimiters costs linear time.
 */
function stripTrailingDelims(src: string, min: number, end: number): number {
  let e = end;
  while (e > min) {
    const last = src[e - 1]!;
    if (!TRAILING_DELIMS.has(last)) break;
    let k = e - 1;
    while (k > min && src[k - 1] === last) k--;
    if (e - k >= 2) e = k;
    else if (last === "*" || last === "_") e--;
    else break;
  }
  return e;
}

const TRAILING_DELIMS: ReadonlySet<string> = new Set(["*", "_", "~", "|"]);

/** The delimiter opening at `i`, or null. */
export function matchDelim(src: string, i: number): DelimSpec | null {
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
 * Closer results already found in one source string, per marker: position
 * the scan reached -> the closer it ends at (or -1). The scan carries no state
 * besides its position, so any later scan that reaches a recorded position
 * ends the same way, and every position is walked at most once per marker.
 */
export type CloseMemo = Map<string, Map<number, number>>;

/**
 * Index of the delimiter run that closes `marker`, searching from `from`, or
 * -1. Escapes, code spans and bare URLs are skipped so a closer hiding inside
 * them is not mistaken for the real one. Pass the same `memo` for every call
 * on one `src` to keep a run of openers that never close linear.
 */
export function scanClose(src: string, from: number, marker: string, memo?: CloseMemo): number {
  let known = memo?.get(marker);
  if (memo !== undefined && known === undefined) {
    known = new Map();
    memo.set(marker, known);
  }
  const visited: number[] = [];
  let j = from;
  let result = -1;
  while (j < src.length) {
    const hit = known?.get(j);
    if (hit !== undefined) {
      result = hit;
      break;
    }
    visited.push(j);
    const next = scanStep(src, j, marker);
    if (next < 0) {
      result = j;
      break;
    }
    j = next;
  }
  if (known !== undefined) for (const v of visited) known.set(v, result);
  return result;
}

/** Where the closer scan goes after `j`, or -1 when a usable closer sits at `j`. */
function scanStep(src: string, j: number, marker: string): number {
  const c = src[j]!;
  if (c === "\\") return j + 2;
  if (c === "`") {
    const end = codeSpanEnd(src, j);
    if (end > 0) return end;
  }
  if (c === "<") {
    ANGLE_URL_RE.lastIndex = j;
    const angle = ANGLE_URL_RE.exec(src);
    if (angle !== null) return j + angle[0].length;
  }
  const u = urlEnd(src, j);
  if (u > j) return u;
  const ch = marker[0]!;
  if (c !== ch) return j + 1;
  const len = marker.length;
  const run = runLength(src, j, ch);
  const usable = len > 1 ? run >= len : run === 1;
  if (usable && (ch !== "_" || !isWordChar(src[j + len]))) return -1;
  return j + run;
}

/**
 * Matches for every `openCh` in `src` to its balanced `closeCh`, computed in
 * one linear pass with a stack (an opener that never closes just never gets
 * an entry). A run's mismatched openers therefore cost O(1) each to look up
 * instead of a fresh O(n) rescan apiece — the same semantics as calling a
 * depth-counting scan from every individual opener (nesting balances the
 * same way, escapes swallow the following character unconditionally, and a
 * bare newline strands whatever is still open across it), just computed once
 * per `parseInline` invocation instead of once per opener.
 */
export function buildMatches(
  src: string,
  openCh: string,
  closeCh: string,
): ReadonlyMap<number, number> {
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
