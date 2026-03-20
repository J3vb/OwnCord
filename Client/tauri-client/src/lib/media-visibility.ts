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

import { createElement } from "./dom";

/** How long a GIF plays before auto-pausing (ms). */
const AUTO_PAUSE_MS = 10_000;

interface MediaEntry {
  readonly originalSrc: string;
  frozenSrc: string | null;
  isIntersecting: boolean;
  isPlaying: boolean;
  autoTimer: ReturnType<typeof setTimeout> | null;
  readonly button: HTMLButtonElement;
  readonly wrapper: HTMLElement;
}

const tracked = new WeakMap<HTMLImageElement, MediaEntry>();
const allTracked = new Set<WeakRef<HTMLImageElement>>();

let observer: IntersectionObserver | null = null;
let visibilityListenerAttached = false;
let documentHidden = false;

// ---------------------------------------------------------------------------
// Canvas freeze / unfreeze
// ---------------------------------------------------------------------------

function captureStaticFrame(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    const w = Math.min(img.naturalWidth, img.width || 400);
    const h = Math.min(img.naturalHeight, img.height || 350);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function freezeImage(img: HTMLImageElement, entry: MediaEntry): void {
  if (entry.autoTimer !== null) {
    clearTimeout(entry.autoTimer);
    entry.autoTimer = null;
  }
  entry.isPlaying = false;

  if (img.src === entry.originalSrc) {
    if (entry.frozenSrc === null) {
      entry.frozenSrc = captureStaticFrame(img);
    }
    if (entry.frozenSrc !== null) {
      img.src = entry.frozenSrc;
    }
  }
  updateButton(entry);
}

function unfreezeImage(img: HTMLImageElement, entry: MediaEntry): void {
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
    "aria-label": "Play/pause GIF",
  });
  btn.textContent = "\u25B6"; // ▶
  return btn;
}

function updateButton(entry: MediaEntry): void {
  if (entry.isPlaying) {
    entry.button.textContent = "\u275A\u275A"; // ❚❚
    entry.button.classList.add("playing");
    entry.wrapper.classList.remove("gif-paused");
  } else {
    entry.button.textContent = "\u25B6"; // ▶
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
 * Start observing a GIF image. Call after the image's `load` event.
 * Returns the wrapper element that should replace the bare img in the DOM.
 * The wrapper includes the play/pause button overlay.
 */
export function observeMedia(
  img: HTMLImageElement,
  originalSrc: string,
  wrapper: HTMLElement,
): void {
  if (tracked.has(img)) return;

  const button = createPlayPauseButton();
  wrapper.style.position = "relative";
  wrapper.appendChild(button);

  const entry: MediaEntry = {
    originalSrc,
    frozenSrc: null,
    isIntersecting: true,
    isPlaying: true,
    autoTimer: null,
    button,
    wrapper,
  };
  tracked.set(img, entry);
  allTracked.add(new WeakRef(img));

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

  // Mark as playing, start auto-pause timer
  updateButton(entry);
  startAutoTimer(img, entry);

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
  unfreezeImage(img, entry);
  tracked.delete(img);
  observer?.unobserve(img);
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

/** Unfreeze only GIFs that are currently in the viewport. */
export function resumeVisibleMedia(): void {
  for (const ref of allTracked) {
    const img = ref.deref();
    if (img === undefined) {
      allTracked.delete(ref);
      continue;
    }
    const entry = tracked.get(img);
    if (entry !== undefined && entry.isIntersecting) {
      unfreezeImage(img, entry);
    }
  }
}

/** Clean up observer (for testing or app teardown). */
export function destroyObserver(): void {
  // Clear all auto-pause timers
  for (const ref of allTracked) {
    const img = ref.deref();
    if (img !== undefined) {
      const entry = tracked.get(img);
      if (entry?.autoTimer !== null && entry?.autoTimer !== undefined) {
        clearTimeout(entry.autoTimer);
      }
    }
  }
  observer?.disconnect();
  observer = null;
  allTracked.clear();
}
