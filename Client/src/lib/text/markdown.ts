/**
 * Discord-flavoured inline markdown tokenizer.
 *
 * Pure and DOM-free on purpose: this module only decides *what* the text
 * means, `content-parser.ts` decides what nodes it becomes. Keeping the two
 * apart is what lets the renderer stay a strict DOM builder (no innerHTML)
 * while the grammar gets tested on its own.
 *
 * `markdownToPlainText` flattens that grammar back to visible words for
 * surfaces that may not render markup or reveal a spoiler (OS notifications);
 * it is a consumer of the tokenizer, not part of its grammar.
 *
 * The tokenizer is a single left-to-right scan with recursive descent into
 * matched delimiter pairs — not a stack of regexes — so nesting
 * (`**bold *and italic* **`), escaping (`\*literal\*`) and "markdown is dead
 * inside code" all fall out of one rule set instead of fighting each other.
 */

import { formatDiscordTimestamp, type TimestampStyle } from "./discordTimestamp";
import {
  ANGLE_URL_RE,
  buildMatches,
  codeSpanEnd,
  matchDelim,
  runLength,
  scanClose,
  urlEnd,
} from "./markdownScan";

export { codeSpanEnd };

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
  /** `<https://…>`: a link with no embed, shown without its brackets. */
  | { readonly type: "url"; readonly url: string; readonly raw: string }
  /** `<t:unix>` / `<t:unix:style>`, shown in the reader's own time zone. */
  | { readonly type: "timestamp"; readonly unix: number; readonly style: TimestampStyle }
  | { readonly type: InlineStyle; readonly children: readonly InlineNode[] };

export type { TimestampStyle };

/** `<t:1700000000>` or `<t:1700000000:R>`, sticky: matched at `lastIndex`. */
const TIMESTAMP_RE = /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y;

/** Characters a backslash can neutralise. Anything else keeps its backslash. */
const ESCAPABLE = "\\`*_~|[]()<>#-+.!";

/** Nesting cap — a guard against pathological input, not a style choice. */
const MAX_DEPTH = 6;

/** Shared empty map for `parseInline` calls with nothing to bracket-match. */
const EMPTY_MATCHES: ReadonlyMap<number, number> = new Map();

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

/** What one step of the scan consumed: text for the buffer, or a node. */
interface InlineToken {
  /** Index after the consumed source. */
  readonly end: number;
  /** A node to emit (flushing the text buffer first), or null for plain text. */
  readonly node: InlineNode | null;
  readonly text: string;
}

function nodeToken(node: InlineNode, end: number): InlineToken {
  return { end, node, text: "" };
}

function textToken(text: string, end: number): InlineToken {
  return { end, node: null, text };
}

/** A backslash before an escapable character: that character, literal. */
function escapeToken(src: string, i: number, c: string): InlineToken | null {
  if (c !== "\\" || i + 1 >= src.length || !ESCAPABLE.includes(src[i + 1]!)) return null;
  return textToken(src[i + 1]!, i + 2);
}

/** A closed code span, in which markdown is dead. */
function codeToken(src: string, i: number, c: string): InlineToken | null {
  if (c !== "`") return null;
  const end = codeSpanEnd(src, i);
  if (end <= i) return null;
  const run = Math.min(runLength(src, i, "`"), 2);
  return nodeToken({ type: "code", value: src.slice(i + run, end - run) }, end);
}

/** `<t:unix>` or `<https://…>` at `i`. */
function angleToken(src: string, i: number, c: string): InlineToken | null {
  if (c !== "<") return null;
  TIMESTAMP_RE.lastIndex = i;
  const ts = TIMESTAMP_RE.exec(src);
  // Past what a Date can hold (±8.64e12 s) the token stays text.
  if (ts !== null && Math.abs(Number(ts[1])) <= 8.64e12) {
    const style = (ts[2] ?? "f") as TimestampStyle;
    return nodeToken({ type: "timestamp", unix: Number(ts[1]), style }, i + ts[0].length);
  }
  ANGLE_URL_RE.lastIndex = i;
  const angle = ANGLE_URL_RE.exec(src);
  if (angle === null) return null;
  return nodeToken({ type: "url", url: angle[1]!, raw: angle[0] }, i + angle[0].length);
}

/** A bare URL is opaque: its underscores and asterisks are address, not
 *  markup, and it is autolinked later by the renderer. */
function urlToken(src: string, i: number): InlineToken | null {
  const u = urlEnd(src, i);
  return u > i ? textToken(src.slice(i, u), u) : null;
}

function linkToken(
  src: string,
  i: number,
  c: string,
  depth: number,
  bracketMatches: ReadonlyMap<number, number>,
  parenMatches: ReadonlyMap<number, number>,
): InlineToken | null {
  if (depth >= MAX_DEPTH || c !== "[") return null;
  const link = parseLink(src, i, depth, bracketMatches, parenMatches);
  return link === null ? null : nodeToken(link.node, link.end);
}

