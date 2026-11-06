/**
 * The first-frame still cache behind the GIF freeze: one captured still per GIF
 * URL, shared by every row showing that GIF, cleared on a session reset.
 * The owner keeps one `StillCache` and calls `reset()` from its session reset.
 */

import { SessionScope } from "../../../lib/net/sessionScope";

/** Soft cap on cached stills; an entry a tracked image still shows is never evicted. */
const MAX_STILLS = 200;

/** One captured first frame, shared by every row showing the same GIF. */
export interface Still {
  readonly key: string;
  readonly url: string;
  /** True when `url` is a blob: URL this module must revoke. */
  readonly isBlob: boolean;
  /** Tracked entries currently showing (or about to show) this still. */
  users: number;
  /** Still in `stills`; false once evicted or cleared. */
  listed: boolean;
  revoked: boolean;
}

/** Anything that holds one still at a time. */
export interface StillHolder {
  still: Still | null;
}

function revokeStill(still: Still): void {
  if (still.revoked) return;
  still.revoked = true;
  if (still.isBlob) URL.revokeObjectURL(still.url);
}

export function releaseStill(entry: StillHolder): void {
  const still = entry.still;
  if (still === null) return;
  entry.still = null;
  still.users -= 1;
  if (still.users <= 0 && !still.listed) revokeStill(still);
}

function makeStill(key: string, url: string, isBlob: boolean): Still {
  return { key, url, isBlob, users: 0, listed: false, revoked: false };
}

function dataUrlStill(key: string, canvas: HTMLCanvasElement): Still | null {
  try {
    return makeStill(key, canvas.toDataURL("image/png"), false);
  } catch {
    return null;
  }
}

export class StillCache {
  /** Insertion order is recency order (oldest first). */
  private readonly stills = new Map<string, Still>();
  /** Captures in flight, with the entries that asked for the same GIF meanwhile. */
  readonly pending = new Map<string, Set<() => void>>();
  /** Bumped by a reset so a late `toBlob` callback knows it is stale. */
  private generation = 0;
  /** Owns the deferred-capture timers; replaced when a reset disposes it. */
  private scope = new SessionScope({ host: "", generation: 0 });

  /** The signal that owns deferred-capture timers; it changes on a reset. */
  get signal(): AbortSignal {
    return this.scope.signal;
  }

  get(key: string): Still | undefined {
    return this.stills.get(key);
  }

  /** Cache a captured still under `key`. */
  put(key: string, still: Still): void {
    still.listed = true;
    this.stills.set(key, still);
  }

  adopt(entry: StillHolder, still: Still): void {
    if (entry.still !== still) {
      releaseStill(entry);
      still.users += 1;
      entry.still = still;
    }
    if (still.listed) {
      // Touch: most recently used goes to the back.
      this.stills.delete(still.key);
      this.stills.set(still.key, still);
    }
  }

  evict(): void {
    if (this.stills.size <= MAX_STILLS) return;
    for (const [key, still] of this.stills) {
      if (this.stills.size <= MAX_STILLS) break;
      if (still.users > 0) continue;
      this.stills.delete(key);
      still.listed = false;
      revokeStill(still);
    }
  }

  /** Drop every cached still (session reset); blob URLs still shown outlive it. */
  reset(): void {
    this.generation += 1;
    this.pending.clear();
    this.scope.dispose();
    this.scope = new SessionScope({ host: "", generation: this.generation });
    for (const still of this.stills.values()) {
      still.listed = false;
      if (still.users <= 0) revokeStill(still);
    }
    this.stills.clear();
  }

  /**
   * Draw the GIF's current frame and encode it. `toBlob` encodes off the main
   * thread; without it (jsdom, old WebKit) the data-URL path is the fallback.
   * `done` is not called when a reset made the result stale.
   */
  capture(img: HTMLImageElement, key: string, done: (s: Still | null) => void): void {
    const generation = this.generation;
    let canvas: HTMLCanvasElement;
    try {
      canvas = document.createElement("canvas");
      // Scale as a whole, so a box that is not the image's shape (a sticker's
      // square, object-fit: contain) does not stretch the still.
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const scale =
        nw > 0 && nh > 0 ? Math.min(1, (img.width || 400) / nw, (img.height || 350) / nh) : 1;
      const w = Math.round(nw * scale);
      const h = Math.round(nh * scale);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        done(null);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
    } catch {
      done(null);
      return;
    }
    if (typeof canvas.toBlob !== "function" || typeof URL.createObjectURL !== "function") {
      done(dataUrlStill(key, canvas));
      return;
    }
    const source = canvas;
    try {
      source.toBlob((blob) => {
        // A reset ran while the encode was in flight: drop the result, and make
        // no URL, so there is nothing to revoke.
        if (generation !== this.generation) return;
        if (blob === null) {
          done(dataUrlStill(key, source));
          return;
        }
        try {
          done(makeStill(key, URL.createObjectURL(blob), true));
        } catch {
          done(dataUrlStill(key, source));
        }
      }, "image/png");
    } catch {
      done(dataUrlStill(key, source));
    }
  }
}
