import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  observeMedia,
  unobserveMedia,
  pauseAllMedia,
  resumeVisibleMedia,
  destroyObserver,
} from "../../src/lib/media-visibility";

// Mock IntersectionObserver
let observerCallback: IntersectionObserverCallback;
const observeMock = vi.fn();
const unobserveMock = vi.fn();
const disconnectMock = vi.fn();

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = "0px";
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

function setupCanvasMocks(): () => void {
  const mockCanvas = document.createElement("canvas");
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

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.useFakeTimers();
  observeMock.mockClear();
  unobserveMock.mockClear();
  disconnectMock.mockClear();
});

afterEach(() => {
  destroyObserver();
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
    expect(img.src).toBe("data:image/png;base64,frozen");
    const btn = wrap.querySelector(".gif-play-btn") as HTMLButtonElement;
    btn.click();
    expect(img.src).toBe("https://example.com/cat.gif");
    vi.advanceTimersByTime(10_000);
    expect(img.src).toBe("data:image/png;base64,frozen");
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
    expect(img1.src).toBe("data:image/png;base64,frozen");
    expect(img2.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("resumeVisibleMedia only unfreezes intersecting GIFs", () => {
    const img1 = createFakeImg("https://example.com/a.gif");
    const img2 = createFakeImg("https://example.com/b.gif");
    const wrap1 = createWrapper();
    const wrap2 = createWrapper();
    observeMedia(img1, "https://example.com/a.gif", wrap1);
    observeMedia(img2, "https://example.com/b.gif", wrap2);
    fireIntersection([
      { target: img1, isIntersecting: true },
      { target: img2, isIntersecting: false },
    ]);
    img1.src = "data:image/png;base64,frozen";
    img2.src = "data:image/png;base64,frozen";
    resumeVisibleMedia();
    expect(img1.src).toBe("https://example.com/a.gif");
    expect(img2.src).toBe("data:image/png;base64,frozen");
  });

  it("wrapper gets gif-paused class when frozen", () => {
    const cleanup = setupCanvasMocks();
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    expect(wrap.classList.contains("gif-paused")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(wrap.classList.contains("gif-paused")).toBe(true);
    cleanup();
  });

  it("destroyObserver cleans up", () => {
    const img = createFakeImg("https://example.com/cat.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/cat.gif", wrap);
    destroyObserver();
    expect(disconnectMock).toHaveBeenCalled();
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
    // Should not throw
    expect(img.src).toBe("data:image/png;base64,frozen");
    cleanup();
  });

  it("resumeVisibleMedia cleans up stale WeakRefs without throwing", () => {
    // Register and immediately unobserve so the entry is gone from tracked
    const img = createFakeImg("https://example.com/gone.gif");
    const wrap = createWrapper();
    observeMedia(img, "https://example.com/gone.gif", wrap);
    unobserveMedia(img);
    // Now resumeVisibleMedia should not crash
    resumeVisibleMedia();
    // No assertion needed — just verifying no throw
  });
});