/** A delimiter pair opening at `i` and closing later, as nested style nodes. */
function styledToken(src: string, i: number, depth: number): InlineToken | null {
  if (depth >= MAX_DEPTH) return null;
  const d = matchDelim(src, i);
  if (d === null) return null;
  const innerStart = i + d.marker.length;
  const close = scanClose(src, innerStart, d.marker);
  if (close <= innerStart) return null;
  const children = parseInline(src.slice(innerStart, close), depth + 1);
  let node: InlineNode = { type: d.styles[d.styles.length - 1]!, children };
  for (let k = d.styles.length - 2; k >= 0; k--) {
    node = { type: d.styles[k]!, children: [node] };
  }
  return nodeToken(node, close + d.marker.length);
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
    const token =
      escapeToken(src, i, c) ??
      codeToken(src, i, c) ??
      angleToken(src, i, c) ??
      urlToken(src, i) ??
      linkToken(src, i, c, depth, bracketMatches, parenMatches) ??
      styledToken(src, i, depth);
    if (token === null) {
      buf += c;
      i++;
      continue;
    }
    if (token.node === null) {
      buf += token.text;
    } else {
      flush();
      out.push(token.node);
    }
    i = token.end;
  }

  flush();
  return out;
}

// -- Code fences --------------------------------------------------------------

export interface MarkdownSegment {
  readonly kind: "prose" | "code";
  readonly text: string;
  /** Raw fence tag, e.g. "ts" — present only on code segments that had one. */
  readonly lang: string | null;
}

const FENCE = "```";
const LANG_TAG_REGEX = /^[A-Za-z][\w+#-]{0,19}$/;

/** Split a message into prose and fenced-code segments. */
export function splitCodeFences(content: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let i = 0;
  while (i < content.length) {
    const open = content.indexOf(FENCE, i);
    const close = open < 0 ? -1 : content.indexOf(FENCE, open + FENCE.length);
    if (open < 0 || close < 0) break;

    if (open > i) segments.push({ kind: "prose", text: content.slice(i, open), lang: null });

    const inner = content.slice(open + FENCE.length, close);
    const newline = inner.indexOf("\n");
    const tag = newline > 0 ? inner.slice(0, newline).trim() : "";
    if (tag.length > 0 && LANG_TAG_REGEX.test(tag)) {
      segments.push({
        kind: "code",
        text: inner.slice(newline + 1).replace(/\s+$/, ""),
        lang: tag,
      });
    } else {
      segments.push({ kind: "code", text: inner.trim(), lang: null });
    }
    i = close + FENCE.length;
  }
  if (i < content.length) segments.push({ kind: "prose", text: content.slice(i), lang: null });
  return segments;
}

/**
 * The visible words of a message: markdown structure removed, a spoiler
 * replaced by `spoilerLabel` rather than its hidden text.
 *
 * This is for surfaces that must not show raw markup or a spoiler nobody has
 * clicked — chiefly the OS notification body, which appears on a lock screen.
 * The label is passed in rather than baked in so it stays translatable copy,
 * resolved through the caller's catalog.
 */
export function markdownToPlainText(content: string, spoilerLabel: string): string {
  const lines: string[] = [];
  for (const segment of splitCodeFences(content)) {
    if (segment.kind === "code") {
      lines.push(segment.text);
      continue;
    }
    for (const block of parseBlocks(segment.text)) {
      lines.push(blockText(block, spoilerLabel));
    }
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** Flatten one block node's text (recursing through quotes). */
function blockText(block: BlockNode, spoilerLabel: string): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "subtext":
      return inlineText(parseInline(block.text), spoilerLabel);
    case "quote":
      return parseBlocks(block.text)
        .map((b) => blockText(b, spoilerLabel))
        .join(" ");
    case "list":
      return block.items.map((item) => inlineText(parseInline(item.text), spoilerLabel)).join(" ");
    default:
      return "";
  }
}

/** Flatten inline nodes to their visible text, hiding spoiler content. */
function inlineText(nodes: readonly InlineNode[], spoilerLabel: string): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.value;
        case "spoiler":
          return spoilerLabel;
        case "url":
          return node.url;
        case "timestamp":
          return formatDiscordTimestamp(node.unix, node.style).text;
        case "link":
          return inlineText(node.children, spoilerLabel);
        default:
          return inlineText(node.children, spoilerLabel);
      }
    })
    .join("");
}

// -- Block constructs ---------------------------------------------------------

export type BlockNode =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  /** `-# small text`: a line in smaller, muted type. */
  | { readonly type: "subtext"; readonly text: string }
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
const SUBTEXT_RE = /^-# +(.*)$/;
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

    const subtext = SUBTEXT_RE.exec(line);
    if (subtext !== null) {
      flushPara();
      out.push({ type: "subtext", text: subtext[1]! });
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
