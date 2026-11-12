/**
 * Unicode emoji as Twemoji images, the way Discord shows them, instead of the
 * operating system's emoji font (Segoe UI Emoji is slow to draw in bulk and
 * looks different on every system).
 *
 * The SVGs ship with the app, packed into a few JSON files of neighbouring
 * names (vite.config.ts, `twemojiAssets`), so nothing is fetched from the
 * internet. An image waits for its pack, then shows from a local blob URL;
 * every later use of the same emoji gets that URL at once. Each image carries the emoji itself as its alt
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

type Pack = Readonly<Record<string, string>>;

let packStarts: Promise<readonly string[] | null> | null = null;
const packs = new Map<number, Promise<Pack | null>>();
const svgUrls = new Map<string, string>();

async function fetchJson<T>(file: string): Promise<T | null> {
  try {
    const res = await fetch(`${TWEMOJI_BASE}${file}`);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** One cached load per key; a failed load is forgotten so the next use retries. */
function loadOnce<T>(
  cache: Map<number, Promise<T | null>>,
  key: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const loading = load().then((value) => {
    if (value === null) cache.delete(key);
    return value;
  });
  cache.set(key, loading);
  return loading;
}

function starts(): Promise<readonly string[] | null> {
  packStarts ??= fetchJson<string[]>("index.json").then((list) => {
    if (list === null) packStarts = null;
    return list;
  });
  return packStarts;
}

/** The pack holding `name`: the last pack whose first name sorts at or before it. */
export function packIndex(packFirstNames: readonly string[], name: string): number {
  let index = 0;
  packFirstNames.forEach((first, i) => {
    if (first <= name) index = i;
  });
  return index;
}

/** The SVG text of a Twemoji image by its file name, or null when there is none. */
export async function twemojiSvg(name: string): Promise<string | null> {
  const list = await starts();
  if (list === null) return null;
  const i = packIndex(list, name);
  const pack = await loadOnce(packs, i, () => fetchJson<Pack>(`pack-${i}.json`));
  return pack?.[name] ?? null;
}

/** A local URL for a Twemoji image by its file name, or null when there is none. */
export async function twemojiUrl(name: string): Promise<string | null> {
  const ready = svgUrls.get(name);
  if (ready !== undefined) return ready;
  const svg = await twemojiSvg(name);
  if (svg === null) return null;
  const url = svgUrls.get(name) ?? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  svgUrls.set(name, url);
  return url;
}

/** The inline image for one unicode emoji; with no image it turns back into text. */
export function buildEmojiImage(emoji: string): HTMLImageElement {
  const img = createElement("img", {
    class: "emoji-img",
    alt: emoji,
    draggable: "false",
    decoding: "async",
  });
  const toText = (): void => img.replaceWith(document.createTextNode(emoji));
  img.addEventListener("error", toText, { once: true });
  const name = twemojiName(emoji);
  const ready = svgUrls.get(name);
  if (ready !== undefined) {
    img.src = ready;
    return img;
  }
  void twemojiUrl(name).then((url) => {
    if (url === null) toText();
    else img.src = url;
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
