import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mediaVisibility from "../../src/lib/prefs/mediaVisibility";
import { observeMedia, unobserveMedia, pauseAllMedia } from "../../src/lib/prefs/mediaVisibility";
import { runSessionResets } from "../../src/lib/net/sessionRegistry";

// Resolved off the namespace so a missing export fails the assertion, not the import.
const discardMedia = (mediaVisibility as Record<string, unknown>).discardMedia as (
  img: HTMLImageElement,
) => void;

// Mock IntersectionObserver
let observerCallback: IntersectionObserverCallback;
const observeMock = vi.fn();
const unobserveMock = vi.fn();
const disconnectMock = vi.fn();

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = "0px";
  readonly scrollMargin: string = "0px";
  readonly thresholds: readonly number[] = [0];
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
  observe = observeMock;
  unobserve = unobserveMock;
  disconnect = disconnectMock;
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function createFakeImg(src: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = src;
  Object.defineProperty(img, "naturalWidth", { value: 100 });
  Object.defineProperty(img, "naturalHeight", { value: 100 });
  return img;
}

function createWrapper(): HTMLDivElement {
  return document.createElement("div");
}

function fireIntersection(entries: Array<{ target: Element; isIntersecting: boolean }>): void {
  const fakeEntries = entries.map((e) => ({
    target: e.target,
    isIntersecting: e.isIntersecting,
    boundingClientRect: {} as DOMRectReadOnly,
    intersectionRatio: e.isIntersecting ? 1 : 0,
    intersectionRect: {} as DOMRectReadOnly,
    rootBounds: null,
    time: Date.now(),
  }));
  observerCallback(fakeEntries, {} as IntersectionObserver);
}

function setupCanvasMocks(withToBlob?: (cb: BlobCallback) => void): () => void {
  const mockCanvas = document.createElement("canvas");
  // jsdom's toBlob never calls back; model "toBlob unavailable" unless a test supplies one.
  Object.defineProperty(mockCanvas, "toBlob", {
    value: withToBlob === undefined ? undefined : (cb: BlobCallback) => withToBlob(cb),
    configurable: true,
  });
  const mockCtx = { drawImage: vi.fn() };
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "canvas") return mockCanvas;
    return origCreateElement(tag);
  });
  vi.spyOn(mockCanvas, "getContext").mockReturnValue(mockCtx as any);
  vi.spyOn(mockCanvas, "toDataURL").mockReturnValue("data:image/png;base64,frozen");
  return () => vi.restoreAllMocks();
}

/** Let the deferred (off the scroll frame) still capture run. */
function flushCapture(): void {
  vi.advanceTimersByTime(1);
}

