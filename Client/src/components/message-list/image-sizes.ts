/**
 * Known image boxes, so a row reserves the right space before any bytes load.
 *
 * Three small stores, all leaf state (no DOM, no sibling renderer imports):
 *  - a per-URL box cache, persisted to localStorage so a revisit (or a restart)
 *    reserves the correct box before the fetch. Per-viewer convenience only:
 *    the in-memory map is the source of truth and the list works without
 *    storage;
 *  - a per-blob-URL size, filled by the fetchers after a header sniff, so the
 *    renderer that receives a `blob:` URL knows the intrinsic size without
 *    reading the file again;
 *  - the box maths shared with server attachments (400x350 ceiling).
 */

import { loadPref, savePref } from "@lib/prefs/preferences";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import type { ImageSize } from "@lib/ui/imageHeader";

/** Ceiling for an inline image box, in CSS px. */
const BOX_MAX_W = 400;
const BOX_MAX_H = 350;

/** The reserved box of one image: its scaled width and height in px.
 *  `measured` marks a box taken from the decoded image (naturalWidth/Height),
 *  which the browser has already oriented; a box without it came from a header
 *  sniff, which cannot see an EXIF rotation, and never replaces a measured one. */
export interface ImageBox {
  readonly w: number;
  readonly h: number;
  readonly measured?: boolean;
}

/** A URL longer than this is not cached or persisted (tracking-laden links). */
const MAX_URL_LENGTH = 1024;
/** Serialized size the persisted copy may reach; the oldest entries go first. */
const MAX_PERSISTED_BYTES = 96 * 1024;

/** A box that fits the inline ceiling and is made of whole, positive pixels. */
function withinCeiling(w: number, h: number): boolean {
  return (
    Number.isSafeInteger(w) &&
    Number.isSafeInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= BOX_MAX_W &&
    h <= BOX_MAX_H
  );
}

/** A server attachment's picture is capped at 300 px tall (`.msg-image img`
 *  in messages.css), under the 350 px an inline URL image may reach. */
export const ATTACHMENT_BOX_MAX_H = 300;

/** Scale an intrinsic size to fit the inline ceiling, keeping the ratio.
 *  Null for a size that is zero, negative or not finite. */
