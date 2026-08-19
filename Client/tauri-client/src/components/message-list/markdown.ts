/**
 * Discord-flavoured inline markdown tokenizer.
 *
 * Pure and DOM-free on purpose: this module only decides *what* the text
 * means, `content-parser.ts` decides what nodes it becomes. Keeping the two
 * apart is what lets the renderer stay a strict DOM builder (no innerHTML)
 * while the grammar gets tested on its own.
 *
 * The tokenizer is a single left-to-right scan with recursive descent into
 * matched delimiter pairs — not a stack of regexes — so nesting
 * (`**bold *and italic* **`), escaping (`\*literal\*`) and "markdown is dead
 * inside code" all fall out of one rule set instead of fighting each other.
 */

/** Emphasis-style wrappers, in the flavour Discord uses. */
export type InlineStyle = "strong" | "em" | "underline" | "strike" | "spoiler";

export type InlineNode =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "code"; readonly value: string }
  | {
      readonly type: "link";
      readonly url: string;
      readonly raw: string;
      readonly children: readonly InlineNode[];
    }
  | { readonly type: InlineStyle; readonly children: readonly InlineNode[] };

/** Characters a backslash can neutralise. Anything else keeps its backslash. */
const ESCAPABLE = "\\`*_~|[]()>#-+.!";

/** Nesting cap — a guard against pathological input, not a style choice. */
const MAX_DEPTH = 6;

/** Bare-URL shape, kept in sync with URL_REGEX in content-parser. */
const URL_START = /^https?:\/\//i;

/** Shared empty map for `parseInline` calls with nothing to bracket-match. */
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
 * per `parseInline` invocation instead of once per opener.
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
      children: parseInline(text, depth + 1),
    },
    end: urlClose + 1,
  };
}

/**
 * Tokenize one run of inline text (no block constructs, no newline meaning).
 */
export function parseInline(src: string, depth = 0): InlineNode[] {
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
          const children = parseInline(src.slice(innerStart, close), depth + 1);
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

// -- Block constructs ---------------------------------------------------------

export type BlockNode =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly type: "quote"; readonly text: string }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ListItem[];
    };

export interface ListItem {
  readonly text: string;
  /** 0 for a top-level item, 1 for a single level of indentation. */
  readonly level: 0 | 1;
  readonly ordered: boolean;
}

const HEADING_RE = /^(#{1,3}) +(.*)$/;
const QUOTE_RE = /^> ?(.*)$/;
const BLOCK_QUOTE_ALL_RE = /^>>> ?(.*)$/;
const BULLET_RE = /^( *)([-*]) +(.*)$/;
const ORDERED_RE = /^( *)(\d{1,9})[.)] +(.*)$/;

function listItemAt(line: string): ListItem | null {
  const bullet = BULLET_RE.exec(line);
  if (bullet !== null) {
    return { text: bullet[3]!, level: bullet[1]!.length >= 2 ? 1 : 0, ordered: false };
  }
  const ordered = ORDERED_RE.exec(line);
  if (ordered !== null) {
    return { text: ordered[3]!, level: ordered[1]!.length >= 2 ? 1 : 0, ordered: true };
  }
  return null;
}

function orderedStart(line: string): number {
  const m = ORDERED_RE.exec(line);
  return m === null ? 1 : Number(m[2]);
}

/**
 * Split a prose segment into block nodes. Block markers are only recognised at
 * the start of a line, exactly like Discord; everything else joins the
 * surrounding paragraph so inline styles may span line breaks.
 */
export function parseBlocks(text: string): BlockNode[] {
  const lines = text.split("\n");
  const out: BlockNode[] = [];
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      out.push({ type: "paragraph", text: para.join("\n") });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const all = BLOCK_QUOTE_ALL_RE.exec(line);
    if (all !== null) {
      flushPara();
      const rest = [all[1]!, ...lines.slice(i + 1)].join("\n");
      out.push({ type: "quote", text: rest });
      return out;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote !== null) {
      flushPara();
      const collected = [quote[1]!];
      while (i + 1 < lines.length) {
        const next = QUOTE_RE.exec(lines[i + 1]!);
        if (next === null) break;
        collected.push(next[1]!);
        i++;
      }
      out.push({ type: "quote", text: collected.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      flushPara();
      out.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! });
      continue;
    }

    const item = listItemAt(line);
    if (item !== null) {
      flushPara();
      const items: ListItem[] = [item];
      const ordered = item.ordered;
      const start = ordered ? orderedStart(line) : 1;
      while (i + 1 < lines.length) {
        const next = listItemAt(lines[i + 1]!);
        // A list ends when the marker style changes at the top level; nested
        // items may differ from their parent.
        if (next === null || (next.level === 0 && next.ordered !== ordered)) break;
        items.push(next);
        i++;
      }
      out.push({ type: "list", ordered, start, items });
      continue;
    }

    para.push(line);
  }

  flushPara();
  return out;
}
