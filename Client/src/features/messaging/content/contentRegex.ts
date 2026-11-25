/**
 * The regex constants every message-content renderer shares, and the one rule
 * for what counts as part of a bare URL. A leaf: it imports nothing.
 */

export const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
export const INLINE_CODE_REGEX = /`([^`]+)`/g;
export const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
const WHITESPACE = /\s/;

/** True for a character a masked link's address may hold outside a paren pair. */
function isAddressChar(ch: string): boolean {
  return ch !== "(" && ch !== ")" && !WHITESPACE.test(ch);
}

/**
 * The end (exclusive) of the `(url)` part of a masked link whose `(` is at
 * `open`, or -1. The address is one or more characters that are neither a
 * paren nor whitespace, or a paren pair holding such characters.
 */
function maskedAddressEnd(text: string, open: number): number {
  if (text[open] !== "(") return -1;
  let p = open + 1;
  let parts = 0;
  for (;;) {
    const ch = text[p];
    if (ch === undefined) return -1;
    if (ch === "(") {
      let q = p + 1;
      while (q < text.length && isAddressChar(text[q] ?? "")) q++;
      if (text[q] !== ")") break;
      p = q + 1;
    } else if (isAddressChar(ch)) {
      p++;
    } else {
      break;
    }
    parts++;
  }
  return parts > 0 && text[p] === ")" ? p + 1 : -1;
}

/**
 * Remove every `[text](url)` masked link, so its address spawns no embed. The
 * text holds no `]` or newline, the address no whitespace and at most one
 * level of parens.
 *
 * One pass, in linear time: every `[` before the same `]` shares that `]` and
 * the address after it, so when the first of them fails they all do and the
 * scan moves past the `]`.
 */
export function stripMaskedLinks(text: string): string {
  let out = "";
  let kept = 0;
  let i = text.indexOf("[");
  while (i !== -1) {
    let close = i + 1;
    while (close < text.length && text[close] !== "]" && text[close] !== "\n") close++;
    if (text[close] !== "]") {
      i = text.indexOf("[", close + 1);
      continue;
    }
    const end = close > i + 1 ? maskedAddressEnd(text, close + 1) : -1;
    if (end !== -1) {
      out += text.slice(kept, i);
      kept = end;
    }
    i = text.indexOf("[", end !== -1 ? end : close + 1);
  }
  return out + text.slice(kept);
}

/**
 * The index of the `||` that closes a spoiler whose content starts at
 * `from`, or -1 when the text ends first. A backslash escapes the next
 * character, so `\|` never closes.
 */
function spoilerCloseAt(text: string, from: number): number {
  let p = from;
  while (p < text.length) {
    if (text[p] === "\\") {
      if (p + 1 >= text.length) return -1;
      p += 2;
    } else if (text[p] === "|" && text[p + 1] === "|") {
      return p;
    } else {
      p++;
    }
  }
  return -1;
}

/**
 * Remove every `||hidden||` spoiler, so a hidden address spawns no embed.
 * Mirrors the tokeniser in `@lib/text/markdown`: the span closes at the first
 * `||` after its opener, holds at least one character (so `||||` is not a
 * spoiler), may span lines and blank lines (the tokeniser keeps an open
 * spoiler together across a paragraph break), a lone `|` is text, and a
 * backslash escape (`\|`) is content that never closes the span.
 *
 * One pass, in linear time: a later opener inside an unclosed span reads the
 * rest of the text the same way, so once one span runs to the end of the
 * text no later one can close and the scan stops.
 */
export function stripSpoilers(text: string): string {
  let out = "";
  let kept = 0;
  let i = text.indexOf("||");
  while (i !== -1) {
    if (text[i + 2] === "|") {
      i = text.indexOf("||", i + 1);
      continue;
    }
    const close = spoilerCloseAt(text, i + 2);
    if (close === -1) break;
    out += text.slice(kept, i);
    kept = close + 2;
    i = text.indexOf("||", kept);
  }
  return out + text.slice(kept);
}
/** `<https://…>` — a link its author asked to post without an embed. */
export const ANGLE_URL_REGEX = /(?<!(?:^|[^\\])\\(?:\\\\)*)<https?:\/\/[^\s<>]+>/gi;
/** `owncord://message/<channelId>/<messageId>` pasted into a message. */
export const MESSAGE_LINK_REGEX = /owncord:\/\/message\/\d+\/\d+/g;
/** `owncord://invite/<code>` (optionally `?host=…`) pasted into a message. */
export const INVITE_LINK_REGEX = /owncord:\/\/invite\/[\w%-]+(?:\?host=[\w.:%[\]-]*[\w%\]-])?/g;

/**
 * Strip trailing punctuation that is likely sentence-level, not part of the
 * URL — e.g. the period after "https://example.com." in "Check this out.".
 *
 * Gives back one trailing ")" if it balances an unmatched "(" earlier in the
 * URL, since `https://en.wikipedia.org/wiki/Rust_(programming_language)` is a
 * real address, not prose wrapped in parens.
 *
 * This is the single source of truth for "what counts as part of the URL vs.
 * surrounding prose" — every consumer of a raw URL_REGEX match (linkifying
 * anchors, extracting URLs for the embed pipeline) must strip through this
 * function so they agree on the same URL.
 */
export function stripUrlTrailingPunctuation(rawUrl: string): string {
  let stripped = rawUrl.replace(/[.,;:!?)]+$/, "");
  if (rawUrl.length > stripped.length && rawUrl[stripped.length] === ")") {
    const opens = (stripped.match(/\(/g) ?? []).length;
    const closes = (stripped.match(/\)/g) ?? []).length;
    if (opens > closes) stripped = stripped + ")";
  }
  return stripped || rawUrl; // fallback if stripping emptied it
}
