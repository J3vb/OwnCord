/**
 * The emoji offered for one-tap reactions (the message menu now, the hover bar
 * in 3A-7). Its own module so the message menu's lazy chunk carries it instead
 * of the main-page chunk.
 */

import { getRecentEmoji } from "../EmojiPicker";
import { buildCustomEmojiNode } from "./custom-emoji";

/** How many quick-reaction emoji the message menu and the hover bar each show. */
export const QUICK_REACTIONS = 3;

/** Fixed picks that pad the quick row when fewer than `n` recents exist. */
const DEFAULT_QUICK_EMOJI = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}"] as const;

/**
 * The `n` emoji for a one-tap reaction: the most recent picks that still
 * resolve on this server, padded with the fixed defaults, never repeating one.
 */
export function quickReactionEmoji(n: number): string[] {
  const picks = getRecentEmoji();
  for (const emoji of DEFAULT_QUICK_EMOJI) if (!picks.includes(emoji)) picks.push(emoji);
  return picks.slice(0, n);
}

/** The glyph (or custom-emoji image) for a quick reaction, and its accessible name. */
export function emojiNode(emoji: string): { node: Node; name: string } {
  const node = buildCustomEmojiNode(emoji);
  return { node: node ?? document.createTextNode(emoji), name: emoji };
}
