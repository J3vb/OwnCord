/**
 * Unicode emoji as Twemoji images, the way Discord shows them, instead of the
 * operating system's emoji font (Segoe UI Emoji is slow to draw in bulk and
 * looks different on every system).
 *
 * The SVGs ship with the app (vite.config.ts, `twemojiAssets`), so nothing is
 * fetched from the internet. Each image carries the emoji itself as its alt
 * text: a copied message gives the emoji back and a screen reader reads it. An
 * emoji with no image (newer than the set) falls back to the font text it
 * would have been anyway.
 *
 * Twemoji graphics: Copyright Twitter, Inc. and other contributors, CC-BY 4.0.
 */

import { createElement } from "@lib/dom";
import { buildCustomEmojiNode, UNICODE_EMOJI_PATTERN } from "./customEmoji";

/** Where the SVGs are served; the version matches the installed package (emojiImage.test.ts). */
export const TWEMOJI_BASE = "/assets/twemoji/17.0.3/";

/** Every unicode emoji in a run of text. */
export const UNICODE_EMOJI_REGEX = new RegExp(UNICODE_EMOJI_PATTERN, "gu");

/**
 * Whether a matched emoji is drawn as an emoji rather than as a text symbol:
 * ©, ™ or ↔ typed without U+FE0F are text, the same as in Discord.
 */
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}|️|⃣|‍|[\u{1F3FB}-\u{1F3FF}]/u;

export function showsAsImage(emoji: string): boolean {
  return EMOJI_PRESENTATION.test(emoji);
}

/** The image's file name: code points in hex joined by "-", without U+FE0F
 *  (mirrors scripts/twemoji-names.mjs, which names the shipped files). */
export function twemojiName(emoji: string): string {
  const points: string[] = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp !== 0xfe0f) points.push(cp.toString(16));
  }
  return points.join("-");
}

/** The inline image for one unicode emoji; on a missing file it turns back into text. */
export function buildEmojiImage(emoji: string): HTMLImageElement {
  const img = createElement("img", {
    class: "emoji-img",
    alt: emoji,
    draggable: "false",
    decoding: "async",
    src: `${TWEMOJI_BASE}${twemojiName(emoji)}.svg`,
  });
  img.addEventListener("error", () => img.replaceWith(document.createTextNode(emoji)), {
    once: true,
  });
  return img;
}

/**
 * The node for an emoji as a reaction, poll option or quick reaction stores
 * it: a custom `:shortcode:` image, a Twemoji image, or plain text.
 */
export function buildEmojiNode(emoji: string): Node {
  const custom = buildCustomEmojiNode(emoji);
  if (custom !== null) return custom;
  return showsAsImage(emoji) ? buildEmojiImage(emoji) : document.createTextNode(emoji);
}