export function fitImageBox(
  width: number,
  height: number,
  maxHeight: number = BOX_MAX_H,
): ImageBox | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  const scale = Math.min(1, BOX_MAX_W / width, maxHeight / height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

// -- Per-URL box cache --------------------------------------------------------

const MAX_BOXES = 500;
/** Pref key (stored under the shared settings prefix by `savePref`). */
const STORAGE_KEY = "imageBoxes";
/** Writes are batched: a scroll can load dozens of images in a second, and
 *  every `savePref` also notifies the pref-change listeners, so wait longer. */
const PERSIST_DELAY_MS = 3000;

/** A stored entry is `[url, w, h]` or `[url, w, h, 1]` (measured). Anything
 *  outside the ceiling is dropped, so a tampered store cannot reserve more. */
function parseEntry(v: unknown): [string, ImageBox] | null {
  if (!Array.isArray(v) || (v.length !== 3 && v.length !== 4)) return null;
  const [url, w, h, measured] = v as unknown[];
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
  if (typeof w !== "number" || typeof h !== "number" || !withinCeiling(w, h)) return null;
  const box = fitImageBox(w, h);
  if (box === null || box.w !== w || box.h !== h) return null;
  return [url, measured === 1 ? { w, h, measured: true } : { w, h }];
}

export interface ImageBoxStore {
  get(url: string): ImageBox | undefined;
  /** Remember `box` and return the box the cache now holds for `url`: a sniffed
   *  box never replaces a measured one, so the winner may be the older entry. */
  set(url: string, box: ImageBox): ImageBox | undefined;
  /** Bumps on every clear; a late load compares it to the one it started under. */
  generation(): number;
  clear(): void;
}

/** One box cache over the shared storage key. The module keeps a single
 *  instance; the factory exists so a test can start a "new page load". */
export function createImageBoxStore(): ImageBoxStore {
  const boxes = new Map<string, ImageBox>();
  let hydrated = false;
  /** Whether storage may hold entries that a clear has to remove. */
  let persisted = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  /** Load the persisted boxes once. Entries already in memory win: they are newer. */
  const hydrate = (): void => {
    if (hydrated) return;
    hydrated = true;
    try {
      const parsed: unknown = loadPref<unknown[]>(STORAGE_KEY, []);
      if (!Array.isArray(parsed)) return;
      persisted = parsed.length > 0;
      const stored = new Map<string, ImageBox>();
      for (const entry of parsed.slice(-MAX_BOXES)) {
        const parsedEntry = parseEntry(entry);
        if (parsedEntry !== null) stored.set(parsedEntry[0], parsedEntry[1]);
      }
      for (const [url, box] of boxes) stored.set(url, box);
      boxes.clear();
      for (const [url, box] of stored) boxes.set(url, box);
    } catch {
      // Unavailable or corrupt storage reads as an empty cache.
    }
  };

  const persist = (): void => {
    persistTimer = null;
    persisted = true;
    // savePref swallows a full or unavailable store: the in-memory cache still
    // serves this session.
    const rows = [...boxes].map(([url, box]) =>
      box.measured === true ? [url, box.w, box.h, 1] : [url, box.w, box.h],
    );
    // Oldest first, so trim from the front until the serialized copy fits.
    let size = JSON.stringify(rows).length;
    let drop = 0;
    while (size > MAX_PERSISTED_BYTES && drop < rows.length) {
      size -= JSON.stringify(rows[drop]).length + 1;
      drop++;
    }
    savePref(STORAGE_KEY, rows.slice(drop));
  };

  return {
    get(url) {
      hydrate();
      return boxes.get(url);
    },
    /** A repeat of the stored value writes nothing, so two rows of one URL
     *  never write twice. The oldest entry goes past 500. */
    set(url, box) {
      if (url.length > MAX_URL_LENGTH || !withinCeiling(box.w, box.h)) return boxes.get(url);
      hydrate();
      const known = boxes.get(url);
      if (known?.measured === true && box.measured !== true) return known;
      if (
        known !== undefined &&
        known.w === box.w &&
        known.h === box.h &&
        (known.measured === true) === (box.measured === true)
      ) {
        return known;
      }
      boxes.delete(url);
      if (boxes.size >= MAX_BOXES) {
        const oldest = boxes.keys().next().value;
        if (oldest !== undefined) boxes.delete(oldest);
      }
      const stored: ImageBox =
        box.measured === true ? { w: box.w, h: box.h, measured: true } : { w: box.w, h: box.h };
      boxes.set(url, stored);
      persistTimer ??= setTimeout(persist, PERSIST_DELAY_MS);
      return stored;
    },
    generation() {
      return generation;
    },
    clear() {
      generation++;
      const wasHydrated = hydrated;
      boxes.clear();
      hydrated = true; // the empty list written below is all storage holds now
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (persisted || !wasHydrated) {
        persisted = false;
        savePref(STORAGE_KEY, []);
      }
    },
  };
}

const boxStore = createImageBoxStore();

/** The box remembered for `url`, from this session or an earlier one. */
export function getImageBox(url: string): ImageBox | undefined {
  return boxStore.get(url);
}

/** The scaled height remembered for `url` (the list's estimate), if any. */
export function knownImageHeight(url: string): number | undefined {
  return boxStore.get(url)?.h;
}

/** Remember `url`'s box (batched write to storage); returns the box the cache
 *  holds afterwards. `generation` is the value of `imageSizeGeneration()` taken
 *  when the row was rendered: after a session reset it no longer matches and
 *  nothing is stored, so a late load cannot persist an old session's URL. */
export function setImageBox(url: string, box: ImageBox, generation?: number): ImageBox | undefined {
  if (generation !== undefined && generation !== boxStore.generation()) return undefined;
  return boxStore.set(url, box);
}

/** The reset counter of the box cache; capture it at render, pass it to `setImageBox`. */
export function imageSizeGeneration(): number {
  return boxStore.generation();
}

// -- Intrinsic sizes by blob URL ----------------------------------------------

const MAX_BLOB_SIZES = 400;
const blobSizes = new Map<string, ImageSize>();

/** Record the header-sniffed size of the image behind `objectUrl`. */
export function rememberBlobSize(objectUrl: string, size: ImageSize | null): void {
  if (size === null) return;
  if (blobSizes.size >= MAX_BLOB_SIZES) {
    const oldest = blobSizes.keys().next().value;
    if (oldest !== undefined) blobSizes.delete(oldest);
  }
  blobSizes.set(objectUrl, size);
}

/** The sniffed intrinsic size of the image behind `objectUrl`, if one was read. */
export function blobImageSize(objectUrl: string): ImageSize | undefined {
  return blobSizes.get(objectUrl);
}

/** Drop every remembered size and the persisted copy (session reset, consent
 *  revoked, the manual cache clear). */
export function clearImageSizes(): void {
  boxStore.clear();
  blobSizes.clear();
}
void registerSessionReset("message-list:image-sizes", clearImageSizes, { phase: "cache" }); // app-lifetime
