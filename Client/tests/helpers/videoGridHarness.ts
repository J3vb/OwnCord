import { vi, beforeEach, afterEach } from "vitest";
import {
  createVideoGrid,
  type VideoGridComponent,
  type TileConfig,
} from "../../src/components/VideoGrid";
import { mockGetScreenshareAudioMuted, mockGetScreenshareAudioVolume } from "./videoGridMocks";

/** Minimal MediaStream stub for testing. */
export function fakeStream(): MediaStream {
  return { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
}

/**
 * MediaStream stub with a controllable video track.
 * Allows testing track lifecycle (ended/mute events).
 */
export function fakeStreamWithTrack(): {
  stream: MediaStream;
  track: { listeners: Record<string, Array<() => void>>; dispatchEvent(type: string): void };
} {
  const listeners: Record<string, Array<() => void>> = {};
  const track = {
    listeners,
    id: `track-${Math.random()}`,
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      const arr = listeners[type];
      if (arr) {
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
    dispatchEvent(type: string) {
      for (const fn of listeners[type] ?? []) fn();
    },
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What window.open hands back for a pop-out: a window with its own
 *  document, open until close() or the user closes it. */
export function fakePopup() {
  let doc = document.implementation.createHTMLDocument("");
  let fullscreenElement: Element | null = null;
  const exitFullscreen = vi.fn(() => {
    fullscreenElement = null;
    doc.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  const fit = (d: Document): void => {
    Object.defineProperty(d, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(d, "exitFullscreen", { configurable: true, value: exitFullscreen });
  };
  fit(doc);
  const win = Object.assign(new EventTarget(), {
    closed: false,
    close: vi.fn(() => {
      win.closed = true;
    }),
  });
  Object.defineProperty(win, "document", { get: () => doc });
  return {
    win,
    get doc() {
      return doc;
    },
    exitFullscreen,
    enterFullscreen(el: Element): void {
      fullscreenElement = el;
      doc.dispatchEvent(new Event("fullscreenchange"));
    },
    /** The window loads its page after open() returned: a fresh document. */
    reload(): void {
      doc = document.implementation.createHTMLDocument("");
      fit(doc);
      win.dispatchEvent(new Event("load"));
    },
  };
}

export function makeTileConfig(overrides: Partial<TileConfig> = {}): TileConfig {
  return {
    isSelf: false,
    audioUserId: 42,
    isScreenshare: false,
    ...overrides,
  };
}

export interface VideoGridHarnessBinding {
  wired(container: HTMLDivElement, grid: VideoGridComponent): void;
  currentGrid(): VideoGridComponent;
}

/** Registers the shared beforeEach/afterEach for the "VideoGrid" describe. */
export function useVideoGridHarness(binding: VideoGridHarnessBinding): void {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetScreenshareAudioMuted.mockReturnValue(false);
    mockGetScreenshareAudioVolume.mockReturnValue(1);
    // ResizeObserver is not available in JSDOM
    globalThis.ResizeObserver ??= class {
      observe(): void {
        /* noop */
      }
      unobserve(): void {
        /* noop */
      }
      disconnect(): void {
        /* noop */
      }
    } as unknown as typeof ResizeObserver;

    const container = document.createElement("div");
    const grid = createVideoGrid();
    grid.mount(container);
    binding.wired(container, grid);
  });

  afterEach(() => {
    binding.currentGrid().destroy?.();
  });
}
