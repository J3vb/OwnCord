/**
 * Custom-emoji tokens in message content.
 *
 * `:shortcode:` renders as an inline image when the server knows that
 * shortcode and as the literal text it was typed as when it does not — the
 * same rule @mentions follow, and the reason a message full of colons never
 * turns into a wall of broken images.
 *
 * The image itself is behind the session token (GET /api/v1/emoji/{id}/image
 * is authenticated), so it is fetched through the same cert-pinned,
 * bearer-token path attachments use and swapped in as a data: URI. Assigning
 * the server URL straight to `img.src` would 401.
 */

import { createElement } from "@lib/dom";
import { resolveEmoji, type CustomEmoji } from "@stores/emoji.store";
import { fetchImageAsDataUrl, resolveServerUrl } from "./attachments";

/**
 * A `:shortcode:` token. Case-insensitive on the way in (the store lowercases
 * before lookup) so `:WAVE:` finds the same emoji `:wave:` does; the length
 * bounds mirror the server's validator, so a token this matches is one the
 * server could actually have stored.
 */
export const EMOJI_TOKEN_REGEX = /:([A-Za-z0-9_]{2,32}):/g;

/**
 * How many emoji a message may hold and still render jumbo. Discord's number.
 * Past it the message is a picture wall, not an expression, and 48px each
 * would push the rest of the channel off screen.
 */
export const MAX_JUMBO_EMOJI = 27;

/** One unicode emoji, including skin tones, ZWJ sequences, flags and keycaps. */
const UNICODE_EMOJI = new RegExp(
  "^(?:" +
    // Keycap: digit/#/* + optional VS16 + the combining enclosing keycap.
    "[0-9#*]\\uFE0F?\\u{20E3}" +
    "|" +
    // Regional-indicator pair (flags) or any pictographic base.
    "(?:[\\u{1F1E6}-\\u{1F1FF}]|\\p{Extended_Pictographic})" +
    // Modifiers, variation selectors and ZWJ-joined continuations.
    "(?:\\uFE0F|\\u{20E3}|[\\u{1F3FB}-\\u{1F3FF}]|\\u200D(?:[\\u{1F1E6}-\\u{1F1FF}]|\\p{Extended_Pictographic})(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])*)*" +
    ")",
  "u",
);

/** A single `:shortcode:` anchored at the start of the remaining text. */
const LEADING_EMOJI_TOKEN = /^:([A-Za-z0-9_]{2,32}):/;

/**
 * Whether a message is nothing but emoji, which is what earns the jumbo size.
 *
 * "Nothing but" is literal: whitespace, unicode emoji, and `:shortcodes:` that
 * actually resolve. An unresolved shortcode is plain text, so `:nosuch:` alone
 * is a normal message — sizing it jumbo would promise an image that is never
 * going to appear.
 */
export function isEmojiOnlyMessage(content: string): boolean {
  let rest = content.trim();
  if (rest === "") return false;

  let count = 0;
  while (rest.length > 0) {
    const ws = /^\s+/.exec(rest);
    if (ws !== null) {
      rest = rest.slice(ws[0].length);
      continue;
    }
    const token = LEADING_EMOJI_TOKEN.exec(rest);
    if (token !== null && resolveEmoji(token[1] ?? "") !== null) {
      count++;
      rest = rest.slice(token[0].length);
      continue;
    }
    const unicode = UNICODE_EMOJI.exec(rest);
    if (unicode !== null && unicode[0].length > 0) {
      count++;
      rest = rest.slice(unicode[0].length);
      continue;
    }
    return false;
  }
  return count > 0 && count <= MAX_JUMBO_EMOJI;
}

/**
 * The inline image for one custom emoji. The element is returned immediately
 * with no `src`; the bytes arrive asynchronously and are swapped in when they
 * do. Until then (and forever, if the fetch fails) the `alt` text is the
 * shortcode, so the message still reads correctly.
 */
export function buildCustomEmojiImage(emoji: CustomEmoji): HTMLImageElement {
  const img = createElement("img", {
    class: "custom-emoji",
    alt: `:${emoji.shortcode}:`,
    title: `:${emoji.shortcode}:`,
    "data-shortcode": emoji.shortcode,
    draggable: "false",
  });
  void fetchImageAsDataUrl(resolveServerUrl(emoji.url)).then((dataUrl) => {
    if (dataUrl !== null) img.src = dataUrl;
  });
  return img;
}

/**
 * The image node for `token` (with or without colons), or null when no such
 * emoji exists — the caller leaves an unresolved token as plain text.
 */
export function buildCustomEmojiNode(token: string): HTMLImageElement | null {
  const emoji = resolveEmoji(token);
  return emoji === null ? null : buildCustomEmojiImage(emoji);
}
