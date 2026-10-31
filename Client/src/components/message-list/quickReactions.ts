/**
 * The emoji offered for one-tap reactions (the message menu now, the hover bar
 * in 3A-7). Its own module so the message menu's lazy chunk carries it instead
 * of the main-page chunk.
 */

import { getRecentEmoji } from "../emojiRecent";
import { buildCustomEmojiNode } from "../../features/messaging/content/customEmoji";

/** How many quick-reaction emoji the message menu and the hover bar each show. */
export const QUICK_REACTIONS = 3;

/** Fixed picks that pad the quick row when fewer than `n` recents exist. The
 *  fourth only shows on the phone sheet, which has room for one more. */
const DEFAULT_QUICK_EMOJI = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F440}"] as const;

/**
 * The `n` emoji for a one-tap reaction: the most recent picks that still
 * resolve on this server, padded with the fixed defaults, never repeating one.
 */
export function quickReactionEmoji(n: number): string[] {
  const picks = getRecentEmoji();
  for (const emoji of DEFAULT_QUICK_EMOJI) if (!picks.includes(emoji)) picks.push(emoji);
  return picks.slice(0, n);
}

let passCache: string[] | null = null;

/**
 * The same picks, computed once per render pass: the rows of one pass are drawn
 * synchronously, so they share one read of the recents and cannot disagree. The
 * cache drops at the next microtask, so a later pass sees a new pick.
 */
export function quickReactionEmojiForPass(n: number): string[] {
  if (passCache === null || passCache.length !== n) {
    passCache = quickReactionEmoji(n);
    queueMicrotask(() => {
      passCache = null;
    });
  }
  return passCache;
}

/** The glyph (or custom-emoji image) for a quick reaction, and its accessible name. */
export function emojiNode(emoji: string): { node: Node; name: string } {
  const node = buildCustomEmojiNode(emoji);
  return { node: node ?? document.createTextNode(emoji), name: emoji };
}
