/**
 * The parsed form of a message (the parse cache's payload) and the bounded
 * cache that holds it. Pure data: no DOM is built here.
 */

import { parseInline, parseBlocks, splitCodeFences, type InlineNode } from "@lib/text/markdown";
import { highlightCode, resolveLanguage, type CodeToken } from "./syntaxHighlight";

/** Quotes may contain blocks, but a quote inside a quote inside a quote is a
 * fight the renderer does not need to have. */
const MAX_BLOCK_DEPTH = 2;

// -- Parsed content (the parse cache's payload) -------------------------------
//
// Parsing (splitCodeFences + parseBlocks + parseInline + highlightCode) is the
// expensive half of rendering a message; building the DOM from it is cheap.
// renderMessageContent caches the parse under a key the caller derives from the
// message's identity (id + editedAt), so a row re-materialised by virtual
// scrolling — or one of many rows repainted for a connection or role change —
// does not re-tokenise content that has not changed. Mention resolution and
// emoji lookup stay at render time, because they depend on live stores, not on
// the parse.

export interface ParsedListItem {
  readonly inline: readonly InlineNode[];
  readonly level: 0 | 1;
  readonly ordered: boolean;
}

export type ParsedBlock =
  | { readonly type: "paragraph"; readonly inline: readonly InlineNode[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly inline: readonly InlineNode[] }
  | { readonly type: "subtext"; readonly inline: readonly InlineNode[] }
  | { readonly type: "quote"; readonly blocks: readonly ParsedBlock[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ParsedListItem[];
    };

export type ParsedSegment =
  | { readonly kind: "prose"; readonly blocks: readonly ParsedBlock[] }
  | {
      readonly kind: "code";
      readonly code: string;
      readonly lang: string | null;
      readonly canonical: string | null;
      readonly tokens: readonly CodeToken[];
    };

export interface ParsedMessage {
  readonly segments: readonly ParsedSegment[];
}

function parseBlocksInto(text: string, depth: number): readonly ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const block of parseBlocks(text)) {
    switch (block.type) {
      case "heading":
        out.push({ type: "heading", level: block.level, inline: parseInline(block.text) });
        break;
      case "subtext":
        out.push({ type: "subtext", inline: parseInline(block.text) });
        break;
      case "quote":
        if (depth + 1 >= MAX_BLOCK_DEPTH) {
          out.push({
            type: "quote",
            blocks: [{ type: "paragraph", inline: parseInline(block.text) }],
          });
        } else {
          out.push({ type: "quote", blocks: parseBlocksInto(block.text, depth + 1) });
        }
        break;
      case "list":
        out.push({
          type: "list",
          ordered: block.ordered,
          start: block.start,
          items: block.items.map((item) => ({
            inline: parseInline(item.text),
            level: item.level,
            ordered: item.ordered,
          })),
        });
        break;
      default:
        out.push({ type: "paragraph", inline: parseInline(block.text) });
        break;
    }
  }
  return out;
}

function parseMessageContent(content: string): ParsedMessage {
  const segments: ParsedSegment[] = [];
  for (const segment of splitCodeFences(content)) {
    if (segment.kind === "code") {
      const canonical = resolveLanguage(segment.lang);
      segments.push({
        kind: "code",
        code: segment.text,
        lang: segment.lang,
        canonical,
        tokens: highlightCode(segment.text, canonical),
      });
      continue;
    }
    // Blank lines hugging a fence are formatting, not content.
    const prose = segment.text.replace(/^\n+/, "").replace(/\n+$/, "");
    if (prose.trim().length === 0) continue;
    segments.push({ kind: "prose", blocks: parseBlocksInto(prose, 0) });
  }
  return { segments };
}

// -- Parse cache --------------------------------------------------------------

/** Bounded LRU of parsed message content, keyed by the caller's identity
 *  string (message id + editedAt). Bounded so a long session does not retain a
 *  parse per message ever scrolled past; the cap is well above the rendered
 *  window. Cleared on teardown (clearContentParseCache) and invalidated by the
 *  key whenever a message is edited. */
const PARSE_CACHE_MAX = 200;
const parseCache = new Map<string, ParsedMessage>();

/** Drop every cached parse. The message list calls this on destroy. */
export function clearContentParseCache(): void {
  parseCache.clear();
}

export function parsedFor(content: string, cacheKey: string | undefined): ParsedMessage {
  if (cacheKey === undefined) return parseMessageContent(content);
  // The content is part of the internal key, not just the caller's id/editedAt:
  // a row whose content changed without its identity key moving (an in-flight
  // edit, or a test) must never be served the previous parse.
  const key = `${cacheKey}\u0001${content}`;
  const hit = parseCache.get(key);
  if (hit !== undefined) {
    // Re-insert to keep the entry at the LRU tail.
    parseCache.delete(key);
    parseCache.set(key, hit);
    return hit;
  }
  const parsed = parseMessageContent(content);
  parseCache.set(key, parsed);
  if (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return parsed;
}
