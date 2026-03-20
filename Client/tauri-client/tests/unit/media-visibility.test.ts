import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  observeMedia,
  unobserveMedia,
  pauseAllMedia,
  resumeVisibleMedia,
  destroyObserver,
} from '../../src/lib/media-visibility';

// Mock IntersectionObserver
let observerCallback: IntersectionObserverCallback;
const observeMock = vi.fn();
const unobserveMock = vi.fn();
const disconnectMock = vi.fn();

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = '0px';
  readonly thresholds: readonly number[] = [0];
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
  observe = observeMock;
  unobserve = unobserveMock;
  disconnect = disconnectMock;
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function createFakeImg(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  Object.defineProperty(img, 'naturalWidth', { value: 100 });
  Object.defineProperty(img, 'naturalHeight', { value: 100 });
  return img;
}

function createWrapper(): HTMLDivElement {
  return document.createElement('div');
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

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
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

describe('media-visibility', () => {
  it('observeMedia registers image with IntersectionObserver', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();
    observeMedia(img, 'https://example.com/cat.gif', wrap);
    expect(observeMock).toHaveBeenCalledWith(img);
  });

  it('adds play/pause button to wrapper', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();
    observeMedia(img, 'https://example.com/cat.gif', wrap);

    const btn = wrap.querySelector('.gif-play-btn');
    expect(btn).not.toBeNull();
  });

  it('unobserveMedia stops observing and restores original src', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();
    observeMedia(img, 'https://example.com/cat.gif', wrap);

    img.src = 'data:image/png;base64,frozen';

    unobserveMedia(img);
    expect(unobserveMock).toHaveBeenCalledWith(img);
    expect(img.src).toBe('https://example.com/cat.gif');
  });

  it('does not double-observe same image', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();
    observeMedia(img, 'https://example.com/cat.gif', wrap);
    observeMedia(img, 'https://example.com/cat.gif', wrap);
    expect(observeMock).toHaveBeenCalledTimes(1);
  });

  it('freezes GIF when it leaves viewport', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();

    const mockCanvas = document.createElement('canvas');
    const mockCtx = { drawImage: vi.fn() };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return origCreateElement(tag);
    });
    vi.spyOn(mockCanvas, 'getContext').mockReturnValue(mockCtx as any);
    vi.spyOn(mockCanvas, 'toDataURL').mockReturnValue('data:image/png;base64,frozen');

    observeMedia(img, 'https://example.com/cat.gif', wrap);
    fireIntersection([{ target: img, isIntersecting: false }]);

    expect(img.src).toBe('data:image/png;base64,frozen');
    vi.restoreAllMocks();
  });

  it('auto-pauses after 10 seconds', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();

    const mockCanvas = document.createElement('canvas');
    const mockCtx = { drawImage: vi.fn() };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return origCreateElement(tag);
    });
    vi.spyOn(mockCanvas, 'getContext').mockReturnValue(mockCtx as any);
    vi.spyOn(mockCanvas, 'toDataURL').mockReturnValue('data:image/png;base64,frozen');

    observeMedia(img, 'https://example.com/cat.gif', wrap);

    // Should still be playing
    expect(img.src).toBe('https://example.com/cat.gif');

    // Advance 10 seconds
    vi.advanceTimersByTime(10_000);

    // Should be frozen now
    expect(img.src).toBe('data:image/png;base64,frozen');

    // Button should show play icon
    const btn = wrap.querySelector('.gif-play-btn');
    expect(btn?.textContent).toBe('\u25B6');

    vi.restoreAllMocks();
  });

  it('play button click unfreezes and starts new 10s timer', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();

    const mockCanvas = document.createElement('canvas');
    const mockCtx = { drawImage: vi.fn() };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return origCreateElement(tag);
    });
    vi.spyOn(mockCanvas, 'getContext').mockReturnValue(mockCtx as any);
    vi.spyOn(mockCanvas, 'toDataURL').mockReturnValue('data:image/png;base64,frozen');

    observeMedia(img, 'https://example.com/cat.gif', wrap);

    // Auto-pause
    vi.advanceTimersByTime(10_000);
    expect(img.src).toBe('data:image/png;base64,frozen');

    // Click play
    const btn = wrap.querySelector('.gif-play-btn') as HTMLButtonElement;
    btn.click();

    expect(img.src).toBe('https://example.com/cat.gif');

    // After another 10s, should freeze again
    vi.advanceTimersByTime(10_000);
    expect(img.src).toBe('data:image/png;base64,frozen');

    vi.restoreAllMocks();
  });

  it('pause button click freezes immediately', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();

    const mockCanvas = document.createElement('canvas');
    const mockCtx = { drawImage: vi.fn() };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return origCreateElement(tag);
    });
    vi.spyOn(mockCanvas, 'getContext').mockReturnValue(mockCtx as any);
    vi.spyOn(mockCanvas, 'toDataURL').mockReturnValue('data:image/png;base64,frozen');

    observeMedia(img, 'https://example.com/cat.gif', wrap);

    // Should be playing
    expect(img.src).toBe('https://example.com/cat.gif');

    // Click pause (button is in pause mode while playing)
    const btn = wrap.querySelector('.gif-play-btn') as HTMLButtonElement;
    btn.click();

    expect(img.src).toBe('data:image/png;base64,frozen');

    vi.restoreAllMocks();
  });

  it('pauseAllMedia freezes all tracked GIFs', () => {
    const img1 = createFakeImg('https://example.com/a.gif');
    const img2 = createFakeImg('https://example.com/b.gif');
    const wrap1 = createWrapper();
    const wrap2 = createWrapper();

    observeMedia(img1, 'https://example.com/a.gif', wrap1);
    observeMedia(img2, 'https://example.com/b.gif', wrap2);

    const mockCanvas = document.createElement('canvas');
    const mockCtx = { drawImage: vi.fn() };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return origCreateElement(tag);
    });
    vi.spyOn(mockCanvas, 'getContext').mockReturnValue(mockCtx as any);
    vi.spyOn(mockCanvas, 'toDataURL').mockReturnValue('data:image/png;base64,paused');

    pauseAllMedia();

    expect(img1.src).toBe('data:image/png;base64,paused');
    expect(img2.src).toBe('data:image/png;base64,paused');

    vi.restoreAllMocks();
  });

  it('resumeVisibleMedia only unfreezes intersecting GIFs', () => {
    const img1 = createFakeImg('https://example.com/a.gif');
    const img2 = createFakeImg('https://example.com/b.gif');
    const wrap1 = createWrapper();
    const wrap2 = createWrapper();

    observeMedia(img1, 'https://example.com/a.gif', wrap1);
    observeMedia(img2, 'https://example.com/b.gif', wrap2);

    fireIntersection([
      { target: img1, isIntersecting: true },
      { target: img2, isIntersecting: false },
    ]);

    img1.src = 'data:image/png;base64,frozen';
    img2.src = 'data:image/png;base64,frozen';

    resumeVisibleMedia();

    expect(img1.src).toBe('https://example.com/a.gif');
    expect(img2.src).toBe('data:image/png;base64,frozen');
  });

  it('wrapper gets gif-paused class when frozen', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();

    const mockCanvas = document.createElement('canvas');
    const mockCtx = { drawImage: vi.fn() };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return origCreateElement(tag);
    });
    vi.spyOn(mockCanvas, 'getContext').mockReturnValue(mockCtx as any);
    vi.spyOn(mockCanvas, 'toDataURL').mockReturnValue('data:image/png;base64,frozen');

    observeMedia(img, 'https://example.com/cat.gif', wrap);
    expect(wrap.classList.contains('gif-paused')).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(wrap.classList.contains('gif-paused')).toBe(true);

    vi.restoreAllMocks();
  });

  it('destroyObserver cleans up', () => {
    const img = createFakeImg('https://example.com/cat.gif');
    const wrap = createWrapper();
    observeMedia(img, 'https://example.com/cat.gif', wrap);

    destroyObserver();
    expect(disconnectMock).toHaveBeenCalled();
  });
});
