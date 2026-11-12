/**
 * Media visibility manager — freezes animated GIFs when they leave
 * the viewport, when the window loses focus, or after an auto-pause
 * timeout. Provides a play/pause button overlay on each GIF.
 *
 * Flow:
 *   GIF loads ──► observeMedia(img, src, wrapper)
 *                    │
 *                    ├─► Plays for AUTO_PAUSE_MS (10s)
 *                    │       then freezes + shows ▶ button
 *                    │
 *                    ├─► Leaves viewport → freeze immediately
 *                    │
 *                    ├─► Window blur/minimize → freeze immediately
 *                    │
 *                    └─► User clicks ▶ → plays for another 10s
 *                        User clicks ❚❚ → freeze immediately
 */

import { createElement, setOwnedTimeout } from "../../../lib/dom";
import { createIcon } from "../../../lib/icons";
import { connectText } from "../../../i18n/connect";
import { StillCache, releaseStill, type Still } from "./mediaStills";
import { registerSessionReset } from "../../../lib/net/sessionRegistry";

/** How long a GIF plays before auto-pausing (ms). */
const AUTO_PAUSE_MS = 10_000;

interface MediaEntry {
  readonly originalSrc: string;
  still: Still | null;
  /** Cancels a deferred capture that has not run yet. */
  captureCancel: (() => void) | null;
  isIntersecting: boolean;
  isPlaying: boolean;
  autoTimer: ReturnType<typeof setTimeout> | null;
  readonly button: HTMLButtonElement;
  readonly wrapper: HTMLElement;
  readonly ref: WeakRef<HTMLImageElement>;
}

const tracked = new WeakMap<HTMLImageElement, MediaEntry>();
const allTracked = new Set<WeakRef<HTMLImageElement>>();

let observer: IntersectionObserver | null = null;
let visibilityListenerAttached = false;
let documentHidden = false;

const cache = new StillCache();

void registerSessionReset(
  "media-visibility:stills",
  () => {
    cache.reset();
    // Deferred captures died with the old scope; ask again for the paused rows.
    for (const ref of allTracked) {
      const img = ref.deref();
      const entry = img === undefined ? undefined : tracked.get(img);
      if (img === undefined || entry === undefined) continue;
      entry.captureCancel = null;
      if (!entry.isPlaying && entry.still === null) scheduleCapture(img, entry);
    }
  },
  { phase: "cache" },
); // app-lifetime

function applyStill(img: HTMLImageElement, entry: MediaEntry, still: Still): void {
  cache.adopt(entry, still);
  if (img.src !== still.url) img.src = still.url;
}

/** Show the cached still on a paused, still-tracked image, if there is one. */
function applyCached(img: HTMLImageElement, entry: MediaEntry): boolean {
  if (tracked.get(img) !== entry || entry.isPlaying) return false;
  const still = cache.get(entry.originalSrc);
  if (still === undefined) return false;
  applyStill(img, entry, still);
  return true;
}

/**
 * Capture a never-seen GIF's still in a task of its own, so the encode never
 * shares a frame with the wheel event that scrolled the row to the edge.
 */
function scheduleCapture(img: HTMLImageElement, entry: MediaEntry): void {
  if (entry.captureCancel !== null) return;
  const key = entry.originalSrc;
  entry.captureCancel = setOwnedTimeout(
    cache.signal,
    () => {
      entry.captureCancel = null;
      if (tracked.get(img) !== entry || entry.isPlaying) return;
      if (applyCached(img, entry)) return;
      const waiters = cache.pending.get(key);
      if (waiters !== undefined) {
        waiters.add(() => applyCached(img, entry));
        return;
      }
      const mine = new Set<() => void>();
      cache.pending.set(key, mine);
      cache.capture(img, key, (still) => {
        if (cache.pending.get(key) === mine) cache.pending.delete(key);
        if (still !== null) {
          cache.put(key, still);
        }
        // A row that left meanwhile takes nothing; the still stays cached for the next one.
        applyCached(img, entry);
        for (const waiter of mine) waiter();
        cache.evict();
      });
    },
    0,
  );
}

