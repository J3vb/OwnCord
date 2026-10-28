import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { expectConsole } from "../helpers/console";
import { registerVideoSurface } from "../../src/lib/videoSurface";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing VideoGrid
// ---------------------------------------------------------------------------

const mockMuteScreenshareAudio = vi.fn();
const mockSetScreenshareAudioVolume = vi.fn();
const mockSetUserVolume = vi.fn();
const mockGetScreenshareAudioMuted = vi.fn((_userId?: unknown) => false);
const mockGetScreenshareAudioVolume = vi.fn((_userId?: unknown) => 1);
const mockGetUserVolume = vi.fn((_userId?: unknown) => 100);
const mockGetUserLocalMute = vi.fn((_userId?: unknown) => false);
const mockSetUserLocalMute = vi.fn();

const mockShowToast = vi.hoisted(() => vi.fn());
vi.mock("@lib/toast", () => ({ showToast: mockShowToast }));

vi.mock("@lib/livekitSession", () => ({
  muteScreenshareAudio: (...args: unknown[]) => mockMuteScreenshareAudio(...args),
  setScreenshareAudioVolume: (...args: unknown[]) => mockSetScreenshareAudioVolume(...args),
  setUserVolume: (...args: unknown[]) => mockSetUserVolume(...args),
  getScreenshareAudioMuted: (userId: unknown) => mockGetScreenshareAudioMuted(userId),
  getScreenshareAudioVolume: (userId: unknown) => mockGetScreenshareAudioVolume(userId),
  getUserVolume: (userId: unknown) => mockGetUserVolume(userId),
  getUserLocalMute: (userId: unknown) => mockGetUserLocalMute(userId),
  setUserLocalMute: (...args: unknown[]) => mockSetUserLocalMute(...args),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  createVideoGrid,
  computeGridLayout,
  type VideoGridComponent,
  type TileConfig,
} from "../../src/components/VideoGrid";
import { RemoteTracks } from "../../src/features/voice/remoteTracks";
import { VideoQuality, type Room } from "livekit-client";
import type { ShareSenderSample } from "../../src/features/voice/shareSenderStats";

/** Minimal MediaStream stub for testing. */
function fakeStream(): MediaStream {
  return { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
}

/**
 * MediaStream stub with a controllable video track.
 * Allows testing track lifecycle (ended/mute events).
 */
function fakeStreamWithTrack(): {
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
function fakePopup() {
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

function makeTileConfig(overrides: Partial<TileConfig> = {}): TileConfig {
  return {
    isSelf: false,
    audioUserId: 42,
    isScreenshare: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VideoGrid", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

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

    container = document.createElement("div");
    grid = createVideoGrid();
    grid.mount(container);
  });

  afterEach(() => {
    grid.destroy?.();
  });

  it("mount creates a grid container with data-testid", () => {
    const root = container.querySelector("[data-testid='video-grid']");
    expect(root).not.toBeNull();
    expect(root!.classList.contains("video-grid")).toBe(true);
  });

  it("addStream creates video element and username label", () => {
    grid.addStream(1, "Alice", fakeStream());

    const cell = container.querySelector(".video-cell");
    expect(cell).not.toBeNull();
    expect(cell!.getAttribute("data-user-id")).toBe("1");

    const video = cell!.querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.muted).toBe(true);

    const label = cell!.querySelector(".video-username");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("Alice");
  });

  it("addStream replaces existing cell for same userId", () => {
    grid.addStream(1, "Alice", fakeStream());
    grid.addStream(1, "Alice-v2", fakeStream());

    const cells = container.querySelectorAll(".video-cell");
    expect(cells.length).toBe(1);
    expect(cells[0]!.querySelector(".video-username")!.textContent).toBe("Alice-v2");
  });

  it("removeStream removes the cell", () => {
    grid.addStream(1, "Alice", fakeStream());
    expect(container.querySelectorAll(".video-cell").length).toBe(1);

    grid.removeStream(1);
    expect(container.querySelectorAll(".video-cell").length).toBe(0);
  });

  it("removeStream nullifies video srcObject", () => {
    const stream = fakeStream();
    grid.addStream(1, "Alice", stream);

    const video = container.querySelector("video")!;
    expect(video.srcObject).toBe(stream);

    grid.removeStream(1);
    // Video was removed from DOM, but we can verify hasStreams is false
    expect(grid.hasStreams()).toBe(false);
  });

  it("hasStreams returns false when empty", () => {
    expect(grid.hasStreams()).toBe(false);
  });

  it("hasStreams returns true when streams are present", () => {
    grid.addStream(1, "Alice", fakeStream());
    expect(grid.hasStreams()).toBe(true);
  });

  describe("computeGridLayout — Discord-style tile sizing", () => {
    it("returns zero-sized tiles for 0 tile count", () => {
      const layout = computeGridLayout(800, 600, 0);
      expect(layout.tileW).toBe(0);
      expect(layout.tileH).toBe(0);
    });

    it("1 tile fills the container (width-constrained)", () => {
      // Wide container: tile should be width-limited
      const layout = computeGridLayout(800, 600, 1);
      expect(layout.cols).toBe(1);
      expect(layout.rows).toBe(1);
      expect(layout.tileW).toBeGreaterThan(0);
      expect(layout.tileH).toBeGreaterThan(0);
      // Verify 16:9 ratio (within 1px rounding)
      expect(Math.abs(layout.tileW / layout.tileH - 16 / 9)).toBeLessThan(0.1);
    });

    it("1 tile in a tall container is height-constrained", () => {
      // Tall container: tile should be height-limited
      const layout = computeGridLayout(400, 800, 1);
      expect(layout.cols).toBe(1);
      expect(layout.tileH).toBeLessThanOrEqual(800 - 16); // minus padding
    });

    it("2 tiles use 2 columns in a wide container", () => {
      const layout = computeGridLayout(1200, 400, 2);
      expect(layout.cols).toBe(2);
      expect(layout.rows).toBe(1);
    });

    it("4 tiles use 2x2 grid", () => {
      const layout = computeGridLayout(800, 600, 4);
      expect(layout.cols).toBe(2);
      expect(layout.rows).toBe(2);
    });

    it("all tiles fit within the container", () => {
      for (const count of [1, 2, 3, 4, 5, 6, 9, 10, 16]) {
        const layout = computeGridLayout(800, 600, count);
        const totalW = layout.cols * layout.tileW + (layout.cols - 1) * 4 + 16;
        const totalH = layout.rows * layout.tileH + (layout.rows - 1) * 4 + 16;
        expect(totalW).toBeLessThanOrEqual(800);
        expect(totalH).toBeLessThanOrEqual(600);
      }
    });

    it("tiles maintain approximately 16:9 aspect ratio", () => {
      for (const count of [1, 2, 4, 9]) {
        const layout = computeGridLayout(800, 600, count);
        if (layout.tileW === 0) continue;
        const ratio = layout.tileW / layout.tileH;
        expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.15);
      }
    });
  });

  it("destroy cleans up all elements", () => {
    grid.addStream(1, "Alice", fakeStream());
    grid.addStream(2, "Bob", fakeStream());

    grid.destroy?.();

    expect(container.querySelector(".video-grid")).toBeNull();
    expect(grid.hasStreams()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Autoplay / .play() tests (Bug fix: black window in WebView2)
  // -----------------------------------------------------------------------

  describe("video autoplay", () => {
    it("addStream calls .play() on the video element", () => {
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

      grid.addStream(1, "Alice", fakeStream());

      expect(playMock).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    });

    it("addStream calls .play() when replacing srcObject on existing tile", () => {
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

      const { stream: s1 } = fakeStreamWithTrack();
      const { stream: s2 } = fakeStreamWithTrack();

      grid.addStream(1, "Alice", s1);
      playMock.mockClear();

      // Different tracks → srcObject replaced → should call play again
      grid.addStream(1, "Alice", s2);
      expect(playMock).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    });
  });

  // -----------------------------------------------------------------------
  // Track lifecycle tests (Bug fix: stale black tiles)
  // -----------------------------------------------------------------------

  describe("track lifecycle", () => {
    it("hides a newly attached track that is already muted", () => {
      const { track, stream } = fakeStreamWithTrack();
      Object.defineProperty(track, "muted", { value: true });
      grid.addStream(1, "Alice", stream);
      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.classList.contains("track-muted")).toBe(true);
      track.dispatchEvent("unmute");
      expect(cell.classList.contains("track-muted")).toBe(false);
    });

    it("shows a replacement track after the previous stream was muted", () => {
      const old = fakeStreamWithTrack();
      grid.addStream(1, "Alice", old.stream);
      old.track.dispatchEvent("mute");
      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.classList.contains("track-muted")).toBe(true);

      const replacement = fakeStreamWithTrack();
      grid.addStream(1, "Alice", replacement.stream);
      expect(cell.classList.contains("track-muted")).toBe(false);
      expect(old.track.listeners["mute"]?.length ?? 0).toBe(0);
    });

    it("removes tile when video track fires 'ended' event", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(1, "Alice", stream);
      expect(grid.hasStreams()).toBe(true);

      track.dispatchEvent("ended");
      expect(grid.hasStreams()).toBe(false);
    });

    it("hides tile when video track fires 'mute' event (does not remove)", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(1, "Alice", stream);
      expect(grid.hasStreams()).toBe(true);

      track.dispatchEvent("mute");
      // Tile should still exist but have track-muted class
      expect(grid.hasStreams()).toBe(true);
      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.classList.contains("track-muted")).toBe(true);
    });

    it("restores tile when video track fires 'unmute' after mute", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(1, "Alice", stream);

      track.dispatchEvent("mute");
      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.classList.contains("track-muted")).toBe(true);

      track.dispatchEvent("unmute");
      expect(cell.classList.contains("track-muted")).toBe(false);
    });

    it("cleans up track listeners when tile is removed via removeStream", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(1, "Alice", stream);
      grid.removeStream(1);

      // Dispatching ended after removal should not throw or cause issues
      expect(() => track.dispatchEvent("ended")).not.toThrow();
      expect(grid.hasStreams()).toBe(false);
    });

    it("cleans up track listeners on destroy", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(1, "Alice", stream);
      grid.destroy!();

      // Verify listeners were removed
      expect(track.listeners["ended"]?.length ?? 0).toBe(0);
      expect(track.listeners["mute"]?.length ?? 0).toBe(0);
      expect(track.listeners["unmute"]?.length ?? 0).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // TileConfig / overlay / mute button tests (Spec 1)
  // -----------------------------------------------------------------------

  describe("tile overlay and audio controls", () => {
    it("addStream with isSelf=true does NOT render overlay", () => {
      const config = makeTileConfig({ isSelf: true });
      grid.addStream(1, "me (You)", fakeStream(), config);

      expect(container.querySelector(".video-tile-overlay")).toBeNull();
    });

    it("addStream with isSelf=false renders overlay and mute button", () => {
      const config = makeTileConfig({ isSelf: false });
      grid.addStream(42, "alice", fakeStream(), config);

      expect(container.querySelector(".video-tile-overlay")).not.toBeNull();
      expect(container.querySelector(".tile-mute-btn")).not.toBeNull();
    });

    it("mute button toggles screenshare audio when isScreenshare=true", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 99, isScreenshare: true });
      grid.addStream(99, "bob (Screen)", fakeStream(), config);

      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;

      muteBtn.click();
      expect(mockMuteScreenshareAudio).toHaveBeenCalledWith(99, true);

      muteBtn.click();
      expect(mockMuteScreenshareAudio).toHaveBeenCalledWith(99, false);
    });

    it("mute button toggles the user's local Mute when isScreenshare=false (WP 1D-5)", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 55, isScreenshare: false });
      grid.addStream(55, "charlie", fakeStream(), config);

      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;

      muteBtn.click();
      expect(mockSetUserLocalMute).toHaveBeenLastCalledWith(55, true);
      // The saved level is kept under the Mute, not overwritten with 0.
      expect(mockSetUserVolume).not.toHaveBeenCalledWith(55, 0);

      muteBtn.click();
      expect(mockSetUserLocalMute).toHaveBeenLastCalledWith(55, false);
    });

    it("a voice tile starts muted when the user is locally muted", () => {
      mockGetUserLocalMute.mockReturnValueOnce(true);
      const config = makeTileConfig({ isSelf: false, audioUserId: 56, isScreenshare: false });
      grid.addStream(56, "erin", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      expect(muteBtn.getAttribute("aria-label")).toBe("Unmute");
      // Shows the kept level until it is muted from here (as before).
      expect(slider.value).toBe("100");
    });

    it("a Mute set from the sidebar menu updates the open voice tile", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 57, isScreenshare: false });
      grid.addStream(57, "finn", fakeStream(), config);
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      expect(muteBtn.getAttribute("aria-label")).toBe("Mute");

      mockGetUserLocalMute.mockImplementation((id) => id === 57);
      window.dispatchEvent(
        new CustomEvent("owncord:user-local-mute-changed", { detail: { userId: 57 } }),
      );
      mockGetUserLocalMute.mockImplementation(() => false);

      expect(muteBtn.getAttribute("aria-label")).toBe("Unmute");
      expect((container.querySelector(".tile-volume-slider") as HTMLInputElement).value).toBe("0");
    });

    it("mute button icon swaps between volume and volume-x SVGs on click", () => {
      const config = makeTileConfig({ isSelf: false });
      grid.addStream(42, "alice", fakeStream(), config);

      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      const initialHtml = muteBtn.innerHTML;

      // Volume icon has polygon but no <line> elements
      expect(initialHtml).toContain("polygon");
      expect(initialHtml).not.toContain("<line");

      // Click to mute — should swap to volume-x icon with <line> elements
      muteBtn.click();
      expect(muteBtn.innerHTML).toContain("<line");

      // Click to unmute — should swap back to volume icon
      muteBtn.click();
      expect(muteBtn.innerHTML).not.toContain("<line");
    });

    it("mute button aria-label updates between Mute and Unmute", () => {
      const config = makeTileConfig({ isSelf: false });
      grid.addStream(42, "alice", fakeStream(), config);

      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;

      expect(muteBtn.getAttribute("aria-label")).toBe("Mute");

      muteBtn.click();
      expect(muteBtn.getAttribute("aria-label")).toBe("Unmute");

      muteBtn.click();
      expect(muteBtn.getAttribute("aria-label")).toBe("Mute");
    });

    it("addStream without config (backward compat) renders no overlay", () => {
      grid.addStream(42, "alice", fakeStream());

      const cell = container.querySelector(".video-cell");
      expect(cell).not.toBeNull();
      expect(container.querySelector(".video-tile-overlay")).toBeNull();
    });

    it("volume slider adjusts user volume for non-screenshare tiles", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 77, isScreenshare: false });
      grid.addStream(77, "dave", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      expect(slider).not.toBeNull();
      expect(slider.value).toBe("100"); // default

      // Slide to 50
      slider.value = "50";
      slider.dispatchEvent(new Event("input"));
      expect(mockSetUserVolume).toHaveBeenCalledWith(77, 50);
    });

    it("[B3-5] seeds the mic-tile slider from the persisted per-user volume, not a hardcoded 100%", () => {
      mockGetUserVolume.mockReturnValueOnce(30);
      const config = makeTileConfig({ isSelf: false, audioUserId: 88, isScreenshare: false });
      grid.addStream(88, "erin", fakeStream(), config);

      expect(mockGetUserVolume).toHaveBeenCalledWith(88);
      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      expect(slider.value).toBe("30");
      // Not muted at 30% — the mute button must reflect the real (unmuted) state.
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      expect(muteBtn.getAttribute("aria-label")).toBe("Mute");
    });

    it("[B3-5] starts a mic tile muted when the persisted per-user volume is 0", () => {
      mockGetUserVolume.mockReturnValueOnce(0);
      const config = makeTileConfig({ isSelf: false, audioUserId: 89, isScreenshare: false });
      grid.addStream(89, "frank", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      expect(slider.value).toBe("0");
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      expect(muteBtn.getAttribute("aria-label")).toBe("Unmute");
      const overlay = container.querySelector(".video-tile-overlay");
      expect(overlay!.classList.contains("muted")).toBe(true);
    });

    it("volume slider at 0 triggers mute icon swap and calls setUserVolume(0)", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 77, isScreenshare: false });
      grid.addStream(77, "dave", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;

      // Slide to 0
      slider.value = "0";
      slider.dispatchEvent(new Event("input"));

      expect(mockSetUserVolume).toHaveBeenCalledWith(77, 0);
      // Mute icon should change
      expect(muteBtn.getAttribute("aria-label")).toBe("Unmute");

      // Overlay should have muted class
      const overlay = container.querySelector(".video-tile-overlay");
      expect(overlay!.classList.contains("muted")).toBe(true);
    });

    it("volume slider for screenshare tiles calls muteScreenshareAudio", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 88, isScreenshare: true });
      grid.addStream(88, "screen", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;

      // Slide to 0 — should mute screenshare
      slider.value = "0";
      slider.dispatchEvent(new Event("input"));
      expect(mockMuteScreenshareAudio).toHaveBeenCalledWith(88, true);

      // Slide to 100 — should unmute screenshare
      slider.value = "100";
      slider.dispatchEvent(new Event("input"));
      expect(mockMuteScreenshareAudio).toHaveBeenCalledWith(88, false);
    });

    it("screenshare slider uses 0-100 range where 100 maps to volume 1.0", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 88, isScreenshare: true });
      grid.addStream(88, "screen", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      expect(slider.max).toBe("100");
      expect(slider.value).toBe("100"); // stored default 1.0 → 100

      slider.value = "50";
      slider.dispatchEvent(new Event("input"));
      expect(mockSetScreenshareAudioVolume).toHaveBeenCalledWith(88, 0.5);

      slider.value = "100";
      slider.dispatchEvent(new Event("input"));
      expect(mockSetScreenshareAudioVolume).toHaveBeenCalledWith(88, 1);
    });

    it("screenshare slider initializes from stored volume and mute state", () => {
      mockGetScreenshareAudioVolume.mockReturnValueOnce(0.3);
      mockGetScreenshareAudioMuted.mockReturnValueOnce(true);
      const config = makeTileConfig({ isSelf: false, audioUserId: 88, isScreenshare: true });
      grid.addStream(88, "screen", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      const overlay = container.querySelector(".video-tile-overlay");
      expect(slider.value).toBe("30");
      expect(muteBtn.getAttribute("aria-label")).toBe("Unmute");
      expect(overlay!.classList.contains("muted")).toBe(true);
    });

    it("mic slider tops out at 200% (WP 1D-5)", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 77, isScreenshare: false });
      grid.addStream(77, "dave", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      expect(slider.max).toBe("200");
    });

    it("mute button unmutes with previous volume when currentVolume was non-zero", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 77, isScreenshare: false });
      grid.addStream(77, "dave", fakeStream(), config);

      const slider = container.querySelector(".tile-volume-slider") as HTMLInputElement;
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;

      // Set volume to 70 via slider
      slider.value = "70";
      slider.dispatchEvent(new Event("input"));
      mockSetUserVolume.mockClear();

      // Mute via button: the local Mute, the slider shows 0
      muteBtn.click();
      expect(mockSetUserLocalMute).toHaveBeenLastCalledWith(77, true);
      expect(slider.value).toBe("0");

      // Unmute via button — should restore to 70
      muteBtn.click();
      expect(mockSetUserLocalMute).toHaveBeenLastCalledWith(77, false);
      expect(slider.value).toBe("70");
    });
  });

  // -----------------------------------------------------------------------
  // Stream type attribute tests (Spec 3 — video scaling)
  // -----------------------------------------------------------------------

  describe("data-stream-type attribute", () => {
    it("sets data-stream-type='screenshare' when isScreenshare is true", () => {
      const config = makeTileConfig({ isScreenshare: true });
      grid.addStream(1, "Alice (Screen)", fakeStream(), config);

      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.dataset.streamType).toBe("screenshare");
    });

    it("sets data-stream-type='camera' when isScreenshare is false", () => {
      const config = makeTileConfig({ isScreenshare: false });
      grid.addStream(1, "Alice", fakeStream(), config);

      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.dataset.streamType).toBe("camera");
    });

    it("defaults data-stream-type='camera' when no config is provided", () => {
      grid.addStream(1, "Alice", fakeStream());

      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.dataset.streamType).toBe("camera");
    });

    it("preserves data-stream-type when stream is updated in-place", () => {
      const config = makeTileConfig({ isScreenshare: true });
      grid.addStream(1, "Alice (Screen)", fakeStream(), config);

      // Update stream (same userId)
      grid.addStream(1, "Alice (Screen) v2", fakeStream(), config);

      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.dataset.streamType).toBe("screenshare");
    });

    it("syncs data-stream-type when stream type changes on in-place update", () => {
      const cameraConfig = makeTileConfig({ isScreenshare: false });
      grid.addStream(1, "Alice", fakeStream(), cameraConfig);

      const cell = container.querySelector(".video-cell") as HTMLElement;
      expect(cell.dataset.streamType).toBe("camera");

      // Re-add same userId as screenshare
      const screenConfig = makeTileConfig({ isScreenshare: true });
      grid.addStream(1, "Alice (Screen)", fakeStream(), screenConfig);

      expect(cell.dataset.streamType).toBe("screenshare");
    });
  });

  describe("your own camera is mirrored", () => {
    /** Whether the cascaded transform for `selector` is exactly scaleX(-1). */
    function mirrored(selector: string): boolean {
      const d = cascadedDeclaration(selector, "transform")?.value;
      if (d?.property !== "transform") return false;
      const fns = d.value as ReadonlyArray<{ type: string; value?: unknown }>;
      const only = fns.length === 1 ? fns[0] : undefined;
      return (
        only?.type === "scaleX" &&
        JSON.stringify(only.value) === JSON.stringify({ type: "number", value: -1 })
      );
    }

    it("marks your own camera tile, and neither a screen share nor someone else's camera", () => {
      grid.addStream(1, "You", fakeStream(), makeTileConfig({ isSelf: true }));
      grid.addStream(
        2,
        "Your screen",
        fakeStream(),
        makeTileConfig({ isSelf: true, isScreenshare: true }),
      );
      grid.addStream(3, "Alice", fakeStream(), makeTileConfig());

      const cell = (id: number): HTMLElement =>
        container.querySelector(`.video-cell[data-user-id="${id}"]`) as HTMLElement;
      expect(cell(1).classList.contains("video-cell--self")).toBe(true);
      expect(cell(2).classList.contains("video-cell--self")).toBe(false);
      expect(cell(3).classList.contains("video-cell--self")).toBe(false);
    });

    it("drops the mirror when a tile is re-used for a screen share", () => {
      grid.addStream(1, "You", fakeStream(), makeTileConfig({ isSelf: true }));
      grid.addStream(
        1,
        "Your screen",
        fakeStream(),
        makeTileConfig({ isSelf: true, isScreenshare: true }),
      );
      const cell = container.querySelector('.video-cell[data-user-id="1"]') as HTMLElement;
      expect(cell.classList.contains("video-cell--self")).toBe(false);
    });

    it("flips the self tile's video and the settings camera preview horizontally", () => {
      expect(mirrored(".video-cell--self video")).toBe(true);
      expect(mirrored(".camera-preview video")).toBe(true);
      expect(mirrored(".video-cell video")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Focus mode tests (Spec 2)
  // -----------------------------------------------------------------------

  describe("focus mode", () => {
    it("setFocusedTile creates focus layout with main and strip areas", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      const mainArea = container.querySelector(".video-focus-main");
      const stripArea = container.querySelector(".video-focus-strip");
      expect(mainArea).not.toBeNull();
      expect(stripArea).not.toBeNull();

      // Focused tile should be in main area
      const focusedCell = mainArea!.querySelector('[data-user-id="1"]');
      expect(focusedCell).not.toBeNull();
      expect(focusedCell!.classList.contains("focused")).toBe(true);

      // Other tile should be in strip area
      const thumbCell = stripArea!.querySelector('[data-user-id="2"]');
      expect(thumbCell).not.toBeNull();
      expect(thumbCell!.classList.contains("thumb")).toBe(true);
    });

    it("clicking a thumbnail switches focus", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      // Click the second tile (thumbnail in strip)
      const thumbCell = container.querySelector('[data-user-id="2"]') as HTMLElement;
      expect(thumbCell).not.toBeNull();
      thumbCell.click();

      // Now tile 2 should be focused in main area
      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea).not.toBeNull();
      const newFocused = mainArea!.querySelector('[data-user-id="2"]');
      expect(newFocused).not.toBeNull();
      expect(newFocused!.classList.contains("focused")).toBe(true);

      // Tile 1 should now be a thumbnail
      const stripArea = container.querySelector(".video-focus-strip");
      expect(stripArea).not.toBeNull();
      const oldFocused = stripArea!.querySelector('[data-user-id="1"]');
      expect(oldFocused).not.toBeNull();
      expect(oldFocused!.classList.contains("thumb")).toBe(true);
    });

    it("removeStream auto-focuses next tile when focused tile is removed", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      grid.removeStream(1);

      // Remaining tile 2 should become focused
      expect(grid.getFocusedTileId()).toBe(2);
    });

    it("removeStream clears focus when last tile removed", () => {
      grid.addStream(1, "Alice", fakeStream());

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      grid.removeStream(1);

      // Focus cleared — no focus-mode class
      expect(grid.getFocusedTileId()).toBeNull();
      const root = container.querySelector(".video-grid");
      expect(root!.classList.contains("focus-mode")).toBe(false);
    });

    it("getFocusedTileId returns correct value", () => {
      grid.addStream(1, "Alice", fakeStream());

      expect(grid.getFocusedTileId()).toBeNull();

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);
    });

    it("focus-mode class is added to root when a tile is focused", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      const root = container.querySelector(".video-grid") as HTMLElement;
      expect(root.classList.contains("focus-mode")).toBe(false);

      grid.setFocusedTile(1);
      expect(root.classList.contains("focus-mode")).toBe(true);
    });

    it("strip area not shown when only one tile is focused (no thumbnails)", () => {
      grid.addStream(1, "Alice", fakeStream());

      grid.setFocusedTile(1);

      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea).not.toBeNull();
      // Only one tile — no strip should be rendered
      const stripArea = container.querySelector(".video-focus-strip");
      expect(stripArea).toBeNull();
    });

    it("clicking mute button on a focused tile does not switch focus", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 1, isScreenshare: false });
      grid.addStream(1, "Alice", fakeStream(), config);
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      // Click the mute button on Alice's tile
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      muteBtn.click();

      // Focus should remain on tile 1
      expect(grid.getFocusedTileId()).toBe(1);
    });

    it("adding a stream during focus mode preserves focus layout", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      // Add a third stream
      grid.addStream(3, "Charlie", fakeStream());

      // Focus should still be on tile 1
      expect(grid.getFocusedTileId()).toBe(1);

      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea).not.toBeNull();
      expect(mainArea!.querySelector('[data-user-id="1"]')).not.toBeNull();

      // Both Bob and Charlie should be in strip
      const stripArea = container.querySelector(".video-focus-strip");
      expect(stripArea).not.toBeNull();
      expect(stripArea!.querySelectorAll(".video-cell").length).toBe(2);
    });

    it("focused cell retains data-stream-type attribute in focus layout", () => {
      const config = makeTileConfig({ isScreenshare: true });
      grid.addStream(1, "Alice (Screen)", fakeStream(), config);
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      const mainArea = container.querySelector(".video-focus-main");
      const focusedCell = mainArea!.querySelector(".video-cell") as HTMLElement;
      expect(focusedCell.dataset.streamType).toBe("screenshare");
    });

    it("thumbnail cells retain data-stream-type attribute in strip", () => {
      const cameraConfig = makeTileConfig({ isScreenshare: false });
      grid.addStream(1, "Alice", fakeStream(), cameraConfig);

      const screenConfig = makeTileConfig({ isScreenshare: true });
      grid.addStream(2, "Bob (Screen)", fakeStream(), screenConfig);

      grid.setFocusedTile(2);

      const stripArea = container.querySelector(".video-focus-strip");
      const thumbCell = stripArea!.querySelector(".video-cell") as HTMLElement;
      expect(thumbCell.dataset.streamType).toBe("camera");
    });

    it("removing non-focused tile preserves current focus", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());
      grid.addStream(3, "Charlie", fakeStream());

      grid.setFocusedTile(1);
      grid.removeStream(3);

      expect(grid.getFocusedTileId()).toBe(1);
      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea!.querySelector('[data-user-id="1"]')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // clearStreams (B1-8: stale remote tiles survive join -> leave -> join)
  // -----------------------------------------------------------------------

  describe("clearStreams", () => {
    it("removes every tile", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());
      expect(grid.hasStreams()).toBe(true);

      grid.clearStreams();

      expect(grid.hasStreams()).toBe(false);
      expect(container.querySelectorAll(".video-cell").length).toBe(0);
    });

    it("clears focus state along with the tiles", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      grid.clearStreams();

      expect(grid.getFocusedTileId()).toBeNull();
    });

    it("cleans up track listeners for every cell", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(1, "Alice", stream);

      grid.clearStreams();

      expect(track.listeners["ended"]?.length ?? 0).toBe(0);
    });

    it("is a no-op on an empty grid", () => {
      expect(() => grid.clearStreams()).not.toThrow();
      expect(grid.hasStreams()).toBe(false);
    });
  });

  describe("people without a camera (avatar tiles)", () => {
    const person = (userId: number, label: string) => {
      const content = document.createElement("div");
      content.className = "test-avatar";
      return { userId, label, content };
    };
    const avatarTiles = () => [...container.querySelectorAll<HTMLElement>(".video-cell--avatar")];

    it("draws an avatar tile, with the host's content and a name, for each person", () => {
      const otto = person(2, "Otto");
      grid.setPeople([otto, person(1, "You")]);

      const tiles = avatarTiles();
      expect(tiles.map((t) => t.dataset.personId)).toEqual(["2", "1"]);
      expect(tiles[0]!.contains(otto.content)).toBe(true);
      expect(tiles[0]!.querySelector(".video-username")!.textContent).toBe("Otto");
    });

    it("puts streams first, and hides a person's avatar while their camera tile is up", () => {
      grid.setPeople([person(2, "Otto"), person(1, "You")]);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));

      expect(avatarTiles().map((t) => t.dataset.personId)).toEqual(["1"]);
      const cells = [...container.querySelectorAll(".video-cell")];
      expect(cells[0]!.getAttribute("data-user-id")).toBe("2");

      grid.removeStream(2);
      expect(avatarTiles().map((t) => t.dataset.personId)).toEqual(["2", "1"]);
    });

    it("keeps a person's avatar beside their screen share: only a camera replaces it", () => {
      grid.setPeople([person(2, "Otto")]);
      grid.addStream(2 + 1_000_000, "Otto's screen", fakeStream(), {
        isSelf: false,
        audioUserId: 2,
        isScreenshare: true,
      });
      expect(avatarTiles().map((t) => t.dataset.personId)).toEqual(["2"]);
    });

    it("does not count people as streams", () => {
      grid.setPeople([person(2, "Otto")]);
      expect(grid.hasStreams()).toBe(false);
    });

    it("reuses a person's tile across updates, and drops people who left", () => {
      const otto = person(2, "Otto");
      grid.setPeople([otto, person(3, "Sam")]);
      const before = avatarTiles()[0];

      grid.setPeople([otto]);
      expect(avatarTiles()).toHaveLength(1);
      expect(avatarTiles()[0]).toBe(before);
    });

    it("clears every avatar tile when the host stops drawing people", () => {
      grid.setPeople([person(2, "Otto")]);
      grid.setPeople([]);
      expect(avatarTiles()).toHaveLength(0);
    });

    it("rings the avatar tile of a person speaking, and only theirs", () => {
      grid.setPeople([person(2, "Otto"), person(3, "Sam")]);
      grid.setSpeaking(new Set([2]));

      const [otto, sam] = avatarTiles();
      expect(otto!.classList.contains("video-cell--speaking")).toBe(true);
      expect(sam!.classList.contains("video-cell--speaking")).toBe(false);

      grid.setSpeaking(new Set());
      expect(otto!.classList.contains("video-cell--speaking")).toBe(false);
    });

    it("rings a person's avatar tile drawn after they started speaking", () => {
      grid.setSpeaking(new Set([2]));
      grid.setPeople([person(2, "Otto")]);
      expect(avatarTiles()[0]!.classList.contains("video-cell--speaking")).toBe(true);
    });

    it("badges a muted or deafened person's avatar tile", () => {
      grid.setPeople([person(2, "Otto"), person(3, "Sam")]);
      grid.setUserAudioState(new Map([[3, { muted: true, deafened: true }]]));

      const [otto, sam] = avatarTiles();
      expect(otto!.querySelector("[data-testid='tile-audio-state']")).toBeNull();
      const badge = sam!.querySelector("[data-testid='tile-audio-state']");
      expect(badge!.classList.contains("video-cell__audio--deafened")).toBe(true);

      grid.setUserAudioState(new Map());
      expect(sam!.querySelector("[data-testid='tile-audio-state']")).toBeNull();
    });

    it("adds no ring or badge to a person whose host marks their state itself", () => {
      grid.setPeople([{ ...person(2, "Otto"), marksOwnState: true }]);
      grid.setSpeaking(new Set([2]));
      grid.setUserAudioState(new Map([[2, { muted: true, deafened: false }]]));

      const tile = avatarTiles()[0]!;
      expect(tile.classList.contains("video-cell--speaking")).toBe(false);
      expect(tile.querySelector("[data-testid='tile-audio-state']")).toBeNull();
    });
  });

  describe("tile interaction and labelling (PR 3)", () => {
    const SCREEN = 2 + 1_000_000;
    const screen = (overrides: Partial<TileConfig> = {}): TileConfig => ({
      isSelf: false,
      audioUserId: 2,
      isScreenshare: true,
      name: "Otto",
      ...overrides,
    });
    const camera = (overrides: Partial<TileConfig> = {}): TileConfig => ({
      isSelf: false,
      audioUserId: 3,
      isScreenshare: false,
      name: "Sam",
      ...overrides,
    });
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const select = (id: number) => cell(id).querySelector<HTMLButtonElement>(".video-cell-select")!;

    it("makes each tile a named button that opens it in focus view", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      const btn = select(SCREEN);
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.getAttribute("aria-label")).toBe("Watch Otto (Screen)");
      btn.click();

      expect(grid.getFocusedTileId()).toBe(SCREEN);
      expect(cell(SCREEN).classList.contains("focused")).toBe(true);
      // The focused tile needs no "watch" button; the filmstrip thumbs keep theirs.
      expect(select(SCREEN).hidden).toBe(true);
      expect(select(3).hidden).toBe(false);
      select(3).click();
      expect(grid.getFocusedTileId()).toBe(3);
    });

    it("offers Back to grid in focus view, which leaves it", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());
      expect(cell(SCREEN).querySelector<HTMLElement>("[data-tile-control='grid']")!.hidden).toBe(
        true,
      );

      select(SCREEN).click();
      const back = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='grid']")!;
      expect(back.getAttribute("aria-label")).toBe("Back to grid");
      back.click();

      expect(grid.getFocusedTileId()).toBeNull();
      expect(container.querySelector(".video-grid.focus-mode")).toBeNull();
    });

    it("exposes a header control that leaves focus/grid mode and is keyboard reachable", () => {
      // Focus mode pinned a watched peer with no way back once the focused
      // tile's own nav was scrolled off (and an empty grid could cover chat
      // with no control at all). A header button always offers the exit.
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      const exit = container.querySelector<HTMLButtonElement>("[data-tile-control='exit-grid']");
      expect(exit).not.toBeNull();
      expect(exit!.tagName).toBe("BUTTON");
      expect(exit!.getAttribute("aria-label")).toBe("Show chat");

      select(SCREEN).click();
      expect(container.querySelector(".video-grid.focus-mode")).not.toBeNull();

      exit!.click();
      expect(grid.getFocusedTileId()).toBeNull();
      expect(container.querySelector(".video-grid.focus-mode")).toBeNull();
    });

    it("marks screen shares LIVE, and cameras not", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());
      expect(cell(SCREEN).querySelector(".video-live")!.textContent).toBe("LIVE");
      expect(cell(3).querySelector(".video-live")).toBeNull();
    });

    it("rings the camera tile of whoever is speaking, not their screen share", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(2, "Otto", fakeStream(), camera({ audioUserId: 2, name: "Otto" }));

      grid.setSpeaking(new Set([2]));
      expect(cell(2).classList.contains("video-cell--speaking")).toBe(true);
      expect(cell(SCREEN).classList.contains("video-cell--speaking")).toBe(false);

      grid.setSpeaking(new Set());
      expect(cell(2).classList.contains("video-cell--speaking")).toBe(false);
    });

    describe("viewer badge (6.6b)", () => {
      const badge = (id: number) =>
        cell(id).querySelector<HTMLElement>("[data-testid='tile-viewers']");

      it("is hidden at zero viewers and absent from cameras", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        grid.addStream(3, "Sam", fakeStream(), camera());
        // Stopped (not played here): no "You", and nobody else watching.
        grid.setStreamViewers(new Map());
        expect(badge(SCREEN)!.hidden).toBe(true);
        expect(badge(3)).toBeNull();
      });

      it("shows the count and lists the names on hover and to screen readers", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        grid.setStreamViewers(new Map([[2, ["Ann", "Bob"]]]));
        const el = badge(SCREEN)!;
        expect(el.hidden).toBe(false);
        expect(el.querySelector(".video-viewers__count")!.textContent).toBe("2");
        expect(el.title).toBe("Watching: Ann, Bob");
        expect(el.getAttribute("aria-label")).toBe("Watching: Ann, Bob");
        expect(cell(SCREEN).classList.contains("video-cell--has-viewers")).toBe(true);
      });

      it("updates live and hides again when the viewers go", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        grid.setStreamViewers(new Map([[2, ["Ann"]]]));
        grid.setStreamViewers(new Map([[2, ["Ann", "Bob", "Cy"]]]));
        expect(badge(SCREEN)!.querySelector(".video-viewers__count")!.textContent).toBe("3");
        grid.setStreamViewers(new Map());
        expect(badge(SCREEN)!.hidden).toBe(true);
        expect(cell(SCREEN).classList.contains("video-cell--has-viewers")).toBe(false);
      });

      it("adds You while the remote share plays here, and drops it when stopped", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
        grid.setStreamViewers(new Map([[2, ["Ann"]]]));
        expect(badge(SCREEN)!.title).toBe("Watching: You, Ann");
        cell(SCREEN).querySelector<HTMLElement>("[data-tile-control='stop']")!.click();
        expect(badge(SCREEN)!.title).toBe("Watching: Ann");
      });

      it("shows on your own share tile without You", () => {
        grid.addStream(
          SCREEN,
          "Me (Screen)",
          fakeStream(),
          screen({ isSelf: true, audioUserId: 1, name: "Me" }),
        );
        grid.setStreamViewers(new Map([[1, ["Ann"]]]));
        expect(badge(SCREEN)!.title).toBe("Watching: Ann");
      });

      it("caps the list at ten names and counts the rest", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        const names = Array.from({ length: 13 }, (_, i) => `U${String(i + 1)}`);
        grid.setStreamViewers(new Map([[2, names]]));
        expect(badge(SCREEN)!.querySelector(".video-viewers__count")!.textContent).toBe("13");
        expect(badge(SCREEN)!.title).toBe(
          "Watching: U1, U2, U3, U4, U5, U6, U7, U8, U9, U10 and 3 more",
        );
      });
    });

    it("marks a muted/deafened peer on their camera tile, and clears it", () => {
      grid.addStream(2, "Otto", fakeStream(), camera({ audioUserId: 2, name: "Otto" }));

      grid.setUserAudioState(new Map([[2, { muted: true, deafened: false }]]));
      const badge = cell(2).querySelector<HTMLElement>("[data-testid='tile-audio-state']")!;
      expect(badge).not.toBeNull();
      expect(badge.classList.contains("video-cell__audio--muted")).toBe(true);

      grid.setUserAudioState(new Map([[2, { muted: true, deafened: true }]]));
      expect(badge.classList.contains("video-cell__audio--deafened")).toBe(true);

      grid.setUserAudioState(new Map());
      expect(cell(2).querySelector("[data-testid='tile-audio-state']")).toBeNull();
    });

    it("names the volume slider for whose stream or voice it is, and shows its value", () => {
      mockGetScreenshareAudioVolume.mockReturnValueOnce(0.65);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      const streamSlider = cell(SCREEN).querySelector<HTMLInputElement>(".tile-volume-slider")!;
      expect(streamSlider.getAttribute("aria-label")).toBe("Otto stream volume");
      expect(streamSlider.getAttribute("aria-valuetext")).toBe("65%");
      const out = cell(SCREEN).querySelector("output")!;
      expect(out.textContent).toBe("65%");

      streamSlider.value = "40";
      streamSlider.dispatchEvent(new Event("input"));
      expect(out.textContent).toBe("40%");
      expect(streamSlider.getAttribute("aria-valuetext")).toBe("40%");

      const voiceSlider = cell(3).querySelector<HTMLInputElement>(".tile-volume-slider")!;
      expect(voiceSlider.getAttribute("aria-label")).toBe("Sam voice volume");
    });

    it("opens a context menu that keeps the stream and voice volumes apart", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      expect(menu).not.toBeNull();
      expect(menu.getAttribute("role")).toBe("menu");
      const stream = menu.querySelector<HTMLInputElement>("[data-menu-volume='stream']")!;
      const voice = menu.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!;
      expect(stream.getAttribute("aria-label")).toBe("Otto stream volume");
      expect(stream.max).toBe("100");
      expect(voice.getAttribute("aria-label")).toBe("Otto voice volume");
      expect(voice.max).toBe("200");

      voice.value = "70";
      voice.dispatchEvent(new Event("input"));
      expect(mockSetUserVolume).toHaveBeenCalledWith(2, 70);
      stream.value = "30";
      stream.dispatchEvent(new Event("input"));
      expect(mockSetScreenshareAudioVolume).toHaveBeenCalledWith(2, 0.3);

      const labels = [...menu.querySelectorAll("[role='menuitem']")].map((m) => m.textContent);
      expect(labels).toEqual(expect.arrayContaining(["Mute stream", "Stop watching"]));
      menu.remove();
    });

    it("raising the menu's voice slider clears that user's Mute", async () => {
      mockGetUserLocalMute.mockReturnValue(true);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      const voice = menu.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!;
      voice.value = "120";
      voice.dispatchEvent(new Event("input"));

      expect(mockSetUserVolume).toHaveBeenCalledWith(2, 120);
      expect(mockSetUserLocalMute).toHaveBeenLastCalledWith(2, false);
      mockGetUserLocalMute.mockReturnValue(false);
      menu.remove();
    });

    it("Unmute stream in the menu brings a stream muted at 0 back at 100%", async () => {
      mockGetScreenshareAudioMuted.mockReturnValue(true);
      mockGetScreenshareAudioVolume.mockReturnValue(0);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      const unmute = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
        (m) => m.textContent === "Unmute stream",
      )!;
      unmute.click();

      expect(mockSetScreenshareAudioVolume).toHaveBeenLastCalledWith(2, 1);
      expect(mockMuteScreenshareAudio).toHaveBeenLastCalledWith(2, false);
      expect(cell(SCREEN).querySelector("output")!.textContent).toBe("100%");
      expect(cell(SCREEN).querySelector(".video-tile-overlay")!.classList.contains("muted")).toBe(
        false,
      );
    });

    it("opens the same menu from the keyboard (Shift+F10) on the tile's button", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      select(SCREEN).dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      );
      await vi.dynamicImportSettled();
      const menu = document.querySelector(".video-tile-menu");
      expect(menu).not.toBeNull();
      menu!.remove();
    });

    it("Stop watching hides the stream behind a Watch button, and Watch brings it back", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      const stop = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='stop']")!;
      expect(stop.getAttribute("aria-label")).toBe("Stop watching");
      stop.click();

      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      expect(cell(SCREEN).querySelector("video")!.hidden).toBe(true);
      // Hidden locally only: the stream is still there.
      expect(grid.hasStreams()).toBe(true);

      const watch = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='watch']")!;
      expect(watch.textContent).toBe("Watch stream");
      watch.click();
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      expect(cell(SCREEN).querySelector("video")!.hidden).toBe(false);
    });

    it("covers your own screen share with what is going out, Stop sharing and Hide preview", () => {
      const onStopSharing = vi.fn();
      grid.setCallbacks({ onStopSharing });
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: true,
      });
      const self = cell(1 + 1_000_000);
      const cover = self.querySelector<HTMLElement>(".video-self-cover")!;
      expect(cover).not.toBeNull();
      expect(cover.textContent).toContain("You're sharing your screen");
      // No volume or stop-watching controls on your own preview.
      expect(self.querySelector(".tile-volume-slider")).toBeNull();

      cover.querySelector<HTMLButtonElement>("[data-tile-control='stop-sharing']")!.click();
      expect(onStopSharing).toHaveBeenCalledTimes(1);

      cover.querySelector<HTMLButtonElement>("[data-tile-control='hide-preview']")!.click();
      expect(self.classList.contains("video-cell--stopped")).toBe(true);
      const show = self.querySelector<HTMLButtonElement>("[data-tile-control='watch']")!;
      expect(show.textContent).toBe("Show preview");
    });

    it("says whether your screen share is sending audio", () => {
      const self = { isSelf: true, audioUserId: 1, isScreenshare: true };
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), { ...self, hasAudio: true });
      expect(cell(1 + 1_000_000).querySelector(".video-self-detail")!.textContent).toBe(
        "With audio",
      );
      grid.removeStream(1 + 1_000_000);
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), self);
      expect(cell(1 + 1_000_000).querySelector(".video-self-detail")!.textContent).toBe("No audio");
    });

    it("hands focus to Back to grid when a tile opens, and back to the tile after", () => {
      document.body.appendChild(container);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      select(SCREEN).focus();
      select(SCREEN).click();
      const back = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='grid']")!;
      expect(document.activeElement).toBe(back);

      back.click();
      expect(document.activeElement).toBe(select(SCREEN));
      container.remove();
    });

    it("Watch stream on a filmstrip thumb hands focus to the thumb, not its hidden controls", () => {
      document.body.appendChild(container);
      // The filmstrip's CSS hides a thumb's tile controls.
      const proto = HTMLElement.prototype as { checkVisibility?: () => boolean };
      proto.checkVisibility = function (this: HTMLElement) {
        return this.closest(".video-focus-strip .video-tile-nav") === null;
      };
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
        grid.addStream(3, "Sam", fakeStream(), camera());
        cell(3).querySelector<HTMLButtonElement>("[data-tile-control='stop']")!.click();
        grid.setFocusedTile(SCREEN);

        cell(3).querySelector<HTMLButtonElement>("[data-tile-control='watch']")!.click();
        expect(document.activeElement).toBe(select(3));
      } finally {
        delete proto.checkVisibility;
        container.remove();
      }
    });

    it("removing a tile closes its menu and drops its menu listeners", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      const removed = cell(SCREEN);
      removed.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.dynamicImportSettled();
      expect(document.querySelector(".video-tile-menu")).not.toBeNull();

      grid.removeStream(SCREEN);
      expect(document.querySelector(".video-tile-menu")).toBeNull();

      removed.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      removed
        .querySelector(".video-cell-select")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
      await vi.dynamicImportSettled();
      expect(document.querySelector(".video-tile-menu")).toBeNull();
    });

    it("opens no menu for a tile removed while the menu was loading", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      grid.removeStream(SCREEN);
      await vi.dynamicImportSettled();
      expect(document.querySelector(".video-tile-menu")).toBeNull();
    });

    it("keeps the tile menu inside the window", async () => {
      const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
      const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(220);
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
        cell(SCREEN).dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: window.innerWidth - 4,
            clientY: window.innerHeight - 4,
          }),
        );
        await vi.dynamicImportSettled();

        const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
        expect(menu.style.left).toBe(`${window.innerWidth - 200 - 8}px`);
        expect(menu.style.top).toBe(`${window.innerHeight - 220 - 8}px`);
        menu.remove();
      } finally {
        width.mockRestore();
        height.mockRestore();
      }
    });

    it("Show preview hands focus to Hide preview on your own screen share", () => {
      document.body.appendChild(container);
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: true,
      });
      const self = cell(1 + 1_000_000);
      self.querySelector<HTMLButtonElement>("[data-tile-control='hide-preview']")!.click();
      self.querySelector<HTMLButtonElement>("[data-tile-control='watch']")!.click();

      expect(document.activeElement).toBe(self.querySelector("[data-tile-control='hide-preview']"));
      container.remove();
    });

    it("keeps the person's other tile in step with a voice volume set from a tile menu", async () => {
      const otto = { audioUserId: 2, name: "Otto" };
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(2, "Otto", fakeStream(), camera(otto));
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      const voice = menu.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!;
      voice.value = "70";
      voice.dispatchEvent(new Event("input"));

      expect(cell(2).querySelector("output")!.textContent).toBe("70%");
      // The screen-share tile's own slider is the stream volume, not the voice.
      expect(cell(SCREEN).querySelector("output")!.textContent).toBe("100%");
      // Mute then unmute on the camera tile keeps the 70, not a stale 100.
      const mute = cell(2).querySelector<HTMLButtonElement>(".tile-mute-btn")!;
      mute.click();
      mute.click();
      expect(mockSetUserVolume).toHaveBeenLastCalledWith(2, 70);
      menu.remove();
    });

    it("renames the tile's controls and menu with the person (setLabel)", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.setLabel(SCREEN, "Ottilie (Screen)", "Ottilie");

      expect(cell(SCREEN).querySelector(".video-username")!.textContent).toBe("Ottilie (Screen)");
      expect(select(SCREEN).getAttribute("aria-label")).toBe("Watch Ottilie (Screen)");
      expect(cell(SCREEN).querySelector(".tile-volume-slider")!.getAttribute("aria-label")).toBe(
        "Ottilie stream volume",
      );

      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();
      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      expect(menu.getAttribute("aria-label")).toBe("Ottilie");
      expect(menu.querySelector("[data-menu-volume='voice']")!.getAttribute("aria-label")).toBe(
        "Ottilie voice volume",
      );
      menu.remove();
    });
  });

  describe("opt-in watching (Discord-style)", () => {
    const SCREEN = 2 + 1_000_000;
    const screen: TileConfig = { isSelf: false, audioUserId: 2, isScreenshare: true, name: "Otto" };
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const control = (id: number, name: string) =>
      cell(id).querySelector<HTMLButtonElement>(`[data-tile-control='${name}']`)!;
    let setStreamWatched: ReturnType<typeof vi.fn<(tileId: number, watched: boolean) => void>>;

    beforeEach(() => {
      document.body.appendChild(container);
      setStreamWatched = vi.fn();
      grid.setCallbacks({ setStreamWatched });
    });

    afterEach(() => {
      container.remove();
    });

    it("offers a published stream nobody watches as a tile with Watch stream, playing nothing", () => {
      const before = document.activeElement;
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);

      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      const video = cell(SCREEN).querySelector("video")!;
      // jsdom's default is undefined, a browser's null: nothing either way.
      expect(video.srcObject ?? null).toBeNull();
      expect(video.hidden).toBe(true);
      expect(control(SCREEN, "watch").textContent).toBe("Watch stream");
      // A stream someone else started never takes your focus.
      expect(document.activeElement).toBe(before);
      expect(setStreamWatched).not.toHaveBeenCalled();
      expect(grid.hasStreams()).toBe(true);
    });

    it("Watch asks for the stream, and it plays once it arrives", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      control(SCREEN, "watch").click();

      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, true);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screen);
      expect(cell(SCREEN).querySelector("video")!.srcObject).toBe(stream);
      expect(cell(SCREEN).querySelectorAll(".video-cell")).toHaveLength(0);
      expect(container.querySelectorAll(".video-cell")).toHaveLength(1);
    });

    it("Stop watching stops the stream, and its unsubscribe leaves the tile on Watch", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      control(SCREEN, "stop").click();
      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, false);

      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell(SCREEN).querySelector("video")!.srcObject).toBeNull();
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      expect(control(SCREEN, "watch")).not.toBeNull();
    });

    it("a stream that arrives on a tile showing Watch plays: it is subscribed only when watched", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      expect(cell(SCREEN).querySelector("video")!.hidden).toBe(false);
    });

    it("an ended camera or a dropped roster watch is forgotten, not stopped (WP 1B-3)", () => {
      const forgetStreamWatch = vi.fn();
      grid.setCallbacks({ setStreamWatched, forgetStreamWatch });
      const camera = { isSelf: false, audioUserId: 3, isScreenshare: false };
      grid.addStream(3, "Sam", fakeStream(), camera);
      grid.removeStream(3);
      expect(forgetStreamWatch).toHaveBeenCalledWith(3);

      grid.watch(4);
      grid.clearStreams();
      expect(forgetStreamWatch).toHaveBeenCalledWith(4);
      expect(setStreamWatched).not.toHaveBeenCalledWith(3, false);
      expect(setStreamWatched).not.toHaveBeenCalledWith(4, false);
    });

    it("a stream that ends stops its watch; your own preview is never one", () => {
      vi.useFakeTimers();
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        // Held while the tile says it ended, for a re-share (WP 1C-1).
        vi.advanceTimersByTime(3000);
        expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, false);
      } finally {
        vi.useRealTimers();
      }

      setStreamWatched.mockClear();
      grid.addStream(1, "Me (You)", fakeStream(), {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: false,
      });
      control(1, "hide-preview")?.click();
      grid.removeStream(1);
      expect(setStreamWatched).not.toHaveBeenCalled();
    });

    it("a roster watch that never got a stream does not unlock a later offered tile", () => {
      grid.watch(SCREEN);
      setStreamWatched.mockClear();
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      expect(setStreamWatched).not.toHaveBeenCalled();
    });

    it("a used roster watch does not start a later stream of the same tile", () => {
      grid.watch(SCREEN);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
    });

    it("clearStreams un-watches a roster watch that never got a tile", () => {
      grid.watch(SCREEN);
      setStreamWatched.mockClear();
      grid.clearStreams();
      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, false);
    });

    it("watch() on an offered tile watches it; a channel change drops a pending one", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.watch(SCREEN);
      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, true);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);

      grid.watch(3);
      grid.clearStreams();
      grid.addStream(3, "Sam", null, { isSelf: false, audioUserId: 3, isScreenshare: false });
      expect(cell(3).classList.contains("video-cell--stopped")).toBe(true);
    });
  });

  describe("full screen, pop-out and stream info (PR 4)", () => {
    const SCREEN = 2 + 1_000_000;
    const screenCfg: TileConfig = {
      isSelf: false,
      audioUserId: 2,
      isScreenshare: true,
      name: "Otto",
    };
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const control = (id: number, name: string) =>
      cell(id).querySelector<HTMLButtonElement>(`[data-tile-control='${name}']`)!;

    let fullscreenElement: Element | null = null;
    let requestFullscreen: ReturnType<typeof vi.fn>;
    let exitFullscreen: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Attached, as in the app: the theatre view's keys are document-level.
      document.body.appendChild(container);
      fullscreenElement = null;
      const enter = (el: Element): void => {
        fullscreenElement = el;
      };
      requestFullscreen = vi.fn(function (this: Element) {
        enter(this);
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      });
      exitFullscreen = vi.fn(() => {
        fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => fullscreenElement,
      });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: exitFullscreen,
      });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: requestFullscreen,
      });
    });

    afterEach(() => {
      container.remove();
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      vi.useRealTimers();
    });

    it("puts the tile in full screen and back, and keeps the window full screen with it", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);

      const fs = control(SCREEN, "fullscreen");
      expect(fs.getAttribute("aria-label")).toBe("Full screen");
      fs.click();
      await Promise.resolve();

      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(requestFullscreen.mock.contexts[0]).toBe(cell(SCREEN));
      expect(control(SCREEN, "fullscreen").getAttribute("aria-label")).toBe("Exit full screen");
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true);

      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect(control(SCREEN, "fullscreen").getAttribute("aria-label")).toBe("Full screen");
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("toggles full screen with F from inside the tile, and with a double-click", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "select").dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", bubbles: true }),
      );
      await Promise.resolve();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);

      cell(SCREEN).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
    });

    it("falls back to a window-filling theatre view when the full-screen API is refused", async () => {
      requestFullscreen.mockImplementation(() => Promise.reject(new Error("denied")));
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);

      control(SCREEN, "fullscreen").click();
      await vi.waitFor(() =>
        expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(true),
      );
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true);

      cell(SCREEN).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(false);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("leaves the theatre view with Escape or F after focus has left the tile", async () => {
      requestFullscreen.mockImplementation(() => Promise.reject(new Error("denied")));
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const root = container.querySelector<HTMLElement>("[data-testid='video-grid']")!;

      for (const key of ["Escape", "f"]) {
        control(SCREEN, "fullscreen").click();
        await vi.waitFor(() =>
          expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(true),
        );
        // A click on the video moves focus to the grid, outside the tile.
        root.focus();
        root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(false);
      }
    });

    it("keeps the call controls at hand in full screen", async () => {
      const onMuteToggle = vi.fn();
      const onLeave = vi.fn();
      grid.setCallbacks({ callControls: { onMuteToggle, onDeafenToggle: vi.fn(), onLeave } });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();

      const calls = cell(SCREEN).querySelector<HTMLElement>(".video-fs-calls")!;
      expect(calls).not.toBeNull();
      const mute = calls.querySelector<HTMLButtonElement>("[data-call-control='mute']")!;
      mute.click();
      expect(onMuteToggle).toHaveBeenCalledTimes(1);
      grid.setCallState({ muted: true, deafened: false, listenOnly: false });
      expect(mute.getAttribute("aria-pressed")).toBe("true");
      // Listen-only: no mic to mute, so the control reads mic-off and is inert.
      grid.setCallState({ muted: false, deafened: false, listenOnly: true });
      expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic-off");
      expect(mute.disabled).toBe(true);
      expect(mute.title).toBe("Listening only — no microphone access");
      expect(keyword(cascadedDeclaration(".video-fs-btn:disabled", "opacity"))).toBe("0.5");
      grid.setCallState({ muted: false, deafened: false, listenOnly: false });
      expect(mute.disabled).toBe(false);
      expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic");
      calls.querySelector<HTMLButtonElement>("[data-call-control='leave']")!.click();
      expect(onLeave).toHaveBeenCalledTimes(1);

      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      expect(cell(SCREEN).querySelector(".video-fs-calls")).toBeNull();
    });

    /** Nodes taken out of the tree since `observer` started: removing a
     *  full-screen element (or an ancestor) ends full screen in a browser. */
    const removedNodes = (observer: MutationObserver): Node[] =>
      observer.takeRecords().flatMap((r) => [...r.removedNodes]);

    it("never takes a full-screen tile out of the page while others come and go", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      grid.addStream(7, "Ada", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      const fsCell = cell(SCREEN);
      expect(fullscreenElement).toBe(fsCell);
      expect(grid.getFocusedTileId()).toBe(SCREEN);
      expect(control(SCREEN, "select").hidden).toBe(true);

      const observer = new MutationObserver(() => {});
      observer.observe(container, { childList: true, subtree: true });
      grid.addStream(8, "Bea", fakeStream(), makeTileConfig({ audioUserId: 8 }));
      grid.setPeople([{ userId: 9, label: "Cy", content: document.createElement("div") }]);
      grid.removeStream(7);
      grid.setFocusedTile(SCREEN);
      // The first click of a double-click lands on the video, not a focus swap.
      fsCell.querySelector("video")!.click();

      expect(removedNodes(observer).some((n) => n.contains(fsCell))).toBe(false);
      observer.disconnect();
      expect(grid.getFocusedTileId()).toBe(SCREEN);
      expect(exitFullscreen).not.toHaveBeenCalled();
    });

    it("leaves full screen when Back to grid moves focus off the tile", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();

      control(SCREEN, "grid").click();
      await Promise.resolve();

      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect(grid.getFocusedTileId()).toBeNull();
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("takes the window out of full screen when the grid goes away mid-stream", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      setWindowFullscreen.mockClear();

      grid.destroy?.();

      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect(setWindowFullscreen).toHaveBeenCalledWith(false);
    });

    it("takes the window out of the theatre view when the grid goes away", async () => {
      requestFullscreen.mockImplementation(() => Promise.reject(new Error("denied")));
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await vi.waitFor(() => expect(setWindowFullscreen).toHaveBeenLastCalledWith(true));

      grid.destroy?.();

      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("opens the tile menu inside the full-screen tile, where it can be seen", async () => {
      document.body.appendChild(container);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();

      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
      );

      await vi.waitFor(() => expect(document.querySelector(".video-tile-menu")).not.toBeNull());
      expect(cell(SCREEN).contains(document.querySelector(".video-tile-menu"))).toBe(true);
      container.remove();
    });

    it("shows the frame rate your screen share achieves, not the one it asked for", async () => {
      vi.useFakeTimers();
      try {
        const track = {
          id: "t",
          kind: "video",
          muted: false,
          getSettings: () => ({ height: 1080, frameRate: 120 }),
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        const stream = {
          getTracks: () => [track],
          getVideoTracks: () => [track],
          getAudioTracks: () => [],
        } as unknown as MediaStream;
        const getLocalShareStats = vi.fn(async (): Promise<ShareSenderSample | null> => ({}));
        grid.setCallbacks({ getLocalShareStats });
        grid.addStream(1 + 1_000_000, "Your Screen", stream, {
          isSelf: true,
          audioUserId: 1,
          isScreenshare: true,
        });
        const detail = () => cell(1 + 1_000_000).querySelector(".video-self-detail")!.textContent;
        const sender = () => cell(1 + 1_000_000).querySelector<HTMLElement>(".video-self-stats")!;
        // 1080p, not 1,080p; and never the requested 120 before a measurement.
        expect(detail()).toBe("1080p · No audio");
        expect(sender().hidden).toBe(true);

        getLocalShareStats.mockResolvedValue({ sentFps: 58.4 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(detail()).toBe("1080p · 58 fps · No audio");
        expect(sender().hidden).toBe(true);

        // M-1: why the share sends what it does.
        getLocalShareStats.mockResolvedValue({
          sentFps: 61,
          captureFps: 120,
          limitation: "cpu",
          codec: "video/VP8",
          encoder: "libvpx",
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(detail()).toBe("1080p · 61 fps · No audio");
        expect(sender().hidden).toBe(false);
        expect(sender().textContent).toBe("Capture 120 fps · Limited by CPU · VP8 · libvpx");

        // Each simulcast layer gets its own line in the tooltip.
        getLocalShareStats.mockResolvedValue({
          sentFps: 24,
          captureFps: 60,
          captureFpsSource: "configured",
          layers: [
            { active: true, height: 1080, sentFps: 24 },
            { active: false, height: 720 },
          ],
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(sender().textContent).toBe("Capture set to 60 fps");
        expect(sender().title).toBe("1080p · 24 fps\n720p paused");

        getLocalShareStats.mockResolvedValue({ sentFps: 117, limitation: "none" });
        await vi.advanceTimersByTimeAsync(2000);
        expect(sender().title).toBe("");
        expect(detail()).toBe("1080p · 117 fps · No audio");
        expect(sender().textContent).toBe("Not limited");

        // A share with no sender stats (the Linux native share) says so.
        getLocalShareStats.mockResolvedValue(null);
        await vi.advanceTimersByTimeAsync(2000);
        expect(detail()).toBe("1080p · No audio");
        expect(sender().textContent).toBe("Encoder details not available");

        // The poll goes with the tile.
        grid.removeStream(1 + 1_000_000);
        const calls = getLocalShareStats.mock.calls.length;
        await vi.advanceTimersByTimeAsync(6000);
        expect(getLocalShareStats).toHaveBeenCalledTimes(calls);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves the video in its tile when no pop-out window opens", () => {
      vi.stubGlobal("open", () => null);
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        control(SCREEN, "pip").click();
        expectConsole("warn", "Pop out window refused");
        expect(mockShowToast).toHaveBeenCalledWith("Couldn't open the pop-out window", "error");
        expect(cell(SCREEN).querySelector("video")).not.toBeNull();
        expect(cell(SCREEN).querySelector(".video-popped")).toBeNull();
        expect(control(SCREEN, "pip").getAttribute("aria-pressed")).toBe("false");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("shows resolution and frame rate on the focused stream, with a stats popover", async () => {
      // Focus needs a connected tree.
      document.body.appendChild(container);
      vi.useFakeTimers();
      let frames = 0;
      let ts = 0;
      const getStreamStats = vi.fn(async () => {
        const sample = {
          frameWidth: 1920,
          frameHeight: 1080,
          framesDecoded: frames,
          timestamp: ts,
          bitrate: 5_800_000,
          codec: "video/VP8",
          packetsLost: 1,
          packetsReceived: 999,
        };
        frames += 60;
        ts += 2000;
        return sample;
      });
      grid.setCallbacks({ getStreamStats });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      expect(getStreamStats).not.toHaveBeenCalled();

      grid.setFocusedTile(SCREEN);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(getStreamStats).toHaveBeenCalledWith(SCREEN);

      const chip = cell(SCREEN).querySelector<HTMLButtonElement>(".video-quality")!;
      expect(chip.textContent).toBe("1080p · 30 fps");
      expect(chip.getAttribute("aria-label")).toBe("Stream info: 1080p, 30 frames per second");
      expect(chip.getAttribute("aria-expanded")).toBe("false");

      chip.click();
      const pop = cell(SCREEN).querySelector<HTMLElement>(".video-stats")!;
      expect(pop.getAttribute("role")).toBe("dialog");
      expect(chip.getAttribute("aria-expanded")).toBe("true");
      const text = pop.textContent ?? "";
      for (const part of ["1920×1080", "30 fps", "5.8 Mbps", "VP8", "0.1 %"]) {
        expect(text).toContain(part);
      }
      pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(cell(SCREEN).querySelector(".video-stats")).toBeNull();
      expect(document.activeElement).toBe(chip);

      // Leaving focus view stops polling.
      grid.setFocusedTile(null);
      const calls = getStreamStats.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000);
      expect(getStreamStats.mock.calls.length).toBe(calls);
      container.remove();
    });

    it("gives a camera tile no quality chip and polls no stats for it, even focused (WP 1B-4)", async () => {
      document.body.appendChild(container);
      vi.useFakeTimers();
      const getStreamStats = vi.fn(async () => null);
      grid.setCallbacks({ getStreamStats });
      grid.addStream(2, "Otto", fakeStream(), {
        isSelf: false,
        audioUserId: 2,
        isScreenshare: false,
      });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);

      expect(cell(2).querySelector(".video-quality")).toBeNull();
      expect(cell(SCREEN).querySelector(".video-quality")).not.toBeNull();

      grid.setFocusedTile(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(getStreamStats).not.toHaveBeenCalled();
      container.remove();
    });
  });

  describe("pop-out window (Discord-style)", () => {
    const SCREEN = 2 + 1_000_000;
    const screenCfg: TileConfig = {
      isSelf: false,
      audioUserId: 2,
      isScreenshare: true,
      name: "Otto",
    };
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const control = (id: number, name: string) =>
      cell(id).querySelector<HTMLButtonElement>(`[data-tile-control='${name}']`)!;
    let popup: ReturnType<typeof fakePopup>;
    let open: ReturnType<typeof vi.fn>;
    let requestFullscreen: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      document.body.appendChild(container);
      vi.useFakeTimers();
      popup = fakePopup();
      open = vi.fn(() => popup.win as unknown as Window);
      vi.stubGlobal("open", open);
      requestFullscreen = vi.fn(function (this: Element) {
        popup.enterFullscreen(this);
        return Promise.resolve();
      });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: requestFullscreen,
      });
    });

    afterEach(() => {
      grid.destroy?.();
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    });

    it("moves the tile's own video into a window of its own", () => {
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;

      control(SCREEN, "pip").click();

      expect(open).toHaveBeenCalledTimes(1);
      const label = String(open.mock.calls[0]![1]);
      expect(label).toMatch(/^owncord-popout-\d+$/);
      expect(open.mock.calls[0]![0]).toBe(`about:blank#${label}`);
      expect(popup.doc.body.contains(video)).toBe(true);
      expect(video.srcObject).toBe(stream);
      expect(popup.doc.title).toBe("Otto (Screen) — OwnCord");
      expect(cell(SCREEN).querySelector("video")).toBeNull();
      expect(cell(SCREEN).querySelector(".video-popped")).not.toBeNull();
      expect(control(SCREEN, "pip").getAttribute("aria-pressed")).toBe("true");
    });

    it("offers Pop out where picture-in-picture is missing too (WebKitGTK)", () => {
      Object.defineProperty(document, "pictureInPictureEnabled", {
        configurable: true,
        value: false,
      });
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        expect(control(SCREEN, "pip").hidden).toBe(false);
      } finally {
        delete (document as { pictureInPictureEnabled?: unknown }).pictureInPictureEnabled;
      }
    });

    it("puts the video back in its tile when the window is closed", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      popup.win.closed = true;
      vi.advanceTimersByTime(1000);

      expect(cell(SCREEN).contains(video)).toBe(true);
      expect(cell(SCREEN).querySelector(".video-popped")).toBeNull();
      expect(control(SCREEN, "pip").getAttribute("aria-pressed")).toBe("false");
    });

    it("gives a video that came back empty its stream again", () => {
      // WebKitGTK drops a <video>'s player with the window it played in.
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();
      const given: unknown[] = [];
      Object.defineProperty(video, "srcObject", {
        configurable: true,
        get: () => given.at(-1) ?? stream,
        set: (v: unknown) => {
          given.push(v);
        },
      });

      popup.win.closed = true;
      vi.advanceTimersByTime(1000);

      expect(video.readyState).toBe(HTMLMediaElement.HAVE_NOTHING);
      expect(given).toEqual([null, stream]);
      expect(cell(SCREEN).contains(video)).toBe(true);
    });

    it("leaves a video that still plays on its return alone", () => {
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();
      Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
      });
      const given: unknown[] = [];
      Object.defineProperty(video, "srcObject", {
        configurable: true,
        get: () => stream,
        set: (v: unknown) => {
          given.push(v);
        },
      });

      control(SCREEN, "pop-in").click();

      expect(given).toEqual([]);
    });

    it("shows a canvas-drawn stream's canvas with its video, in the window and back", () => {
      // Linux draws remote video into a canvas (lib/videoSurface.ts).
      const { stream, track } = fakeStreamWithTrack();
      const canvas = document.createElement("canvas");
      registerVideoSurface(track as unknown as MediaStreamTrack, canvas);
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      expect(video.nextSibling).toBe(canvas);
      expect(video.dataset.surface).toBe("");

      control(SCREEN, "pip").click();
      expect(popup.doc.body.contains(canvas)).toBe(true);
      expect(video.nextSibling).toBe(canvas);
      expect(cell(SCREEN).contains(canvas)).toBe(false);

      control(SCREEN, "pop-in").click();
      expect(cell(SCREEN).contains(canvas)).toBe(true);
      expect(video.nextSibling).toBe(canvas);

      // Its stream gone (not watched), the canvas goes with it.
      grid.addStream(SCREEN, "Otto (Screen)", null, screenCfg);
      expect(canvas.parentNode).toBeNull();
      expect(video.dataset.surface).toBeUndefined();
    });

    it("Bring back closes the window and returns the video", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      control(SCREEN, "pop-in").click();

      expect(popup.win.close).toHaveBeenCalledTimes(1);
      expect(cell(SCREEN).contains(video)).toBe(true);

      // Pop out again, and back with the same toggle.
      control(SCREEN, "pip").click();
      expect(open).toHaveBeenCalledTimes(2);
      control(SCREEN, "pip").click();
      expect(cell(SCREEN).contains(video)).toBe(true);
    });

    it("pops the same tile out again right after Bring back, under a new window label", () => {
      // The old window may still be registered while it closes: reusing its
      // label would make the desktop refuse the new one.
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      control(SCREEN, "pop-in").click();
      popup = fakePopup();
      open.mockReturnValue(popup.win as unknown as Window);
      control(SCREEN, "pip").click();

      expect(open).toHaveBeenCalledTimes(2);
      const [first, second] = open.mock.calls.map((c) => String(c[0]));
      expect(first).toMatch(/^about:blank#owncord-popout-\d+$/);
      expect(second).toMatch(/^about:blank#owncord-popout-\d+$/);
      expect(second).not.toBe(first);
    });

    it("a stopped tile pops out watching again, not as a blank window", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "stop").click();

      control(SCREEN, "pip").click();

      expect(popup.doc.body.contains(video)).toBe(true);
      expect(video.hidden).toBe(false);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      expect(cell(SCREEN).querySelector(".video-stopped")).toBeNull();
    });

    it("a stream offered with Watch pops out watching: it asks for the stream", () => {
      const setStreamWatched = vi.fn();
      grid.setCallbacks({ setStreamWatched });
      grid.addStream(SCREEN, "Otto (Screen)", null, screenCfg);

      control(SCREEN, "pip").click();

      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, true);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
    });

    it("takes the stream's volume and mute along into the window, and brings them back", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();

      const overlay = popup.doc.querySelector<HTMLElement>(".video-tile-overlay")!;
      expect(overlay).not.toBeNull();
      expect(overlay.hasAttribute("inert")).toBe(false);
      const slider = overlay.querySelector<HTMLInputElement>(".tile-volume-slider")!;
      expect(slider.getAttribute("aria-label")).toBe("Otto stream volume");
      slider.value = "40";
      slider.dispatchEvent(new Event("input"));
      expect(mockSetScreenshareAudioVolume).toHaveBeenLastCalledWith(2, 0.4);
      overlay.querySelector<HTMLButtonElement>(".tile-mute-btn")!.click();
      expect(mockMuteScreenshareAudio).toHaveBeenLastCalledWith(2, true);
      // Shown in the window, where no tile hover reveals it.
      expect(keyword(cascadedDeclaration(".video-popout .video-tile-overlay", "opacity"))).toBe(
        "1",
      );

      popup.win.close();
      vi.advanceTimersByTime(1000);
      expect(cell(SCREEN).querySelector(".video-tile-overlay")).toBe(overlay);
      expect(popup.doc.querySelector(".video-tile-overlay")).toBeNull();
    });

    it("hides a muted track's stalled frame in the window too", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      control(SCREEN, "pip").click();
      const video = popup.doc.querySelector("video")!;

      track.dispatchEvent("mute");
      expect(video.classList.contains("track-muted")).toBe(true);
      expect(keyword(cascadedDeclaration(".video-popout video.track-muted", "visibility"))).toBe(
        "hidden",
      );
      track.dispatchEvent("unmute");
      expect(video.classList.contains("track-muted")).toBe(false);
    });

    it("keeps keyboard focus on the tile when Bring back goes", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      const back = control(SCREEN, "pop-in");
      back.focus();

      back.click();

      expect(document.activeElement).toBe(control(SCREEN, "pip"));
    });

    it("takes the covered tile controls out of reach while popped out, Bring back aside", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();

      for (const name of ["select", "stop", "pip", "fullscreen"]) {
        expect(control(SCREEN, name).closest("[inert]"), name).not.toBeNull();
      }
      // The volume controls went into the window with the video.
      expect(cell(SCREEN).querySelector(".tile-mute-btn")).toBeNull();
      expect(control(SCREEN, "pop-in").closest("[inert]")).toBeNull();

      control(SCREEN, "pop-in").click();
      expect(cell(SCREEN).querySelector("[inert]")).toBeNull();
    });

    it("puts keyboard focus back on the tile when the window is closed from outside", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").focus();
      control(SCREEN, "pip").click();
      (document.activeElement as HTMLElement | null)?.blur();

      popup.win.closed = true;
      vi.advanceTimersByTime(1000);

      expect(document.activeElement).toBe(control(SCREEN, "pip"));
    });

    it("leaves focus where it is when it is elsewhere as the window closes", () => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        control(SCREEN, "pip").click();
        input.focus();

        popup.win.closed = true;
        vi.advanceTimersByTime(1000);

        expect(document.activeElement).toBe(input);
      } finally {
        input.remove();
      }
    });

    it("goes full screen in the window, and takes the window itself with it", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      const label = String(open.mock.calls[0]![1]);
      const fs = popup.doc.querySelector<HTMLButtonElement>("[data-popout-control='fullscreen']")!;
      expect(fs.getAttribute("aria-label")).toBe("Full screen");

      fs.click();
      await Promise.resolve();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(popup.doc.contains(requestFullscreen.mock.contexts[0] as Node)).toBe(true);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, label);
      expect(fs.getAttribute("aria-label")).toBe("Exit full screen");

      // F in the window toggles it back, as on a tile.
      popup.doc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await Promise.resolve();
      expect(popup.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, label);
      expect(fs.getAttribute("aria-label")).toBe("Full screen");

      // Double-click on the video goes full screen too.
      popup.doc
        .querySelector("video")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
      expect(requestFullscreen).toHaveBeenCalledTimes(2);
    });

    it("fills the screen with the window alone where the page cannot go full screen", async () => {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      const label = String(open.mock.calls[0]![1]);

      popup.doc.querySelector<HTMLButtonElement>("[data-popout-control='fullscreen']")!.click();
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, label);
      popup.doc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, label);
    });

    it("a new track reaches the popped-out video", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStreamWithTrack().stream, screenCfg);
      control(SCREEN, "pip").click();
      const next = fakeStreamWithTrack().stream;

      grid.addStream(SCREEN, "Otto (Screen)", next, screenCfg);

      expect(popup.doc.querySelector("video")!.srcObject).toBe(next);
    });

    it("draws the window again when it loads its page after opening", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      popup.reload();

      expect(popup.doc.body.contains(video)).toBe(true);
      expect(popup.doc.title).toBe("Otto (Screen) — OwnCord");
    });

    it("closes the window with its stream, the grid, or the app page", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      grid.removeStream(SCREEN);
      expect(popup.win.close).toHaveBeenCalledTimes(1);

      popup = fakePopup();
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      grid.destroy?.();
      expect(popup.win.close).toHaveBeenCalledTimes(1);

      grid = createVideoGrid();
      grid.mount(container);
      popup = fakePopup();
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      window.dispatchEvent(new Event("pagehide"));
      expect(popup.win.close).toHaveBeenCalledTimes(1);
    });

    describe("teardown of the pop-out's listeners and poll", () => {
      const closers: Array<[string, () => void]> = [
        [
          "the user closes the window",
          () => {
            popup.win.closed = true;
            vi.advanceTimersByTime(1000);
          },
        ],
        ["Bring back", () => control(SCREEN, "pop-in").click()],
        ["the stream is removed", () => grid.removeStream(SCREEN)],
        ["the grid is destroyed", () => grid.destroy?.()],
      ];

      it.each(closers)("leaves nothing alive when %s", async (_name, close) => {
        const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
        grid.setCallbacks({ setWindowFullscreen });
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        const before = vi.getTimerCount();
        control(SCREEN, "pip").click();
        expect(vi.getTimerCount()).toBeGreaterThan(before);
        const oldDoc = popup.doc;

        close();
        expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
        popup.win.close.mockClear();
        setWindowFullscreen.mockClear();

        window.dispatchEvent(new Event("pagehide"));
        oldDoc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
        oldDoc.dispatchEvent(new Event("fullscreenchange"));
        await Promise.resolve();
        expect(popup.win.close).not.toHaveBeenCalled();
        expect(setWindowFullscreen).not.toHaveBeenCalled();
      });
    });

    it("full screen on a popped-out tile brings it back first", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      control(SCREEN, "fullscreen").click();

      expect(popup.win.close).toHaveBeenCalledTimes(1);
      expect(cell(SCREEN).contains(video)).toBe(true);
      expect(requestFullscreen.mock.contexts[0]).toBe(cell(SCREEN));
    });
  });

  describe("video layers follow what each tile shows (P3-07)", () => {
    const SCREEN = 3 + 1_000_000;
    /** Rendered tile sizes by data-user-id; an absent tile renders 0 × 0. */
    let sizes: Map<string, { width: number; height: number }>;
    let observers: Array<() => void>;
    let hidden: boolean;
    let pubs: Map<string, ReturnType<typeof publication>>;

    function publication() {
      return {
        track: {},
        isSubscribed: true,
        setEnabled: vi.fn(),
        setVideoQuality: vi.fn(),
        setVideoDimensions: vi.fn(),
      };
    }
    /** The room the grid's views land on, through the real RemoteTracks. */
    function room(): Room {
      const participants = new Map<string, unknown>();
      for (const uid of [2, 3]) {
        participants.set(`user-${uid}`, {
          identity: `user-${uid}`,
          getTrackPublication: (source: string) => pubs.get(`${uid}:${source}`),
        });
      }
      return { remoteParticipants: participants } as unknown as Room;
    }
    const pub = (uid: number, source = "camera") => pubs.get(`${uid}:${source}`)!;
    /** The last enabled state asked of a publication. */
    const enabled = (uid: number, source = "camera") =>
      pub(uid, source).setEnabled.mock.lastCall?.[0] as boolean | undefined;
    /** Resize tiles and let the sizes settle (views follow a resize after 150 ms). */
    function resize(entries: Record<number, [number, number]>): void {
      for (const [id, [width, height]] of Object.entries(entries)) sizes.set(id, { width, height });
      for (const fire of observers) fire();
      vi.advanceTimersByTime(150);
    }
    const cellOf = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;

    beforeEach(() => {
      grid.destroy?.();
      vi.useFakeTimers();
      sizes = new Map();
      observers = [];
      hidden = false;
      pubs = new Map([
        ["2:camera", publication()],
        ["3:camera", publication()],
        ["3:screen_share", publication()],
      ]);
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            observers.push(cb);
          }
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        },
      );
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const size = sizes.get(this.dataset["userId"] ?? "") ?? { width: 0, height: 0 };
        return { ...size, top: 0, left: 0, right: size.width, bottom: size.height } as DOMRect;
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

      const tracks = new RemoteTracks(room);
      grid = createVideoGrid();
      grid.mount(container);
      grid.setCallbacks({
        setStreamView: (tileId, view) =>
          tileId >= 1_000_000
            ? tracks.setRemoteVideoView(tileId - 1_000_000, "screenshare", view)
            : tracks.setRemoteVideoView(tileId, "camera", view),
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete (document as { hidden?: unknown }).hidden;
    });

    function addCameras(): void {
      grid.addStream(1, "me (You)", fakeStream(), makeTileConfig({ isSelf: true, audioUserId: 1 }));
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Ada", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      resize({ 1: [320, 180], 2: [320, 180], 3: [320, 180] });
    }

    it("hiding the grid calls setEnabled(false) on every remote camera publication, and showing it re-enables them", () => {
      addCameras();
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);

      // The grid slot goes display:none (back to chat): every tile renders 0 × 0.
      resize({ 1: [0, 0], 2: [0, 0], 3: [0, 0] });
      expect(enabled(2)).toBe(false);
      expect(enabled(3)).toBe(false);

      resize({ 1: [320, 180], 2: [320, 180], 3: [320, 180] });
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);
    });

    it("sends one view per tile once a burst of resizes settles (a window drag)", () => {
      addCameras();
      pub(2).setVideoDimensions.mockClear();
      for (const width of [400, 480, 560, 640]) {
        sizes.set("2", { width, height: (width * 9) / 16 });
        for (const fire of observers) fire();
        vi.advanceTimersByTime(16);
      }
      expect(pub(2).setVideoDimensions).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(pub(2).setVideoDimensions).toHaveBeenCalledTimes(1);
      expect(pub(2).setVideoDimensions).toHaveBeenLastCalledWith({ width: 640, height: 360 });
    });

    it("stops the video while the app is hidden (minimised), and resumes it when shown", () => {
      addCameras();
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(false);
      expect(enabled(3)).toBe(false);

      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);
    });

    it("a 160-px tile requests a lower quality than a focused tile", () => {
      addCameras();
      pub(2).setVideoDimensions.mockClear();
      grid.setFocusedTile(2);
      resize({ 2: [1280, 720], 3: [160, 90] });

      expect(pub(3).setVideoDimensions).toHaveBeenLastCalledWith({ width: 160, height: 90 });
      expect(pub(2).setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
      expect(pub(2).setVideoDimensions).not.toHaveBeenCalled();
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);

      // Back to the grid: tile 2 is sized like any other again.
      grid.setFocusedTile(null);
      resize({ 2: [320, 180], 3: [320, 180] });
      expect(pub(2).setVideoDimensions).toHaveBeenLastCalledWith({ width: 320, height: 180 });
    });

    it("a focused screen share keeps its top layer however small its tile renders", () => {
      grid.addStream(
        SCREEN,
        "Ada (Screen)",
        fakeStream(),
        makeTileConfig({ audioUserId: 3, isScreenshare: true }),
      );
      grid.setFocusedTile(SCREEN);
      resize({ [SCREEN]: [200, 112] });
      expect(pub(3, "screen_share").setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
      expect(pub(3, "screen_share").setVideoDimensions).not.toHaveBeenCalled();
      expect(enabled(3, "screen_share")).toBe(true);
    });

    it("a stopped tile stops its video, and Watch brings it back", () => {
      addCameras();
      cellOf(2).querySelector<HTMLButtonElement>("[data-tile-control='stop']")!.click();
      expect(enabled(2)).toBe(false);
      expect(enabled(3)).toBe(true);
      cellOf(2).querySelector<HTMLButtonElement>("[data-tile-control='watch']")!.click();
      expect(enabled(2)).toBe(true);
    });

    it("a tile popped out to a window keeps its video at the top layer while the grid is hidden", () => {
      addCameras();
      const popup = fakePopup();
      vi.stubGlobal("open", () => popup.win);
      cellOf(2).querySelector<HTMLButtonElement>("[data-tile-control='pip']")!.click();
      resize({ 1: [0, 0], 2: [0, 0], 3: [0, 0] });
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(true);
      expect(pub(2).setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
      expect(enabled(3)).toBe(false);

      // Back in a hidden grid, it stops like the others.
      popup.win.closed = true;
      vi.advanceTimersByTime(1000);
      expect(enabled(2)).toBe(false);
    });

    it("asks a replacement publication (after a reconnect) for the tile's view again", () => {
      addCameras();
      resize({ 2: [0, 0] });
      expect(enabled(2)).toBe(false);
      pubs.set("2:camera", publication());
      const { stream } = fakeStreamWithTrack();
      grid.addStream(2, "Otto", stream, makeTileConfig({ audioUserId: 2 }));
      expect(enabled(2)).toBe(false);
    });
  });

  describe("mini-player", () => {
    const mini = (): HTMLElement | null =>
      document.querySelector<HTMLElement>("[data-testid='stream-mini-player']");
    /** The mini-player module loads on first use. */
    const opened = (): Promise<void> => vi.waitFor(() => expect(mini()).not.toBeNull());

    afterEach(() => {
      grid.hideMiniPlayer();
    });

    it("takes the focused remote stream's video along, and gives it back", async () => {
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7, name: "Otto" }));
      grid.setFocusedTile(7);
      const video = container.querySelector(".video-cell[data-user-id='7'] video")!;

      grid.showMiniPlayer();
      await opened();

      expect(mini()!.contains(video)).toBe(true);
      expect(mini()!.textContent).toContain("Otto");
      grid.hideMiniPlayer();
      expect(mini()).toBeNull();
      expect(container.querySelector(".video-cell[data-user-id='7']")!.contains(video)).toBe(true);
    });

    it("opens nothing for your own preview or an unwatched stream", async () => {
      grid.addStream(1, "You", fakeStream(), makeTileConfig({ isSelf: true, audioUserId: 1 }));
      grid.addStream(7, "Otto", null, makeTileConfig({ audioUserId: 7 }));

      grid.showMiniPlayer();
      await new Promise((r) => setTimeout(r, 20));

      expect(mini()).toBeNull();
    });

    it("a hide before it has loaded cancels it", async () => {
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));

      grid.showMiniPlayer();
      grid.hideMiniPlayer();
      await new Promise((r) => setTimeout(r, 20));

      expect(mini()).toBeNull();
    });

    it("closes when the stream ends", async () => {
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      grid.removeStream(7);

      expect(mini()).toBeNull();
    });

    it("Return asks the host for the full view of that stream", async () => {
      const onReturnToStream = vi.fn();
      grid.setCallbacks({ onReturnToStream });
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      mini()!.querySelector<HTMLButtonElement>("[data-testid='stream-mini-return']")!.click();

      expect(onReturnToStream).toHaveBeenCalledWith(7);
    });

    it("stops the stream's video while the app is hidden, and resumes it when shown", async () => {
      const setStreamView = vi.fn();
      let hidden = false;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      try {
        grid.setCallbacks({ setStreamView });
        grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
        grid.showMiniPlayer();
        await opened();

        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(setStreamView).toHaveBeenLastCalledWith(7, { enabled: false });

        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(setStreamView).toHaveBeenLastCalledWith(
          7,
          expect.objectContaining({ enabled: true }),
        );
      } finally {
        delete (document as { hidden?: boolean }).hidden;
      }
    });

    it("moves focus off the closing mini-player, but not when focus was elsewhere", async () => {
      const focusFallback = vi.fn();
      grid.setCallbacks({ focusFallback });
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      mini()!.focus();
      grid.hideMiniPlayer();
      expect(focusFallback).toHaveBeenCalledTimes(1);

      grid.showMiniPlayer();
      await opened();
      grid.hideMiniPlayer();
      expect(focusFallback).toHaveBeenCalledTimes(1);
    });

    it("Return from the keyboard lands focus in the grid, not on the page", async () => {
      const focusFallback = vi.fn();
      document.body.appendChild(container);
      grid.setCallbacks({ focusFallback, onReturnToStream: () => grid.hideMiniPlayer() });
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      const btn = mini()!.querySelector<HTMLButtonElement>("[data-testid='stream-mini-return']")!;
      btn.focus();
      btn.click();

      expect(container.contains(document.activeElement)).toBe(true);
    });
  });

  describe("call view: control bar and view toggles (WP 1B-2)", () => {
    const person = (userId: number, label: string) => ({
      userId,
      label,
      content: document.createElement("div"),
    });
    const controls = () => ({
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onLeave: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    const root = () => container.querySelector<HTMLElement>("[data-testid='video-grid']")!;
    const bar = () => root().querySelector<HTMLElement>(":scope > .video-grid__controls");
    const barButton = (id: string) =>
      bar()!.querySelector<HTMLButtonElement>(`[data-call-control='${id}']`)!;
    const toggle = (key: string) =>
      root().querySelector<HTMLButtonElement>(`[data-view-toggle='${key}']`)!;
    const avatarTiles = () => [...container.querySelectorAll<HTMLElement>(".video-cell--avatar")];
    const tile = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const SELF = 1;
    const selfCfg = makeTileConfig({ isSelf: true, audioUserId: SELF });

    beforeEach(() => {
      localStorage.clear();
    });

    it("shows the control bar in the call view, in grid and focus mode", () => {
      grid.setCallbacks({ callControls: controls() });
      expect(bar()).toBeNull();

      grid.setExitVisible(true);
      expect(bar()).not.toBeNull();
      expect(bar()!.getAttribute("role")).toBe("toolbar");
      expect(root().classList.contains("video-grid--call")).toBe(true);
      expect(
        [...bar()!.querySelectorAll<HTMLElement>("[data-call-control]")].map(
          (b) => b.dataset["callControl"],
        ),
      ).toEqual(["mute", "deafen", "camera", "share", "leave"]);

      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      grid.setFocusedTile(2);
      expect(root().classList.contains("focus-mode")).toBe(true);
      expect(bar()).not.toBeNull();
      grid.setFocusedTile(null);
      expect(bar()).not.toBeNull();

      // Leaving the call view (another host shows the grid) takes it down.
      grid.setExitVisible(false);
      expect(bar()).toBeNull();
      expect(root().classList.contains("video-grid--call")).toBe(false);
    });

    it("runs the matching call action from each button", () => {
      const cc = controls();
      grid.setCallbacks({ callControls: cc });
      grid.setExitVisible(true);

      barButton("mute").click();
      barButton("deafen").click();
      barButton("camera").click();
      barButton("share").click();
      barButton("leave").click();
      expect(cc.onMuteToggle).toHaveBeenCalledTimes(1);
      expect(cc.onDeafenToggle).toHaveBeenCalledTimes(1);
      expect(cc.onCameraToggle).toHaveBeenCalledTimes(1);
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
      expect(cc.onLeave).toHaveBeenCalledTimes(1);
    });

    it("puts the camera picker arrow beside Camera, inert while the camera is locked", () => {
      const onCameraDevice = vi.fn();
      grid.setCallbacks({ callControls: { ...controls(), onCameraDevice } });
      grid.setExitVisible(true);
      expect(
        [...bar()!.querySelectorAll<HTMLElement>("[data-call-control]")].map(
          (b) => b.dataset["callControl"],
        ),
      ).toEqual(["mute", "deafen", "camera", "camera-device", "share", "leave"]);

      const pick = barButton("camera-device");
      expect(pick.getAttribute("aria-label")).toBe("Choose camera");
      expect(pick.getAttribute("aria-haspopup")).toBe("menu");
      pick.click();
      expect(onCameraDevice).toHaveBeenCalledTimes(1);
      expect(onCameraDevice.mock.calls[0]![0]).toBe(pick);
      expect(onCameraDevice.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);

      grid.setCallState({ muted: false, deafened: false, listenOnly: false, connecting: true });
      expect(barButton("camera-device").disabled).toBe(true);
    });

    it("builds the bar from callbacks set after the call view opened", () => {
      grid.setExitVisible(true);
      expect(bar()).toBeNull();
      const cc = controls();
      grid.setCallbacks({ callControls: cc });
      barButton("camera").click();
      expect(cc.onCameraToggle).toHaveBeenCalledTimes(1);
    });

    it("draws your camera and share state, inert while the join connects", () => {
      grid.setCallbacks({ callControls: controls() });
      grid.setExitVisible(true);
      const camera = barButton("camera");
      const share = barButton("share");
      expect(camera.getAttribute("aria-pressed")).toBe("false");
      expect(camera.getAttribute("aria-label")).toBe("Turn on camera");
      expect(share.getAttribute("aria-label")).toBe("Share your screen");

      grid.setCallState({
        muted: true,
        deafened: false,
        listenOnly: false,
        camera: true,
        screenshare: true,
      });
      expect(barButton("mute").getAttribute("aria-pressed")).toBe("true");
      expect(camera.getAttribute("aria-pressed")).toBe("true");
      expect(camera.getAttribute("aria-label")).toBe("Turn off camera");
      expect(camera.querySelector("svg")!.getAttribute("data-icon")).toBe("camera-off");
      expect(share.getAttribute("aria-pressed")).toBe("true");
      expect(share.getAttribute("aria-label")).toBe("Stop sharing");
      expect(share.querySelector("svg")!.getAttribute("data-icon")).toBe("monitor-off");
      expect(camera.disabled).toBe(false);

      grid.setCallState({ muted: false, deafened: false, listenOnly: false, connecting: true });
      expect(camera.disabled).toBe(true);
      expect(share.disabled).toBe(true);
      expect(camera.title).toBe("Connecting…");

      // The chat socket is down: frozen with the reason, like the voice widget.
      grid.setCallState({
        muted: false,
        deafened: false,
        listenOnly: false,
        offline: "reconnecting",
      });
      expect(camera.disabled).toBe(true);
      expect(share.title).toBe("Reconnecting…");

      // A moderator's mute or deafen: that control is inert, with the reason.
      grid.setCallState({
        muted: true,
        deafened: true,
        listenOnly: false,
        serverMuted: true,
        serverDeafened: true,
      });
      expect(barButton("mute").disabled).toBe(true);
      expect(barButton("mute").title).toBe("You were muted by a moderator");
      expect(barButton("deafen").disabled).toBe(true);
      expect(barButton("deafen").title).toBe("You were deafened by a moderator");
      expect(camera.disabled).toBe(false);

      // No share permission or the video limit: share is inert with the reason.
      grid.setCallState({
        muted: false,
        deafened: false,
        listenOnly: false,
        shareBlock: "This channel has reached its video limit",
      });
      expect(share.disabled).toBe(true);
      expect(share.title).toBe("This channel has reached its video limit");
      expect(camera.disabled).toBe(false);
    });

    it("offers camera and share on a full-screen tile too", async () => {
      const cc = controls();
      grid.setCallbacks({ callControls: cc });
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      tile(2).querySelector<HTMLButtonElement>("[data-tile-control='fullscreen']")!.click();
      await Promise.resolve();
      const fs = tile(2).querySelector<HTMLElement>(".video-fs-calls")!;
      fs.querySelector<HTMLButtonElement>("[data-call-control='share']")!.click();
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
    });

    it("hides avatar tiles without Show non-video participants, and saves it", () => {
      grid.setExitVisible(true);
      grid.setPeople([person(2, "Otto"), person(3, "Sam")]);
      expect(avatarTiles().filter((t) => !t.hidden)).toHaveLength(2);
      expect(toggle("nonVideo").getAttribute("aria-pressed")).toBe("true");

      toggle("nonVideo").click();
      expect(toggle("nonVideo").getAttribute("aria-pressed")).toBe("false");
      expect(avatarTiles().every((t) => t.hidden)).toBe(true);
      expect(localStorage.getItem("owncord:settings:callShowNonVideo")).toBe("false");
      // A person who joins later stays hidden too.
      grid.setPeople([person(2, "Otto"), person(3, "Sam"), person(4, "Ana")]);
      expect(avatarTiles().every((t) => t.hidden)).toBe(true);

      toggle("nonVideo").click();
      expect(avatarTiles().some((t) => t.hidden)).toBe(false);
    });

    it("hides only your own camera tile without Show my camera", () => {
      grid.setExitVisible(true);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(SELF + 1_000_000, "Your screen", fakeStream(), {
        ...selfCfg,
        isScreenshare: true,
      });

      toggle("selfCamera").click();
      expect(tile(SELF).hidden).toBe(true);
      expect(tile(2).hidden).toBe(false);
      expect(tile(SELF + 1_000_000).hidden).toBe(false);
      expect(localStorage.getItem("owncord:settings:callShowSelfCamera")).toBe("false");

      toggle("selfCamera").click();
      expect(tile(SELF).hidden).toBe(false);
    });

    it("leaves focus mode when the focused tile is your hidden camera", () => {
      grid.setExitVisible(true);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.setFocusedTile(SELF);

      toggle("selfCamera").click();
      expect(grid.getFocusedTileId()).toBeNull();
      expect(root().classList.contains("focus-mode")).toBe(false);
      expect(tile(2).parentElement).toBe(root());
    });

    it("offers the strip toggle only in focus view, and hides the strip with it", () => {
      grid.setExitVisible(true);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      expect(toggle("strip").hidden).toBe(true);

      grid.setFocusedTile(2);
      expect(toggle("strip").hidden).toBe(false);
      expect(root().querySelector(".video-focus-strip")).not.toBeNull();

      toggle("strip").click();
      // Hidden, not detached: a video taken out of the document pauses.
      const strip = root().querySelector<HTMLElement>(".video-focus-strip")!;
      expect(strip.hidden).toBe(true);
      expect(strip.contains(tile(3))).toBe(true);
      expect(tile(2).parentElement!.classList.contains("video-focus-main")).toBe(true);
      expect(localStorage.getItem("owncord:settings:callShowStrip")).toBe("false");

      toggle("strip").click();
      expect(root().querySelector<HTMLElement>(".video-focus-strip")!.hidden).toBe(false);
    });

    it("moves focus past your hidden camera when the focused stream ends", () => {
      grid.setExitVisible(true);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      toggle("selfCamera").click();
      grid.setFocusedTile(2);

      grid.removeStream(2);
      expect(grid.getFocusedTileId()).toBe(3);
    });

    it("keeps keyboard focus on a bar button or toggle while focus view redraws", () => {
      document.body.appendChild(container);
      grid.setCallbacks({ callControls: controls() });
      grid.setExitVisible(true);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      grid.setFocusedTile(2);

      barButton("camera").focus();
      grid.setPeople([person(4, "Ana")]);
      expect(document.activeElement).toBe(barButton("camera"));

      toggle("strip").focus();
      toggle("strip").click();
      expect(document.activeElement).toBe(toggle("strip"));
      // The grid's own controls stay after the tiles.
      expect(root().lastElementChild).toBe(bar());
      container.remove();
    });

    it("seats show chat in the view bar in the call view, and back in the grid without it", () => {
      grid.setExitVisible(true);
      const exit = () =>
        root().querySelector<HTMLButtonElement>("[data-tile-control='exit-grid']")!;
      expect(exit().parentElement!.classList.contains("video-grid__views")).toBe(true);
      expect(exit().hidden).toBe(false);

      grid.setExitVisible(false);
      expect(exit().parentElement).toBe(root());
      expect(exit().hidden).toBe(true);
    });

    it("reads the saved toggles when the grid mounts", () => {
      localStorage.setItem("owncord:settings:callShowNonVideo", "false");
      localStorage.setItem("owncord:settings:callShowSelfCamera", "false");
      localStorage.setItem("owncord:settings:callShowStrip", "false");
      grid.destroy?.();
      container = document.createElement("div");
      grid = createVideoGrid();
      grid.mount(container);
      grid.setExitVisible(true);
      grid.setPeople([person(2, "Otto")]);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);

      expect(toggle("nonVideo").getAttribute("aria-pressed")).toBe("false");
      expect(toggle("selfCamera").getAttribute("aria-pressed")).toBe("false");
      expect(toggle("strip").getAttribute("aria-pressed")).toBe("false");
      expect(avatarTiles()[0]!.hidden).toBe(true);
      expect(tile(SELF).hidden).toBe(true);
    });

    it("hides nothing outside the call view (the DM call panel hosts the grid)", () => {
      localStorage.setItem("owncord:settings:callShowNonVideo", "false");
      localStorage.setItem("owncord:settings:callShowSelfCamera", "false");
      grid.destroy?.();
      container = document.createElement("div");
      grid = createVideoGrid();
      grid.mount(container);
      grid.setPeople([person(2, "Otto")]);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);

      expect(root().querySelector(".video-grid__views")).toBeNull();
      expect(avatarTiles()[0]!.hidden).toBe(false);
      expect(tile(SELF).hidden).toBe(false);

      grid.setExitVisible(true);
      expect(tile(SELF).hidden).toBe(true);
      grid.setExitVisible(false);
      expect(tile(SELF).hidden).toBe(false);
      expect(avatarTiles()[0]!.hidden).toBe(false);
    });

    it("leaves room below the tiles for the bar (CSS)", () => {
      expect(cascadedDeclaration(".video-grid--call", "padding-bottom")).toBeDefined();
    });
  });

  describe("full tile menu (WP 1B-5)", () => {
    const OTTO = 2;
    const SCREEN = OTTO + 1_000_000;
    const SELF = 1;
    const remote = (overrides: Partial<TileConfig> = {}): TileConfig =>
      makeTileConfig({ audioUserId: OTTO, name: "Otto", ...overrides });
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const menu = () => document.querySelector<HTMLElement>(".video-tile-menu");
    const actions = () =>
      [...menu()!.querySelectorAll<HTMLElement>("[data-action]")].map((m) => m.dataset["action"]);
    const item = (action: string) =>
      menu()!.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!;
    async function openMenu(id: number, x = 30, y = 40): Promise<HTMLElement | null> {
      cell(id).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
      await vi.dynamicImportSettled();
      return menu();
    }
    const modOptions = () => ({
      serverMuted: false,
      serverDeafened: false,
      moveTargets: [],
      onServerMute: vi.fn(),
      onServerDeafen: vi.fn(),
      onMove: vi.fn(),
      onDisconnect: vi.fn(),
    });
    const controls = () => ({
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onLeave: vi.fn(),
      onCameraToggle: vi.fn(),
    });

    beforeEach(() => {
      localStorage.clear();
    });

    afterEach(() => {
      menu()?.remove();
      mockSetUserLocalMute.mockReset();
      mockSetUserVolume.mockReset();
      mockGetUserVolume.mockReturnValue(100);
      mockGetUserLocalMute.mockReturnValue(false);
    });

    it("gives another person's tile the person, sound and view rows", async () => {
      grid.setCallbacks({
        tileMenu: { onProfile: vi.fn(), onMessage: vi.fn(), moderation: () => modOptions() },
      });
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);

      expect(actions()).toEqual([
        "profile",
        "message",
        "local-mute",
        "focus",
        "fullscreen",
        "popout",
        "stop-watching",
        "server-mute",
        "server-deafen",
        "voice-disconnect",
      ]);
      expect(menu()!.querySelector("[data-menu-volume='voice']")).not.toBeNull();
      expect(menu()!.querySelector("[data-menu-volume='stream']")).toBeNull();
    });

    it("leaves out Profile, Message and moderation without their handlers", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);

      expect(actions()).toEqual(["local-mute", "focus", "fullscreen", "popout", "stop-watching"]);
    });

    it("hides moderation when the host returns nothing, and says why when it returns a reason", async () => {
      const moderation = vi.fn((_userId: number): string | undefined => undefined);
      grid.setCallbacks({ tileMenu: { moderation } });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), remote({ isScreenshare: true }));
      await openMenu(SCREEN);
      // Asked for the person, not the screen-share tile id.
      expect(moderation).toHaveBeenCalledWith(OTTO);
      expect(actions()).not.toContain("server-mute");
      expect(actions()).not.toContain("voice-mod-unavailable");
      menu()!.remove();

      moderation.mockReturnValue("No verdict yet");
      await openMenu(SCREEN);
      expect(item("voice-mod-unavailable").textContent).toBe("No verdict yet");
      expect(actions()).not.toContain("server-mute");
    });

    it("runs Profile and Message for the person at the click, and closes the menu", async () => {
      const onProfile = vi.fn();
      const onMessage = vi.fn();
      grid.setCallbacks({ tileMenu: { onProfile, onMessage } });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), remote({ isScreenshare: true }));

      await openMenu(SCREEN, 30, 40);
      item("profile").click();
      expect(onProfile).toHaveBeenCalledWith(OTTO, 30, 40);
      expect(menu()).toBeNull();

      await openMenu(SCREEN);
      item("message").click();
      expect(onMessage).toHaveBeenCalledWith(OTTO);
      expect(menu()).toBeNull();
    });

    it("runs each moderation row for the person", async () => {
      const mod = modOptions();
      grid.setCallbacks({ tileMenu: { moderation: () => mod } });
      grid.addStream(OTTO, "Otto", fakeStream(), remote());

      await openMenu(OTTO);
      item("server-mute").click();
      expect(mod.onServerMute).toHaveBeenCalledWith(true);
      await openMenu(OTTO);
      item("server-deafen").click();
      expect(mod.onServerDeafen).toHaveBeenCalledWith(true);
      await openMenu(OTTO);
      item("voice-disconnect").click();
      expect(mod.onDisconnect).toHaveBeenCalledTimes(1);
    });

    it("Profile from a full-screen tile leaves full screen first, so the card can be seen", async () => {
      const onProfile = vi.fn();
      grid.setCallbacks({ tileMenu: { onProfile } });
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      item("fullscreen").click();
      // jsdom has no requestFullscreen: the window-filling fallback.
      expect(cell(OTTO).classList.contains("video-cell--theatre")).toBe(true);

      await openMenu(OTTO);
      expect(item("fullscreen").textContent).toBe("Exit full screen");
      item("profile").click();
      expect(cell(OTTO).classList.contains("video-cell--theatre")).toBe(false);
      expect(onProfile).toHaveBeenCalledTimes(1);
    });

    it("Focus opens the tile in focus view, and then reads Back to grid", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      grid.addStream(3, "Sam", fakeStream(), remote({ audioUserId: 3, name: "Sam" }));
      await openMenu(OTTO);
      expect(item("focus").textContent).toBe("Focus");
      item("focus").click();
      expect(grid.getFocusedTileId()).toBe(OTTO);

      await openMenu(OTTO);
      expect(item("focus").textContent).toBe("Back to grid");
      item("focus").click();
      expect(grid.getFocusedTileId()).toBeNull();
    });

    it("Pop out opens the tile in a window of its own", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      try {
        grid.addStream(OTTO, "Otto", fakeStream(), remote());
        await openMenu(OTTO);
        expect(item("popout").textContent).toBe("Pop out");
        item("popout").click();
        expect(open).toHaveBeenCalledTimes(1);
        // No window here: the tile stays and says so.
        expect(mockShowToast).toHaveBeenCalledWith("Couldn't open the pop-out window", "error");
        expectConsole("warn", "Pop out window refused");
      } finally {
        open.mockRestore();
      }
    });

    it("lets a menu taller than the window scroll instead of running off it", async () => {
      const height = vi
        .spyOn(HTMLElement.prototype, "offsetHeight", "get")
        .mockReturnValue(window.innerHeight + 200);
      try {
        grid.addStream(OTTO, "Otto", fakeStream(), remote());
        await openMenu(OTTO);
        expect(menu()!.style.maxHeight).toBe(`${window.innerHeight - 16}px`);
        expect(menu()!.style.overflowY).toBe("auto");
        expect(menu()!.style.top).toBe("8px");
      } finally {
        height.mockRestore();
      }
    });

    it("Stop watching in the menu stops the stream", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      item("stop-watching").click();
      expect(cell(OTTO).classList.contains("video-cell--stopped")).toBe(true);
    });

    it("Mute silences the person for you only, and stays open", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      const mute = item("local-mute");
      expect(mute.getAttribute("role")).toBe("menuitemcheckbox");
      expect(mute.getAttribute("aria-checked")).toBe("false");

      mockSetUserLocalMute.mockImplementation((_id: number, on: boolean) =>
        mockGetUserLocalMute.mockReturnValue(on),
      );
      mute.click();
      expect(mockSetUserLocalMute).toHaveBeenCalledWith(OTTO, true);
      expect(mute.getAttribute("aria-checked")).toBe("true");
      expect(menu()).not.toBeNull();
    });

    it("unchecking Mute on a person at 0% brings them back at 100% on the slider and tile", async () => {
      mockGetUserVolume.mockReturnValue(0);
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      const mute = item("local-mute");
      expect(mute.getAttribute("aria-checked")).toBe("true");

      mockSetUserVolume.mockImplementation((_id: number, v: number) =>
        mockGetUserVolume.mockReturnValue(v),
      );
      mute.click();
      expect(mockSetUserLocalMute).toHaveBeenCalledWith(OTTO, false);
      expect(mockSetUserVolume).toHaveBeenCalledWith(OTTO, 100);
      expect(menu()!.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!.value).toBe(
        "100",
      );
      expect(cell(OTTO).querySelector("output")!.textContent).toBe("100%");
      expect(mute.getAttribute("aria-checked")).toBe("false");
    });

    describe("your own camera tile", () => {
      const self = () => makeTileConfig({ isSelf: true, audioUserId: SELF });

      it("offers Hide my camera and Turn off camera in the call view, nothing about others", async () => {
        const cc = controls();
        grid.setCallbacks({
          callControls: cc,
          tileMenu: { onProfile: vi.fn(), onMessage: vi.fn(), moderation: () => modOptions() },
        });
        grid.setExitVisible(true);
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);

        expect(menu()!.getAttribute("aria-label")).toBe("Your camera");
        expect(actions()).toEqual(["hide-self", "camera-off"]);
        expect(menu()!.querySelector("[data-menu-volume]")).toBeNull();
      });

      it("Hide my camera hides the tile and turns the Show my camera toggle off", async () => {
        grid.setCallbacks({ callControls: controls() });
        grid.setExitVisible(true);
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);
        item("hide-self").click();

        expect(cell(SELF).hidden).toBe(true);
        const toggle = container.querySelector("[data-view-toggle='selfCamera']")!;
        expect(toggle.getAttribute("aria-pressed")).toBe("false");
        expect(menu()).toBeNull();
      });

      it("Turn off camera runs the camera control", async () => {
        const cc = controls();
        grid.setCallbacks({ callControls: cc });
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);
        // Outside the call view the "Show my camera" toggle does not apply.
        expect(actions()).toEqual(["camera-off"]);
        item("camera-off").click();
        expect(cc.onCameraToggle).toHaveBeenCalledTimes(1);
      });

      it("Hide my camera on a full-screen tile leaves full screen first", async () => {
        grid.setCallbacks({ callControls: controls() });
        grid.setExitVisible(true);
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        cell(SELF).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(cell(SELF).classList.contains("video-cell--theatre")).toBe(true);

        await openMenu(SELF);
        item("hide-self").click();
        expect(cell(SELF).hidden).toBe(true);
        expect(cell(SELF).classList.contains("video-cell--theatre")).toBe(false);
      });

      it("Hide my camera puts focus on the toggle that brings the tile back", async () => {
        document.body.appendChild(container);
        try {
          grid.setCallbacks({ callControls: controls() });
          grid.setExitVisible(true);
          grid.addStream(SELF, "Me (You)", fakeStream(), self());
          await openMenu(SELF);
          item("hide-self").click();
          expect(document.activeElement).toBe(
            container.querySelector("[data-view-toggle='selfCamera']"),
          );
        } finally {
          container.remove();
        }
      });

      it("opens no menu outside the call view while the camera is locked", async () => {
        grid.setCallbacks({ callControls: controls() });
        grid.setCallState({ muted: false, deafened: false, listenOnly: false, connecting: true });
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        expect(await openMenu(SELF)).toBeNull();
      });

      it("greys Turn off camera with the reason while the camera is locked", async () => {
        const cc = controls();
        grid.setCallbacks({ callControls: cc });
        grid.setExitVisible(true);
        grid.setCallState({
          muted: false,
          deafened: false,
          listenOnly: false,
          camera: true,
          offline: "reconnecting",
        });
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);
        const off = item("camera-off");
        expect(off.disabled).toBe(true);
        expect(off.title).not.toBe("");
        off.click();
        expect(cc.onCameraToggle).not.toHaveBeenCalled();
      });

      it("opens no menu with nothing to offer, and none on your own screen share", async () => {
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        expect(await openMenu(SELF)).toBeNull();

        grid.setCallbacks({ callControls: controls() });
        grid.addStream(
          SELF + 1_000_000,
          "Your Screen",
          null,
          makeTileConfig({ isSelf: true, audioUserId: SELF, isScreenshare: true }),
        );
        expect(await openMenu(SELF + 1_000_000)).toBeNull();
      });
    });
  });
  describe("stream ended cover (WP 1C-4)", () => {
    const SCREEN = 2 + 1_000_000;
    const screen: TileConfig = { isSelf: false, audioUserId: 2, isScreenshare: true, name: "Otto" };
    const cell = () =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${SCREEN}']`);
    let onStreamRemoved: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
      vi.useFakeTimers();
      onStreamRemoved = vi.fn();
      grid.setCallbacks({ onStreamRemoved });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a watched stream that ends says so for 3 s, then its tile goes", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);

      expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
      expect(cell()!.querySelector("video")!.srcObject).toBeNull();
      expect(grid.hasStreams()).toBe(true);
      // Nothing under the cover can be clicked or tabbed to.
      const under = [...cell()!.children].filter((c) => !c.classList.contains("video-ended"));
      expect(under.length).toBeGreaterThan(0);
      expect(under.every((c) => c.hasAttribute("inert"))).toBe(true);
      // A second removal (track ended, then unsubscribed) changes nothing.
      grid.removeStream(SCREEN);
      vi.advanceTimersByTime(2999);
      expect(cell()).not.toBeNull();
      expect(onStreamRemoved).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(cell()).toBeNull();
      expect(grid.hasStreams()).toBe(false);
      expect(onStreamRemoved).toHaveBeenCalledTimes(1);
    });

    it("an unpublish that unsubscribes first still shows the cover", () => {
      // livekit-client (and the native room) emit TrackUnsubscribed before
      // TrackUnpublished: the tile is offered back as Watch, then removed.
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);

      expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
      vi.advanceTimersByTime(3000);
      expect(cell()).toBeNull();
    });

    it("a stream you stopped watching goes at once when it ends", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      cell()!.querySelector<HTMLButtonElement>("[data-tile-control='stop']")!.click();
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);

      expect(cell()).toBeNull();
    });

    it("a stream nobody watched, a camera, or your own share goes at once", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.addStream(2, "Otto", fakeStream(), { ...screen, isScreenshare: false });
      grid.addStream(9, "You", fakeStream(), { ...screen, isSelf: true });
      grid.removeStream(SCREEN);
      grid.removeStream(2);
      grid.removeStream(9);

      expect(container.querySelectorAll(".video-cell")).toHaveLength(0);
      expect(container.querySelector(".video-ended")).toBeNull();
    });

    it("the same person streaming again replaces the cover", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      const again = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", again, screen);

      expect(cell()!.querySelector(".video-ended")).toBeNull();
      expect(cell()!.querySelector("video")!.srcObject).toBe(again);
      vi.advanceTimersByTime(3000);
      expect(cell()).not.toBeNull();
      expect(onStreamRemoved).not.toHaveBeenCalled();
    });

    describe("a sharer republishing for another codec (WP M-5b)", () => {
      let live: boolean;
      let cameraLive: boolean;
      beforeEach(() => {
        live = true;
        cameraLive = false;
        grid.setCallbacks({
          onStreamRemoved,
          isStreamLive: (_userId, screenshare) => (screenshare ? live : cameraLive),
        });
      });

      it("keeps a watched camera's tile and watch through its republish", () => {
        const forgetStreamWatch = vi.fn();
        grid.setCallbacks({
          onStreamRemoved,
          forgetStreamWatch,
          isStreamLive: (_userId, screenshare) => !screenshare && cameraLive,
        });
        cameraLive = true;
        const camera = { ...screen, isScreenshare: false };
        grid.addStream(2, "Otto", fakeStreamWithTrack().stream, camera);
        grid.addStream(2, "Otto", null, camera);
        grid.removeStream(2);

        const tile = (): HTMLElement | null =>
          container.querySelector(".video-cell[data-user-id='2']");
        expect(tile()).not.toBeNull();
        expect(tile()!.classList.contains("video-cell--stopped")).toBe(false);
        const again = fakeStreamWithTrack().stream;
        grid.addStream(2, "Otto", again, camera);
        expect(tile()!.querySelector("video")!.srcObject).toBe(again);
        vi.advanceTimersByTime(10_000);
        expect(tile()).not.toBeNull();
        expect(forgetStreamWatch).not.toHaveBeenCalled();

        // Turned off for real: the tile goes with its watch.
        cameraLive = false;
        grid.removeStream(2);
        vi.advanceTimersByTime(250);
        expect(tile()).toBeNull();
        expect(forgetStreamWatch).toHaveBeenCalledWith(2);
      });

      it("shows no cover while the owner's voice state still says they share, and plays the share when it returns", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStreamWithTrack().stream, screen);
        grid.removeStream(SCREEN);
        // The track's own ended event and the unpublish both arrive.
        grid.removeStream(SCREEN);

        expect(cell()!.querySelector(".video-ended")).toBeNull();
        vi.advanceTimersByTime(1000);
        expect(cell()!.querySelector(".video-ended")).toBeNull();

        const again = fakeStreamWithTrack().stream;
        grid.addStream(SCREEN, "Otto (Screen)", again, screen);
        expect(cell()!.querySelector("video")!.srcObject).toBe(again);
        expect(cell()!.classList.contains("video-cell--stopped")).toBe(false);
        // The wait is over: nothing ends the tile later.
        vi.advanceTimersByTime(10_000);
        expect(cell()).not.toBeNull();
        expect(cell()!.querySelector(".video-ended")).toBeNull();
        expect(onStreamRemoved).not.toHaveBeenCalled();
      });

      it("in livekit's real order (unsubscribe, then unpublish) shows no Watch cover and plays the share when it returns", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStreamWithTrack().stream, screen);
        grid.addStream(SCREEN, "Otto (Screen)", null, screen);
        grid.removeStream(SCREEN);

        expect(cell()!.classList.contains("video-cell--stopped")).toBe(false);
        expect(cell()!.querySelector(".video-stopped")).toBeNull();
        expect(cell()!.querySelector(".video-ended")).toBeNull();

        const again = fakeStreamWithTrack().stream;
        grid.addStream(SCREEN, "Otto (Screen)", again, screen);
        expect(cell()!.querySelector("video")!.srcObject).toBe(again);
        vi.advanceTimersByTime(10_000);
        expect(cell()!.querySelector(".video-ended")).toBeNull();
        expect(onStreamRemoved).not.toHaveBeenCalled();
      });

      it("in livekit's real order still says the stream ended once the owner stops sharing", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.addStream(SCREEN, "Otto (Screen)", null, screen);
        grid.removeStream(SCREEN);

        live = false;
        vi.advanceTimersByTime(250);
        expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
      });

      it("shows the cover as soon as the owner's voice state says the share is over", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        vi.advanceTimersByTime(500);
        expect(cell()!.querySelector(".video-ended")).toBeNull();

        live = false;
        vi.advanceTimersByTime(250);
        expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
        vi.advanceTimersByTime(3000);
        expect(cell()).toBeNull();
      });

      it("shows the cover once the grace runs out with no share back", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);

        vi.advanceTimersByTime(2249);
        expect(cell()!.querySelector(".video-ended")).toBeNull();
        vi.advanceTimersByTime(1000);
        expect(cell()!.querySelector(".video-ended")).not.toBeNull();
      });

      it("shows the cover at once when the owner is not sharing, and for a camera never waits", () => {
        live = false;
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        expect(cell()!.querySelector(".video-ended")).not.toBeNull();

        live = true;
        grid.addStream(2, "Otto", fakeStream(), { ...screen, isScreenshare: false });
        grid.removeStream(2);
        expect(container.querySelector(".video-cell[data-user-id='2']")).toBeNull();
      });

      it("a held tile that is closed stops looking at the owner", () => {
        const isStreamLive = vi.fn(() => true);
        grid.setCallbacks({ onStreamRemoved, isStreamLive });
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        const looked = isStreamLive.mock.calls.length;

        grid.destroy?.();
        vi.advanceTimersByTime(10_000);

        expect(isStreamLive.mock.calls.length).toBe(looked);
        expect(onStreamRemoved).not.toHaveBeenCalled();
      });
    });

    it("a re-share within the cover stays watched and in focus (WP 1C-1)", () => {
      const forgetStreamWatch = vi.fn();
      const setStreamWatched = vi.fn();
      grid.setCallbacks({ onStreamRemoved, forgetStreamWatch, setStreamWatched });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.setFocusedTile(SCREEN);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);
      vi.advanceTimersByTime(2000);
      const again = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", again, screen);

      expect(cell()!.querySelector(".video-ended")).toBeNull();
      expect(cell()!.classList.contains("video-cell--stopped")).toBe(false);
      expect(cell()!.querySelector("video")!.srcObject).toBe(again);
      expect(grid.getFocusedTileId()).toBe(SCREEN);
      vi.advanceTimersByTime(3000);
      expect(forgetStreamWatch).not.toHaveBeenCalled();
      expect(setStreamWatched).not.toHaveBeenCalledWith(SCREEN, false);
    });

    it("after the cover the watch is forgotten: a later share is offered as Watch (WP 1C-1)", () => {
      const forgetStreamWatch = vi.fn();
      grid.setCallbacks({ onStreamRemoved, forgetStreamWatch });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      vi.advanceTimersByTime(2999);
      expect(forgetStreamWatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(forgetStreamWatch).toHaveBeenCalledWith(SCREEN);

      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell()!.classList.contains("video-cell--stopped")).toBe(true);
      expect(cell()!.querySelector("[data-tile-control='watch']")).not.toBeNull();
    });

    it("leaving the call during the cover forgets the held watch (WP 1C-1)", () => {
      const forgetStreamWatch = vi.fn();
      grid.setCallbacks({ onStreamRemoved, forgetStreamWatch });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      grid.clearStreams();
      expect(forgetStreamWatch).toHaveBeenCalledWith(SCREEN);
    });

    it("leaving the call drops the cover at once", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      grid.clearStreams();

      expect(cell()).toBeNull();
      vi.advanceTimersByTime(3000);
      expect(onStreamRemoved).not.toHaveBeenCalled();
    });
  });
  describe("pop out the whole call (WP 1C-7)", () => {
    const OTTO = 2;
    let popup: ReturnType<typeof fakePopup>;
    let open: ReturnType<typeof vi.fn>;
    let focusWindow: ReturnType<typeof vi.fn>;
    const controls = () => ({
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onLeave: vi.fn(),
      onCameraToggle: vi.fn(),
      onCameraDevice: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    const root = () =>
      document.querySelector<HTMLElement>("[data-testid='video-grid']") ??
      popup.doc.querySelector<HTMLElement>("[data-testid='video-grid']")!;
    const popButton = () =>
      root().querySelector<HTMLButtonElement>("[data-grid-control='popout']")!;
    const barButton = (id: string) =>
      root().querySelector<HTMLButtonElement>(`.video-grid__controls [data-call-control='${id}']`)!;
    const exit = () => root().querySelector<HTMLButtonElement>("[data-tile-control='exit-grid']")!;

    beforeEach(() => {
      localStorage.clear();
      document.body.appendChild(container);
      vi.useFakeTimers();
      popup = fakePopup();
      focusWindow = vi.fn();
      Object.assign(popup.win, { focus: focusWindow });
      open = vi.fn(() => popup.win as unknown as Window);
      vi.stubGlobal("open", open);
    });

    afterEach(() => {
      grid.destroy?.();
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function startCall() {
      const cc = controls();
      const onCallPopout = vi.fn();
      grid.setCallbacks({ callControls: cc, onCallPopout });
      grid.setExitVisible(true);
      grid.addStream(OTTO, "Otto", fakeStream(), makeTileConfig({ audioUserId: OTTO }));
      return { cc, onCallPopout };
    }

    it("offers Pop out only in the call view", () => {
      grid.setCallbacks({ callControls: controls() });
      expect(container.querySelector("[data-grid-control='popout']")).toBeNull();
      grid.setExitVisible(true);
      expect(popButton().getAttribute("aria-label")).toBe("Pop out call");
      expect(popButton().getAttribute("aria-pressed")).toBe("false");
    });

    it("moves the grid, its toggles and the control bar into a window of its own", () => {
      const { onCallPopout } = startCall();
      const grid0 = root();
      const video = grid0.querySelector("video")!;

      popButton().click();

      expect(open).toHaveBeenCalledTimes(1);
      expect(String(open.mock.calls[0]![1])).toMatch(/^owncord-popout-\d+$/);
      expect(popup.doc.title).toBe("Call — OwnCord");
      expect(container.querySelector("[data-testid='video-grid']")).toBeNull();
      expect(popup.doc.body.contains(grid0)).toBe(true);
      expect(grid0.querySelector("video")).toBe(video);
      expect(grid0.querySelector(".video-grid__views")).not.toBeNull();
      expect(grid0.querySelector(".video-grid__controls")).not.toBeNull();
      expect(onCallPopout).toHaveBeenCalledWith(true, false);
      expect(popButton().getAttribute("aria-pressed")).toBe("true");
      expect(popButton().getAttribute("aria-label")).toBe("Bring the call back");
      // No Show chat in the window (the app window shows the chat), and no
      // camera picker (its menu opens in the app window).
      expect(exit().hidden).toBe(true);
      expect(barButton("camera-device").style.display).toBe("none");
    });

    it("keeps the call controls working in the pop-out", () => {
      const { cc } = startCall();
      popButton().click();

      barButton("mute").click();
      barButton("leave").click();
      expect(cc.onMuteToggle).toHaveBeenCalledTimes(1);
      expect(cc.onLeave).toHaveBeenCalledTimes(1);

      grid.setCallState({ muted: true, deafened: false, listenOnly: false });
      expect(barButton("mute").getAttribute("aria-pressed")).toBe("true");
    });

    it("brings the call back to the app window before a share picker opens there", () => {
      const { cc, onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      barButton("share").click();

      expect(container.contains(grid0)).toBe(true);
      expect(onCallPopout).toHaveBeenLastCalledWith(false, true);
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
    });

    it("stops a share from the pop-out without leaving it", () => {
      const { cc } = startCall();
      grid.setCallState({ muted: false, deafened: false, listenOnly: false, screenshare: true });
      popButton().click();

      barButton("share").click();

      expect(popup.doc.body.contains(root())).toBe(true);
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
    });

    it("brings the grid back to the app window with Bring back", () => {
      const { onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      popButton().click();

      expect(popup.win.close).toHaveBeenCalled();
      expect(container.contains(grid0)).toBe(true);
      expect(grid0.querySelector(".video-grid__controls")).not.toBeNull();
      expect(onCallPopout).toHaveBeenLastCalledWith(false, true);
      expect(popButton().getAttribute("aria-pressed")).toBe("false");
      expect(exit().hidden).toBe(false);
      expect(barButton("camera-device").style.display).toBe("");
      expect(document.activeElement).toBe(popButton());
    });

    it("brings the grid back when the user closes the window", () => {
      const { onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      popup.win.closed = true;
      vi.advanceTimersByTime(300);

      expect(container.contains(grid0)).toBe(true);
      expect(onCallPopout).toHaveBeenLastCalledWith(false, true);
    });

    it("closes the window without restoring when the call view ends", () => {
      const { onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      grid.setExitVisible(false);

      expect(popup.win.close).toHaveBeenCalled();
      expect(container.contains(grid0)).toBe(true);
      expect(onCallPopout).toHaveBeenLastCalledWith(false, false);
      expect(grid0.querySelector(".video-grid__controls")).toBeNull();
    });

    it("closes the window when the grid is torn down", () => {
      startCall();
      popButton().click();
      grid.destroy?.();
      expect(popup.win.close).toHaveBeenCalled();
    });

    it("stays in the app window, with a toast, when no window opens", () => {
      vi.stubGlobal("open", () => null);
      const { onCallPopout } = startCall();
      popButton().click();
      expectConsole("warn", "Call pop out window refused");
      expect(mockShowToast).toHaveBeenCalledWith("Couldn't open the pop-out window", "error");
      expect(container.querySelector("[data-testid='video-grid']")).not.toBeNull();
      expect(onCallPopout).not.toHaveBeenCalled();
      expect(popButton().getAttribute("aria-pressed")).toBe("false");
    });

    it("raises the window rather than moving the call back", () => {
      startCall();
      expect(grid.raiseCallPopout()).toBe(false);
      popButton().click();
      expect(grid.raiseCallPopout()).toBe(true);
      expect(focusWindow).toHaveBeenCalledTimes(1);
      expect(popup.doc.body.contains(root())).toBe(true);
    });

    it("opens a tile's menu in the pop-out, without the profile card", async () => {
      grid.setCallbacks({
        callControls: controls(),
        tileMenu: { onProfile: vi.fn(), onMessage: vi.fn() },
      });
      grid.setExitVisible(true);
      grid.addStream(OTTO, "Otto", fakeStream(), makeTileConfig({ audioUserId: OTTO }));
      popButton().click();

      root()
        .querySelector(`.video-cell[data-user-id='${OTTO}']`)!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.dynamicImportSettled();

      const menu = popup.doc.querySelector<HTMLElement>(".video-tile-menu");
      expect(menu).not.toBeNull();
      expect(document.querySelector(".video-tile-menu")).toBeNull();
      expect(menu!.querySelector("[data-action='profile']")).toBeNull();
      expect(menu!.querySelector("[data-action='message']")).not.toBeNull();
    });

    it("follows full screen in the pop-out's own document and window", () => {
      const setWindowFullscreen = vi.fn(() => Promise.resolve());
      grid.setCallbacks({ callControls: controls(), setWindowFullscreen });
      grid.setExitVisible(true);
      grid.addStream(OTTO, "Otto", fakeStream(), makeTileConfig({ audioUserId: OTTO }));
      popButton().click();
      const label = String(open.mock.calls[0]![1]);
      const tile = root().querySelector(`.video-cell[data-user-id='${OTTO}']`)!;

      popup.enterFullscreen(tile);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, label);
      expect(tile.querySelector(".video-fs-calls")).not.toBeNull();

      // Closing the window ends its full screen; the app window's is untouched.
      popup.win.closed = true;
      vi.advanceTimersByTime(300);
      expect(tile.querySelector(".video-fs-calls")).toBeNull();
      expect(setWindowFullscreen).not.toHaveBeenCalledWith(false);
    });
  });
});
