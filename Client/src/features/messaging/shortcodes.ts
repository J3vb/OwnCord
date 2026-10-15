/**
 * Typed `:joy:` shortcodes become their Unicode emoji when a message is sent,
 * as in Discord. Only a lowercase shortcode standing on its own is swapped: a
 * colon pair inside a word, a number or an address (`a:joy:b`, `00:1A:2B`,
 * `status:OK:done`) stays as typed, and so do code, links, a server's own
 * custom emoji (that is how they render) and a shortcode escaped with a
 * backslash. Before the emoji set has loaded, the text is sent as typed.
 */
import { resolveEmoji } from "@stores/emoji.store";
import { emojiCatalog, emojiForShortcode, skinTone, withSkinTone } from "./emojiCatalog";

/** Parts never touched: code, `<https://…>`, masked links and bare URLs. */
const PROTECTED =
  /(```[\s\S]*?```|`[^`]+`|<https?:\/\/[^\s<>]+>|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>"']+)/;
/** A shortcode with no letter, digit, `_` or backslash right before or after it. */
const SHORTCODE = /(?<![\\\p{L}\p{N}_]):([a-z0-9_+-]{2,32}):(?![\p{L}\p{N}_])/gu;

function replaceInProse(prose: string, tone: number): string {
  // A colon right before a shortcode only counts as a boundary when it closed
  // the previous one (`:joy::joy:`), never in `fe80::ab:cd`.
  let lastEnd = -1;
  return prose.replace(SHORTCODE, (whole, name: string, offset: number) => {
    const end = offset + whole.length;
    if (offset > 0 && prose[offset - 1] === ":" && offset !== lastEnd) return whole;
    if (resolveEmoji(name) !== null) return whole;
    const e = emojiForShortcode(name);
    if (e === null) return whole;
    lastEnd = end;
    return withSkinTone(e, tone);
  });
}

export function replaceEmojiShortcodes(content: string): string {
  if (emojiCatalog() === null || !content.includes(":")) return content;
  const tone = skinTone();
  return content
    .split(PROTECTED)
    .map((part, i) => (i % 2 === 1 ? part : replaceInProse(part, tone)))
    .join("");
}
