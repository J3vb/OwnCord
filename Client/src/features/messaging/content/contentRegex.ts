/**
 * The regex constants every message-content renderer shares, and the one rule
 * for what counts as part of a bare URL. A leaf: it imports nothing.
 */

export const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
export const INLINE_CODE_REGEX = /`([^`]+)`/g;
export const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
/** `[text](url)` — used to keep masked links from spawning link embeds. */
export const MASKED_LINK_REGEX = /\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\)/g;
/**
 * `||hidden||` — used to keep spoilered URLs from spawning embeds. Mirrors
 * the tokeniser in `@lib/text/markdown`: the span closes at the first `||` after
 * its opener, holds at least one character (so `||||` is not a spoiler), may
 * span lines and blank lines (the tokeniser keeps an open spoiler together
 * across a paragraph break), a lone `|` is text, and a backslash escape
 * (`\|`) is content that never closes the span.
 */
export const SPOILER_REGEX = /\|\|(?!\|)(?:\\[\s\S]|(?!\|\|)[^\\])+\|\|/g;
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
