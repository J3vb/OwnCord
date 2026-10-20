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

import { loadPref, savePref } from "@lib/preferences";
import { registerSessionReset } from "@lib/sessionRegistry";
import type { ImageSize } from "@lib/imageHeader";

/** Ceiling for an inline image box, in CSS px. */
const BOX_MAX_W = 400;
const BOX_MAX_H = 350;

/** The reserved box of one image: its scaled width and height in px. */
export interface ImageBox {
  readonly w: number;
  readonly h: number;
}

/** Scale an intrinsic size to fit the inline ceiling, keeping the ratio.
 *  Null for a size that is zero, negative or not finite. */
export function fitImageBox(width: number, height: number): ImageBox | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  const scale = Math.min(1, BOX_MAX_W / width, BOX_MAX_H / height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

// -- Per-URL box cache --------------------------------------------------------

const MAX_BOXES = 500;
/** Pref key (stored under the shared settings prefix by `savePref`). */
const STORAGE_KEY = "imageBoxes";
/** Writes are batched: a scroll can load dozens of images in a second. */
const PERSIST_DELAY_MS = 1000;

function isBoxEntry(v: unknown): v is [string, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === "string" &&
    Number.isSafeInteger(v[1]) &&
    Number.isSafeInteger(v[2]) &&
    v[1] > 0 &&
    v[2] > 0
  );
}

export interface ImageBoxStore {
  get(url: string): ImageBox | undefined;
  set(url: string, box: ImageBox): void;
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
        if (isBoxEntry(entry)) stored.set(entry[0], { w: entry[1], h: entry[2] });
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
    savePref(
      STORAGE_KEY,
      [...boxes].map(([url, box]) => [url, box.w, box.h]),
    );
  };

  return {
    get(url) {
      hydrate();
      return boxes.get(url);
    },
    /** A repeat of the stored value writes nothing, so two rows of one URL
     *  never write twice. The oldest entry goes past 500. */
    set(url, box) {
      hydrate();
      const known = boxes.get(url);
      if (known !== undefined && known.w === box.w && known.h === box.h) return;
      boxes.delete(url);
      if (boxes.size >= MAX_BOXES) {
        const oldest = boxes.keys().next().value;
        if (oldest !== undefined) boxes.delete(oldest);
      }
      boxes.set(url, box);
      persistTimer ??= setTimeout(persist, PERSIST_DELAY_MS);
    },
    clear() {
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

/** Remember `url`'s box (batched write to storage). */
export function setImageBox(url: string, box: ImageBox): void {
  boxStore.set(url, box);
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
