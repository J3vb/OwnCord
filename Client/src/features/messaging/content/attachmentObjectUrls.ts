/**
 * The object-URL primitives the attachment caches share: guarded blob: URL
 * creation and revocation, the byte-bounded LRU that owns the URLs, and the
 * generation counter a cache clear bumps so an in-flight fetch can tell its
 * session is gone.
 */

export function createObjectUrl(blob: Blob): string | null {
  // jsdom (and any non-browser host) may not implement the object-URL API.
  if (typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(blob);
}

export function revokeObjectUrl(objectUrl: string): void {
  if (typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(objectUrl);
}

/** The blob: URLs a mounted element still depends on: every connected visible
 *  `<img>` showing one, and every connected tracked GIF's animated source
 *  (`data-media-src`: its `<img>` shows the frozen still, but unfreezing needs
 *  the original). Read only when a
 *  cache is over its cap, so the scan costs nothing on a hit. */
export function liveBlobUrls(): Set<string> {
  const live = new Set<string>();
  if (typeof document === "undefined") return live;
  for (const img of document.querySelectorAll("img")) {
    // A hidden image (a failed or refused load) shows nothing, so it pins nothing.
    if (img.hidden) continue;
    for (const src of [img.getAttribute("src"), img.dataset["mediaSrc"]]) {
      if (src !== undefined && src !== null && src.startsWith("blob:")) live.add(src);
    }
  }
  return live;
}

/** blob: URLs by source URL, least recently used first, bounded by the bytes
 *  their Blobs pin (and optionally by count). An evicted URL is revoked; an
 *  image still showing it recovers through `recoverEvictedImage`. One entry
 *  larger than the budget stays until the next arrives. With `keepMounted`, a
 *  URL a mounted `<img>` still shows is never evicted (the cap then bounds the
 *  unreferenced part), so a window wider than the cache is not re-fetched. */
export class ObjectUrlCache {
  private readonly entries = new Map<
    string,
    { objectUrl: string; bytes: number; blob: Blob | undefined }
  >();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
    private readonly keepMounted = false,
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Map order is the recency order: a read moves the entry to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.objectUrl;
  }

  holds(objectUrl: string): boolean {
    return this.blobOf(objectUrl) !== null;
  }

  /** The Blob behind a held URL (undefined when it was not kept), or null
   *  when the URL is not held. */
  blobOf(objectUrl: string): Blob | undefined | null {
    for (const entry of this.entries.values()) {
      if (entry.objectUrl === objectUrl) return entry.blob;
    }
    return null;
  }

  set(key: string, objectUrl: string, bytes: number, blob?: Blob): void {
    this.drop(key);
    this.entries.set(key, { objectUrl, bytes, blob });
    this.bytes += bytes;
    if (!this.overCap()) return;
    const live = this.keepMounted ? liveBlobUrls() : null;
    for (const [oldKey, entry] of this.entries) {
      if (!this.overCap()) break;
      // The entry just added stays even when it alone is over.
      if (oldKey === key) continue;
      if (live?.has(entry.objectUrl) === true) continue;
      this.drop(oldKey);
    }
  }

  private overCap(): boolean {
    return (
      this.entries.size > 1 && (this.bytes > this.maxBytes || this.entries.size > this.maxEntries)
    );
  }

  clear(): void {
    for (const key of this.entries.keys()) this.drop(key);
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    revokeObjectUrl(entry.objectUrl);
  }
}

let attachmentCacheGeneration = 0;

/** The generation an in-flight fetch captured at its start. */
export function currentGeneration(): number {
  return attachmentCacheGeneration;
}

/** Called by a cache clear: every fetch started before it is now stale. */
export function bumpGeneration(): void {
  attachmentCacheGeneration += 1;
}
