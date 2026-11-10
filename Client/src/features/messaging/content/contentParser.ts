/**
 * Text content parsing — XSS-safe DOM builders for message text.
 *
 * This is the *only* renderer for message content: Discord-flavoured markdown
 * (inline styles, spoilers, quotes, headings, lists, masked links, fenced code
 * with language tags), plus @mentions, #channel links and URL linkification.
 *
 * Everything here builds DOM nodes — never innerHTML — and every href is
 * checked with isSafeUrl before it reaches an anchor.
 *
 * This file is the facade; the pieces live beside it: contentRegex (shared
 * patterns), contentInline, contentMentions, contentLinkChips, contentParse
 * (parsed form and its cache) and contentBlocks.
 */

import type { MentionInfo } from "@lib/text/mentions";
import { formatDiscordTimestamp, type TimestampStyle } from "@lib/text/discordTimestamp";
import { createElement } from "@lib/dom";
import { isEmojiOnlyMessage } from "./customEmoji";
import { renderParsedBlocks, renderParsedCodeBlock } from "./contentBlocks";
import { parsedFor } from "./contentParse";

export {
  CODE_BLOCK_REGEX,
  INLINE_CODE_REGEX,
  URL_REGEX,
  MASKED_LINK_REGEX,
  SPOILER_REGEX,
  ANGLE_URL_REGEX,
  stripUrlTrailingPunctuation,
} from "./contentRegex";
export { renderInlineContent, renderMentions } from "./contentInline";
export { renderMentionSegment, resyncMentions } from "./contentMentions";
export { clearContentParseCache } from "./contentParse";
export type { MentionInfo };

/**
 * Render message content to DOM.
 *
 * `cacheKey` (the message id plus its editedAt) opts into the parse cache: an
 * unchanged key reuses the parse and only rebuilds DOM, an edit changes the key
 * and re-parses. Omitted, every call parses afresh (the behaviour callers that
 * render ad-hoc strings rely on).
 */
export function renderMessageContent(
  content: string,
  info?: MentionInfo,
  cacheKey?: string,
): DocumentFragment {
  const parsed = parsedFor(content, cacheKey);
  const fragment = document.createDocumentFragment();
  const jumboClass = isEmojiOnlyMessage(content) ? "msg-text msg-text-jumbo" : "msg-text";

  for (const segment of parsed.segments) {
    if (segment.kind === "code") {
      fragment.appendChild(renderParsedCodeBlock(segment));
      continue;
    }
    const text = createElement("div", { class: jumboClass });
    renderParsedBlocks(text, segment.blocks, info);
    fragment.appendChild(text);
  }

  return fragment;
}

/**
 * Rewrite the `<t:…>` timestamps under `root` in the current clock preference
 * and relative to now, for a 12h/24h switch or a passing midnight.
 */
export function relabelInlineTimestamps(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLTimeElement>("time.md-timestamp")) {
    const ms = Date.parse(el.dateTime);
    if (Number.isNaN(ms)) continue;
    const style = (el.dataset["style"] ?? "f") as TimestampStyle;
    const { text, title } = formatDiscordTimestamp(ms / 1000, style);
    el.textContent = text;
    el.title = title;
  }
}