function cancelCapture(entry: MediaEntry): void {
  if (entry.captureCancel === null) return;
  entry.captureCancel();
  entry.captureCancel = null;
}

// ---------------------------------------------------------------------------
// Freeze / unfreeze
// ---------------------------------------------------------------------------

function freezeImage(img: HTMLImageElement, entry: MediaEntry): void {
  if (entry.autoTimer !== null) {
    clearTimeout(entry.autoTimer);
    entry.autoTimer = null;
  }
  entry.isPlaying = false;

  const cached = entry.still ?? cache.get(entry.originalSrc);
  if (cached !== undefined) {
    applyStill(img, entry, cached);
  } else {
    scheduleCapture(img, entry);
  }
  updateButton(entry);
}

function unfreezeImage(img: HTMLImageElement, entry: MediaEntry): void {
  cancelCapture(entry);
  releaseStill(entry);
  if (img.src !== entry.originalSrc) {
    img.src = entry.originalSrc;
  }
  entry.isPlaying = true;
  updateButton(entry);
  startAutoTimer(img, entry);
}

// ---------------------------------------------------------------------------
// Play/pause button
// ---------------------------------------------------------------------------

function createPlayPauseButton(): HTMLButtonElement {
  const btn = createElement("button", {
    class: "gif-play-btn",
    type: "button",
    "aria-label": connectText("media.playPauseGif"),
  });
  btn.textContent = "";
  btn.appendChild(createIcon("play", 14));
  return btn;
}

function updateButton(entry: MediaEntry): void {
  if (entry.isPlaying) {
    entry.button.textContent = "";
    entry.button.appendChild(createIcon("pause", 14));
    entry.button.classList.add("playing");
    entry.wrapper.classList.remove("gif-paused");
  } else {
    entry.button.textContent = "";
    entry.button.appendChild(createIcon("play", 14));
    entry.button.classList.remove("playing");
    entry.wrapper.classList.add("gif-paused");
  }
}

// ---------------------------------------------------------------------------
// Auto-pause timer
// ---------------------------------------------------------------------------

function startAutoTimer(img: HTMLImageElement, entry: MediaEntry): void {
  if (entry.autoTimer !== null) {
    clearTimeout(entry.autoTimer);
  }
  entry.autoTimer = setTimeout(() => {
    entry.autoTimer = null;
    if (entry.isPlaying) {
      freezeImage(img, entry);
    }
  }, AUTO_PAUSE_MS);
}

// ---------------------------------------------------------------------------
// IntersectionObserver
// ---------------------------------------------------------------------------

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (observer !== null) return observer;

  observer = new IntersectionObserver(
    (entries) => {
      for (const ioEntry of entries) {
        const img = ioEntry.target as HTMLImageElement;
        const data = tracked.get(img);
        if (data === undefined) continue;

        data.isIntersecting = ioEntry.isIntersecting;

        if (!ioEntry.isIntersecting) {
          freezeImage(img, data);
        }
        // Don't auto-unfreeze on intersection — user controls play via button
        // Only resume if the image was playing when it scrolled into view
      }
    },
    { root: null, rootMargin: "0px", threshold: 0 },
  );

  return observer;
}

// ---------------------------------------------------------------------------
// Visibility change (window minimize / blur)
// ---------------------------------------------------------------------------

