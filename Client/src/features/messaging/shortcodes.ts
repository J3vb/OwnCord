/**
 * Typed `:joy:` shortcodes become their Unicode emoji when a message is sent,
 * as in Discord. A server's own custom emoji keep their `:name:` text (that
 * is how they render), code spans and blocks are left as written, and so is a
 * shortcode escaped with a backslash. Before the emoji set has loaded, the
 * text is sent as typed.
 */
import { resolveEmoji } from "@stores/emoji.store";
import { emojiCatalog, emojiForShortcode, skinTone, withSkinTone } from "./emojiCatalog";

const CODE = /(```[\s\S]*?```|`[^`\n]+`)/;
const SHORTCODE = /(?<!\\):([A-Za-z0-9_+-]{2,32}):/g;

export function replaceEmojiShortcodes(content: string): string {
  if (emojiCatalog() === null || !content.includes(":")) return content;
  const tone = skinTone();
  return content
    .split(CODE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(SHORTCODE, (whole, name: string) => {
            if (resolveEmoji(name) !== null) return whole;
            const e = emojiForShortcode(name);
            return e === null ? whole : withSkinTone(e, tone);
          }),
    )
    .join("");
}
