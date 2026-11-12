/**
 * Skin-tone sheets for the emoji picker, drawn in the app instead of shipped:
 * five tones of the People group would double the installer's emoji weight
 * for a choice most people make once. The first time a toned group is shown
 * its cells use single Twemoji images while the sheet is drawn in the
 * background, a few emoji per task; the result is kept in the browser cache
 * under the Twemoji version and catalog hash, so a later open, or a later
 * start of the app, gets the sheet at once.
 */

import { TWEMOJI_BASE, twemojiName, twemojiUrl } from "./content/emojiImage";
import { SHEET_COLUMNS, sheetUrl } from "./emojiSheets";
import { SHEETS_CATALOG_HASH } from "./emojiSheetsData";

/** Cell size in px, the same as the shipped sheets. */
const CELL = 48;
const BATCH = 8;
const QUALITY = 0.8;
const CACHE_NAME = "owncord-emoji-sheets";

const drawn = new Map<string, string>();
const drawing = new Set<string>();

function cacheKey(key: string): string {
  return new URL(`${TWEMOJI_BASE}tone-sheets/${SHEETS_CATALOG_HASH}/${key}`, location.href).href;
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function fromCache(cache: Cache | null, url: string): Promise<Blob | null> {
  try {
    const hit = await cache?.match(url);
    return hit === undefined ? null : await hit.blob();
  } catch {
    return null;
  }
}

/** Store `blob` and drop sheets of other versions or catalogs. */
async function toCache(cache: Cache | null, url: string, blob: Blob): Promise<void> {
  if (cache === null) return;
  try {
    await cache.put(url, new Response(blob, { headers: { "Content-Type": blob.type } }));
    const current = url.slice(0, url.lastIndexOf("/") + 1);
    const stale = (await cache.keys()).filter((req) => !req.url.startsWith(current));
    await Promise.all(stale.map((req) => cache.delete(req)));
  } catch {
    // A full or unavailable cache only means drawing the sheet again next time.
  }
}

async function loadImage(name: string): Promise<HTMLImageElement | null> {
  const url = await twemojiUrl(name);
  if (url === null) return null;
  const img = new Image(CELL, CELL);
  img.src = url;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", QUALITY));
}

/** Draw `emoji` into a sheet, or null when any image is missing or there is no canvas. */
export async function drawSheet(emoji: readonly string[]): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_COLUMNS * CELL;
  canvas.height = Math.ceil(emoji.length / SHEET_COLUMNS) * CELL;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const draw = (images: readonly (HTMLImageElement | null)[], start: number): boolean => {
    images.forEach((img, j) => {
      const i = start + j;
      if (img !== null) {
        ctx.drawImage(
          img,
          (i % SHEET_COLUMNS) * CELL,
          Math.floor(i / SHEET_COLUMNS) * CELL,
          CELL,
          CELL,
        );
      }
    });
    return !images.includes(null);
  };
  // One batch at a time, so drawing never holds the page for long.
  let complete: Promise<boolean> = Promise.resolve(true);
  for (let start = 0; start < emoji.length; start += BATCH) {
    const batch = emoji.slice(start, start + BATCH);
    complete = complete.then(async (ok) =>
      ok ? draw(await Promise.all(batch.map((e) => loadImage(twemojiName(e)))), start) : false,
    );
  }
  if (!(await complete)) return null;
  return toBlob(canvas);
}

async function prepare(key: string, emoji: readonly string[]): Promise<string | null> {
  const cache = await openCache();
  const url = cacheKey(key);
  const cached = await fromCache(cache, url);
  if (cached !== null) return URL.createObjectURL(cached);
  const blob = await drawSheet(emoji);
  if (blob === null) return null;
  await toCache(cache, url, blob);
  return URL.createObjectURL(blob);
}

/**
 * The sheet for a toned group (`key` is `<group>-<tone>`, `emoji` its toned
 * emoji in catalog order) when it is ready, else null; the first call starts
 * loading or drawing it.
 */
export function toneSheetUrl(key: string, emoji: readonly string[]): string | null {
  const ready = drawn.get(key);
  if (ready !== undefined) return ready;
  if (!drawing.has(key)) {
    drawing.add(key);
    void prepare(key, emoji)
      .catch(() => null)
      .then((url) => {
        drawing.delete(key);
        if (url !== null) drawn.set(key, url);
      });
  }
  return null;
}

/**
 * The sheet for a catalog group in skin `tone`: the shipped one when no emoji
 * in it takes a tone, else the drawn tone sheet (null until ready). `toned`
 * is the group's emoji in that tone, in catalog order.
 */
export function groupSheetUrl(
  group: string,
  tone: number,
  base: readonly { readonly tone: string }[],
  toned: readonly string[],
): string | null {
  const changed = tone !== 0 && base.some((e) => e.tone !== "");
  return changed ? toneSheetUrl(`${group}-${tone}`, toned) : sheetUrl(group);
}