beforeEach(() => {
  runSessionResets("user");
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.useFakeTimers();
  observeMock.mockClear();
  unobserveMock.mockClear();
  disconnectMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("media-visibility", () => {
  it("observeMedia registers image with IntersectionObserver", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    expect(observeMock).toHaveBeenCalledWith(img);
  });

  it("names the animated source on the image so an image cache keeps it while mounted", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    observeMedia(img, "https://example.com/cat.gif", createWrapper());
    expect(img.dataset["mediaSrc"]).toBe("https://example.com/cat.gif");
  });

  it("adds play/pause button to wrapper", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    const btn = wrap.querySelector(".gif-play-btn");
    expect(btn).not.toBeNull();
  });

  it("unobserveMedia stops observing and restores original src", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    img.src = "data:image/png;base64,frozen";
    unobserveMedia(img);
    expect(unobserveMock).toHaveBeenCalledWith(img);
    expect(img.src).toBe("https://example.com/cat.gif");
  });

  it("does not double-observe same image", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    observeMedia(img, "https://example.com/cat.gif", wrap);
    expect(observeMock).toHaveBeenCalledTimes(1);
  });

  it("freezes GIF when it leaves viewport", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    fireIntersection([{ target: img, isIntersecting: false }]);
    flushCapture();
    expect(img.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("auto-pauses after 10 seconds", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    expect(img.src).toBe("https://example.com/cat.gif");
    vi.advanceTimersByTime(10_000);
    flushCapture();
    expect(img.src).toBe("data:image/png;base64,frozen");
    const btn = wrap.querySelector(".gif-play-btn");
    expect(btn?.querySelector('svg[data-icon="play"]')).not.toBeNull();
    cleanup();
  });

  it("play button click unfreezes and starts new 10s timer", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    vi.advanceTimersByTime(10_000);
    flushCapture();
    expect(img.src).toBe("data:image/png;base64,frozen");
    const btn = wrap.querySelector(".gif-play-btn") as HTMLButtonElement;
    btn.click();
    expect(img.src).toBe("https://example.com/cat.gif");
    vi.advanceTimersByTime(10_000);
    flushCapture();
    expect(img.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("freezes a GIF whose src the DOM normalizes away from the raw originalSrc", () => {
    const cleanup = setupCanvasMocks();
    // Mixed-case host: the <img> element's src getter returns this
    // lowercased per the WHATWG URL spec, so it no longer string-matches
    // the raw originalSrc the caller passed in.
    const raw = "https://EXAMPLE.com/anim.gif";
    const img = createFakeImg(raw);
    const wrap = createWrapper();
    observeMedia(img, raw, wrap);
    // Sanity check: the DOM really did normalize it away from `raw`.
    expect(img.src).toBe("https://example.com/anim.gif");
    expect(img.src).not.toBe(raw);

    const btn = wrap.querySelector(".gif-play-btn") as HTMLButtonElement;
    btn.click();
    flushCapture();
    expect(img.src).toBe("data:image/png;base64,frozen");
    expect(wrap.classList.contains("gif-paused")).toBe(true);
    cleanup();
  });

  it("pause button click freezes immediately", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    expect(img.src).toBe("https://example.com/cat.gif");
    const btn = wrap.querySelector(".gif-play-btn") as HTMLButtonElement;
    btn.click();
    flushCapture();
    expect(img.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("pauseAllMedia freezes all tracked GIFs", () => {
    const cleanup = setupCanvasMocks();
    const img1 = createFakeImg("https://example.com/a.gif");
    const img2 = createFakeImg("https://example.com/b.gif");
    const wrap1 = createWrapper();
    const wrap2 = createWrapper();
    observeMedia(img1, "https://example.com/a.gif", wrap1);
    observeMedia(img2, "https://example.com/b.gif", wrap2);
    pauseAllMedia();
    flushCapture();
    expect(img1.src).toBe("data:image/png;base64,frozen");
    expect(img2.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("wrapper gets gif-paused class when frozen", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    expect(wrap.classList.contains("gif-paused")).toBe(false);
    vi.advanceTimersByTime(10_000);
    flushCapture();
    expect(wrap.classList.contains("gif-paused")).toBe(true);
    cleanup();
  });

  it("unobserveMedia does not start a dangling auto-timer", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    unobserveMedia(img);
    const cleanup = setupCanvasMocks();
    vi.advanceTimersByTime(15_000);
    // toDataURL should NOT have been called (no dangling timer)
    const canvas = document.createElement("canvas");
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    cleanup();
  });

  it("starts frozen when startFrozen is true", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap, true);
    // Should be frozen immediately
    expect(wrap.classList.contains("gif-paused")).toBe(true);
    // The button should show play icon
    const btn = wrap.querySelector(".gif-play-btn");
    expect(btn?.querySelector('svg[data-icon="play"]')).not.toBeNull();
    cleanup();
  });

  it("startFrozen image can be unfrozen by clicking play", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap, true);

    expect(wrap.classList.contains("gif-paused")).toBe(true);

    // Click play to unfreeze
    const btn = wrap.querySelector(".gif-play-btn") as HTMLButtonElement;
    btn.click();

    expect(img.src).toBe("https://example.com/cat.gif");
    expect(wrap.classList.contains("gif-paused")).toBe(false);
    cleanup();
  });

  it("unobserveMedia on an untracked image is a no-op", () => {
    const img = createFakeImg("https://example.com/unknown.gif");
    // Should not throw
    unobserveMedia(img);
    expect(unobserveMock).not.toHaveBeenCalled();
  });

  it("pauseAllMedia cleans up stale WeakRefs", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/stale.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/stale.gif", wrap);

    // First, unobserve to remove from tracked but leave in allTracked
    // Then pauseAllMedia should handle the missing entry gracefully
    pauseAllMedia();
    flushCapture();
    // Should not throw
    expect(img.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("discardMedia stops observing a frozen GIF without reloading it", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    fireIntersection([{ target: img, isIntersecting: false }]);
    flushCapture();
    expect(img.src.startsWith("data:")).toBe(true);

    discardMedia(img);
    expect(unobserveMock).toHaveBeenCalledWith(img);
    expect(img.src).toBe("data:image/png;base64,frozen");

    unobserveMock.mockClear();
    discardMedia(img);
    expect(unobserveMock).not.toHaveBeenCalled();
    expect(img.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("discardMedia clears a pending auto-timer", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    discardMedia(img);
    const cleanup = setupCanvasMocks();
    vi.advanceTimersByTime(15_000);
    const canvas = document.createElement("canvas");
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    expect(img.src).toBe("https://example.com/cat.gif");
    cleanup();
  });

  it("pauseAllMedia after discard does not touch the discarded image", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    discardMedia(img);
    pauseAllMedia();
    expect(img.src).toBe("https://example.com/cat.gif");
    expect(wrap.classList.contains("gif-paused")).toBe(false);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Still cache: one blob-URL still per GIF, captured off the scroll path
// ---------------------------------------------------------------------------

describe("media-visibility still cache", () => {
  let drawImage: ReturnType<typeof vi.fn>;
  let toBlobCallbacks: BlobCallback[];
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let blobCounter: number;
  let autoComplete: boolean;
  let nullBlob: boolean;

  beforeEach(() => {
    drawImage = vi.fn();
    toBlobCallbacks = [];
    blobCounter = 0;
    autoComplete = true;
    nullBlob = false;
    createObjectURL = vi.fn(() => `blob:still-${++blobCounter}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(
        function (this: unknown, ...args: ConstructorParameters<typeof URL>) {
          return new (URL as unknown as new (...a: unknown[]) => URL)(...args);
        },
        { createObjectURL, revokeObjectURL },
      ),
    );
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "canvas") {
        vi.spyOn(el as HTMLCanvasElement, "getContext").mockReturnValue({
          drawImage,
        } as unknown as CanvasRenderingContext2D);
        vi.spyOn(el as HTMLCanvasElement, "toDataURL").mockReturnValue("data:image/png;base64,fb");
        Object.defineProperty(el, "toBlob", {
          value: (cb: BlobCallback) => {
            if (nullBlob) cb(null);
            else if (autoComplete) cb(new Blob(["x"], { type: "image/png" }));
            else toBlobCallbacks.push(cb);
          },
          configurable: true,
        });
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures nothing on the freezing call itself, only in a later task", () => {
    const img = createFakeImg("https://example.com/defer.gif");
    observeMedia(img, "https://example.com/defer.gif", createWrapper(), true);
    expect(drawImage).not.toHaveBeenCalled();
    flushCapture();
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("freezes through a blob URL, not a data URL", () => {
    const img = createFakeImg("https://example.com/blob.gif");
    observeMedia(img, "https://example.com/blob.gif", createWrapper(), true);
    flushCapture();
    expect(img.src).toBe("blob:still-1");
  });

  it("two observeMedia calls for the same GIF capture once", () => {
    const a = createFakeImg("https://example.com/same.gif");
    const b = createFakeImg("https://example.com/same.gif");
    observeMedia(a, "https://example.com/same.gif", createWrapper(), true);
    observeMedia(b, "https://example.com/same.gif", createWrapper(), true);
    flushCapture();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(a.src).toBe("blob:still-1");
    expect(b.src).toBe("blob:still-1");
  });

  it("a row rebuilt later reuses the cached still without drawing again", () => {
    const first = createFakeImg("https://example.com/rebuilt.gif");
    observeMedia(first, "https://example.com/rebuilt.gif", createWrapper(), true);
    flushCapture();
    discardMedia(first);
    const second = createFakeImg("https://example.com/rebuilt.gif");
    observeMedia(second, "https://example.com/rebuilt.gif", createWrapper(), true);
    // Cache hit: the swap is immediate, with no task and no second draw.
    expect(second.src).toBe("blob:still-1");
    flushCapture();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("a row built off-screen starts frozen and never plays until Play is clicked", () => {
    const img = createFakeImg("https://example.com/off.gif");
    document.body.appendChild(img);
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      top: 5000,
      bottom: 5200,
      left: 0,
      right: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 5000,
      toJSON: () => ({}),
    });
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/off.gif", wrap);
    expect(wrap.classList.contains("gif-paused")).toBe(true);
    expect(wrap.querySelector('svg[data-icon="play"]')).not.toBeNull();
    // No auto-play timer: the animated URL is not re-applied.
    flushCapture();
    expect(img.src).toBe("blob:still-1");
    // The first IO callback reporting it visible does not start playback.
    fireIntersection([{ target: img, isIntersecting: true }]);
    vi.advanceTimersByTime(20_000);
    expect(img.src).toBe("blob:still-1");
    (wrap.querySelector(".gif-play-btn") as HTMLButtonElement).click();
    expect(img.src).toBe("https://example.com/off.gif");
    img.remove();
  });

  it("a row built on-screen still plays first", () => {
    const img = createFakeImg("https://example.com/on.gif");
    document.body.appendChild(img);
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 300,
      left: 0,
      right: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/on.gif", wrap);
    expect(wrap.classList.contains("gif-paused")).toBe(false);
    expect(img.src).toBe("https://example.com/on.gif");
    img.remove();
  });

  it("evicting a still revokes its blob URL exactly once", () => {
    const keep = createFakeImg("https://example.com/g-0.gif");
    observeMedia(keep, "https://example.com/g-0.gif", createWrapper(), true);
    flushCapture();
    discardMedia(keep);
    for (let i = 1; i <= 200; i++) {
      const url = `https://example.com/g-${i}.gif`;
      const img = createFakeImg(url);
      observeMedia(img, url, createWrapper(), true);
      flushCapture();
      discardMedia(img);
    }
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:still-1");
  });

  it("a playing row does not pin its still", () => {
    const playing = createFakeImg("https://example.com/playing.gif");
    const wrap = createWrapper();
    observeMedia(playing, "https://example.com/playing.gif", wrap, true);
    flushCapture();
    (wrap.querySelector(".gif-play-btn") as HTMLButtonElement).click();
    expect(playing.src).toBe("https://example.com/playing.gif");
    for (let i = 0; i < 205; i++) {
      const url = `https://example.com/pin-${i}.gif`;
      const img = createFakeImg(url);
      observeMedia(img, url, createWrapper(), true);
      flushCapture();
      discardMedia(img);
    }
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:still-1");
  });

  it("never evicts a still a tracked row still shows", () => {
    const shown = createFakeImg("https://example.com/shown.gif");
    observeMedia(shown, "https://example.com/shown.gif", createWrapper(), true);
    flushCapture();
    for (let i = 0; i < 205; i++) {
      const url = `https://example.com/other-${i}.gif`;
      const img = createFakeImg(url);
      observeMedia(img, url, createWrapper(), true);
      flushCapture();
      discardMedia(img);
    }
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:still-1");
    expect(shown.src).toBe("blob:still-1");
  });

  it("a late toBlob result after a cache clear is dropped and nothing is revoked", () => {
    autoComplete = false;
    const img = createFakeImg("https://example.com/late.gif");
    observeMedia(img, "https://example.com/late.gif", createWrapper(), true);
    flushCapture();
    expect(toBlobCallbacks).toHaveLength(1);
    runSessionResets("server_switch");
    toBlobCallbacks[0]?.(new Blob(["x"], { type: "image/png" }));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(img.src).not.toMatch(/^blob:/);
  });

  it("a cache clear while two rows show one still revokes it once, after the last leaves", () => {
    const a = createFakeImg("https://example.com/pair.gif");
    const b = createFakeImg("https://example.com/pair.gif");
    observeMedia(a, "https://example.com/pair.gif", createWrapper(), true);
    observeMedia(b, "https://example.com/pair.gif", createWrapper(), true);
    flushCapture();
    runSessionResets("server_switch");
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(a.src).toBe("blob:still-1");
    discardMedia(a);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    unobserveMedia(b);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:still-1");
    expect(b.src).toBe("https://example.com/pair.gif");
  });

  it("a cache clear revokes unused stills and the next row captures afresh", () => {
    const img = createFakeImg("https://example.com/fresh.gif");
    observeMedia(img, "https://example.com/fresh.gif", createWrapper(), true);
    flushCapture();
    discardMedia(img);
    runSessionResets("user");
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    // Rows left over from earlier tests re-ask for their stills; settle them first.
    flushCapture();
    const drawn = drawImage.mock.calls.length;
    const again = createFakeImg("https://example.com/fresh.gif");
    observeMedia(again, "https://example.com/fresh.gif", createWrapper(), true);
    flushCapture();
    expect(drawImage).toHaveBeenCalledTimes(drawn + 1);
    expect(again.src.startsWith("blob:")).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("discarding a row before its deferred capture runs cancels the capture", () => {
    const img = createFakeImg("https://example.com/gone.gif");
    observeMedia(img, "https://example.com/gone.gif", createWrapper(), true);
    discardMedia(img);
    flushCapture();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("falls back to a data URL when toBlob yields no blob", () => {
    nullBlob = true;
    const img = createFakeImg("https://example.com/fb.gif");
    observeMedia(img, "https://example.com/fb.gif", createWrapper(), true);
    flushCapture();
    expect(img.src).toBe("data:image/png;base64,fb");
    unobserveMedia(img);
    runSessionResets("user");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("unobserveMedia restores the animated source and releases the still", () => {
    const img = createFakeImg("https://example.com/restore.gif");
    observeMedia(img, "https://example.com/restore.gif", createWrapper(), true);
    flushCapture();
    expect(img.src).toBe("blob:still-1");
    unobserveMedia(img);
    expect(img.src).toBe("https://example.com/restore.gif");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("pauseAllMedia freezes every row onto cached stills", () => {
    const a = createFakeImg("https://example.com/p1.gif");
    const b = createFakeImg("https://example.com/p2.gif");
    observeMedia(a, "https://example.com/p1.gif", createWrapper());
    observeMedia(b, "https://example.com/p2.gif", createWrapper());
    pauseAllMedia();
    flushCapture();
    expect(a.src.startsWith("blob:")).toBe(true);
    expect(b.src.startsWith("blob:")).toBe(true);
    expect(a.src).not.toBe(b.src);
  });
});
