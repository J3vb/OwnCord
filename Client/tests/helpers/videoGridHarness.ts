import { vi, beforeEach, afterEach } from "vitest";
import {
  createVideoGrid,
  type VideoGridComponent,
  type TileConfig,
} from "../../src/components/VideoGrid";
import "./resizeObserverStub";
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
export function useVideoGridHarness(
  binding:
    VideoGridHarnessBinding | ((container: HTMLDivElement, grid: VideoGridComponent) => void),
): { adopt(grid: VideoGridComponent): VideoGridComponent } {
  let current: VideoGridComponent | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetScreenshareAudioMuted.mockReturnValue(false);
    mockGetScreenshareAudioVolume.mockReturnValue(1);
    const container = document.createElement("div");
    const grid = createVideoGrid();
    grid.mount(container);
    current = grid;
    if (typeof binding === "function") binding(container, grid);
    else binding.wired(container, grid);
  });

  afterEach(() => {
    if (typeof binding === "function") current?.destroy?.();
    else binding.currentGrid().destroy?.();
  });
  return {
    /** Hands the harness a grid the test mounted itself, so teardown destroys it. */
    adopt(grid: VideoGridComponent): VideoGridComponent {
      current = grid;
      return grid;
    },
  };
}

export const SCREEN_TILE = 2 + 1_000_000;

export function screenTileConfig(): TileConfig {
  return { isSelf: false, audioUserId: 2, isScreenshare: true, name: "Otto" };
}

/** Looks up a tile and its control buttons in the container the test mounted. */
export function tileLookups(getContainer: () => HTMLElement) {
  const cell = (id: number) =>
    getContainer().querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
  const control = (id: number, name: string) =>
    cell(id).querySelector<HTMLButtonElement>(`[data-tile-control='${name}']`)!;
  return { cell, control };
}

export interface FullscreenApi {
  requestFullscreen: ReturnType<typeof vi.fn>;
  exitFullscreen: ReturnType<typeof vi.fn>;
  readonly fullscreenElement: Element | null;
  restore(): void;
}

/** Installs a working Fullscreen API on document and HTMLElement.prototype. */
export function installFullscreenApi(): FullscreenApi {
  let fullscreenElement: Element | null = null;
  const enter = (el: Element): void => {
    fullscreenElement = el;
  };
  const requestFullscreen = vi.fn(function (this: Element) {
    enter(this);
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  const exitFullscreen = vi.fn(() => {
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
    configurable: true,
    value: requestFullscreen,
  });
  return {
    requestFullscreen,
    exitFullscreen,
    get fullscreenElement() {
      return fullscreenElement;
    },
    restore(): void {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    },
  };
}

/** Makes every <video> element created from here on use one shared play() mock. */
export function stubVideoPlay(): ReturnType<typeof vi.fn> {
  const playMock = vi.fn().mockResolvedValue(undefined);
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(
    (tag: string, opts?: ElementCreationOptions) => {
      const el = origCreate(tag, opts);
      if (tag === "video") {
        (el as HTMLVideoElement).play = playMock;
      }
      return el;
    },
  );
  return playMock;
}

/** Adds a tile whose audio belongs to `id`; `isScreenshare` picks the volume path. */
export function addAudioTile(
  grid: VideoGridComponent,
  id: number,
  name: string,
  isScreenshare: boolean,
): void {
  grid.addStream(
    id,
    name,
    fakeStream(),
    makeTileConfig({ isSelf: false, audioUserId: id, isScreenshare }),
  );
}