function ensureVisibilityListener(): void {
  if (visibilityListenerAttached) return;
  visibilityListenerAttached = true;

  document.addEventListener("visibilitychange", () => {
    documentHidden = document.hidden;
    if (documentHidden) {
      pauseAllMedia();
    }
    // Don't auto-resume on visibility — user controls play via button
  });

  window.addEventListener("blur", () => {
    documentHidden = true;
    pauseAllMedia();
  });

  window.addEventListener("focus", () => {
    documentHidden = false;
    // Don't auto-resume — user clicks play when ready
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Whether a laid-out image sits wholly outside the viewport. Unknown (detached
 * or zero-sized, as in jsdom) counts as visible: the first IO callback decides.
 */
function isOffscreen(img: HTMLImageElement): boolean {
  if (!img.isConnected) return false;
  const r = img.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return (
    r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth
  );
}

/**
 * Start observing a GIF image. Call after the image's `load` event.
 * Returns the wrapper element that should replace the bare img in the DOM.
 * The wrapper includes the play/pause button overlay.
 *
 * @param startFrozen - If true, the GIF starts frozen (first frame shown)
 *   instead of auto-playing. The user can still click the play button to
 *   start playback. Used when the `animateGifs` preference is disabled.
 */
export function observeMedia(
  img: HTMLImageElement,
  originalSrc: string,
  wrapper: HTMLElement,
  startFrozen?: boolean,
): void {
  if (tracked.has(img)) return;

  const offscreen = startFrozen !== true && isOffscreen(img);
  const button = createPlayPauseButton();
  wrapper.style.position = "relative";
  wrapper.appendChild(button);

  const ref = new WeakRef(img);
  const entry: MediaEntry = {
    originalSrc,
    still: null,
    captureCancel: null,
    isIntersecting: !offscreen,
    isPlaying: true,
    autoTimer: null,
    button,
    wrapper,
    ref,
  };
  tracked.set(img, entry);
  allTracked.add(ref);
  // A frozen GIF shows its still; this names the animated source the image
  // cache must keep loadable while the row is mounted (`liveBlobUrls`).
  img.dataset["mediaSrc"] = originalSrc;

  // Wire button click
  button.addEventListener("click", (e) => {
    e.stopPropagation(); // don't trigger lightbox
    const data = tracked.get(img);
    if (data === undefined) return;

    if (data.isPlaying) {
      freezeImage(img, data);
    } else {
      unfreezeImage(img, data);
    }
  });

  if (startFrozen === true || offscreen) {
    // Start frozen (pref off, or built off-screen in the overscan): never
    // play-then-freeze. Show the cached or soon-captured still and the ▶ button.
    entry.isPlaying = false;
    freezeImage(img, entry);
  } else {
    // Default: start playing, auto-pause after AUTO_PAUSE_MS
    updateButton(entry);
    startAutoTimer(img, entry);
  }

  ensureVisibilityListener();
  getObserver()?.observe(img);
}

/** Stop observing an image element. */
export function unobserveMedia(img: HTMLImageElement): void {
  const entry = tracked.get(img);
  if (entry === undefined) return;

  if (entry.autoTimer !== null) {
    clearTimeout(entry.autoTimer);
  }
  cancelCapture(entry);
  // Restore original src without starting a new auto-timer.
  if (img.src !== entry.originalSrc) {
    img.src = entry.originalSrc;
  }
  releaseStill(entry);
  tracked.delete(img);
  observer?.unobserve(img);
  allTracked.delete(entry.ref);
}

/**
 * Stop observing an image that is about to leave the DOM. Unlike
 * `unobserveMedia` it leaves `src` alone, so a frozen GIF is not reloaded.
 */
export function discardMedia(img: HTMLImageElement): void {
  const entry = tracked.get(img);
  if (entry === undefined) return;

  if (entry.autoTimer !== null) {
    clearTimeout(entry.autoTimer);
    entry.autoTimer = null;
  }
  cancelCapture(entry);
  releaseStill(entry);
  tracked.delete(img);
  observer?.unobserve(img);
  allTracked.delete(entry.ref);
}

/**
 * Play a tracked image for another AUTO_PAUSE_MS, as its ▶ button does. For
 * surfaces that also play on hover or tap (stickers); untracked images are left alone.
 */
export function playMedia(img: HTMLImageElement): void {
  const entry = tracked.get(img);
  if (entry === undefined) return;
  unfreezeImage(img, entry);
}

/** Freeze all tracked GIFs (called on window hide/blur). */
export function pauseAllMedia(): void {
  for (const ref of allTracked) {
    const img = ref.deref();
    if (img === undefined) {
      allTracked.delete(ref);
      continue;
    }
    const entry = tracked.get(img);
    if (entry !== undefined) {
      freezeImage(img, entry);
    }
  }
}
