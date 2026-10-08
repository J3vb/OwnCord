import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cascadedDeclaration, keyword } from "../helpers/app-css";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing VideoGrid
// ---------------------------------------------------------------------------

const mockMuteScreenshareAudio = vi.fn();
const mockSetScreenshareAudioVolume = vi.fn();
const mockSetUserVolume = vi.fn();
const mockGetScreenshareAudioMuted = vi.fn((_userId?: unknown) => false);
const mockGetScreenshareAudioVolume = vi.fn((_userId?: unknown) => 1);
const mockGetUserVolume = vi.fn((_userId?: unknown) => 100);
const mockGetRemoteVideoStream = vi.fn((..._args: unknown[]): MediaStream | null => null);
const mockSetRemoteVideoView = vi.fn();

vi.mock("@lib/livekitSession", () => ({
  muteScreenshareAudio: (...args: unknown[]) => mockMuteScreenshareAudio(...args),
  setScreenshareAudioVolume: (...args: unknown[]) => mockSetScreenshareAudioVolume(...args),
  setUserVolume: (...args: unknown[]) => mockSetUserVolume(...args),
  getScreenshareAudioMuted: (userId: unknown) => mockGetScreenshareAudioMuted(userId),
  getScreenshareAudioVolume: (userId: unknown) => mockGetScreenshareAudioVolume(userId),
  getUserVolume: (userId: unknown) => mockGetUserVolume(userId),
  getRemoteVideoStream: (...args: unknown[]) => mockGetRemoteVideoStream(...args),
  setRemoteVideoView: (...args: unknown[]) => mockSetRemoteVideoView(...args),
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
import { RemoteTracks, type VideoView } from "../../src/features/voice/remoteTracks";
import { attachStreamPreview } from "../../src/lib/streamPreview";
import { VideoQuality, type Room } from "livekit-client";

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

    it("mute button toggles mic audio when isScreenshare=false", () => {
      const config = makeTileConfig({ isSelf: false, audioUserId: 55, isScreenshare: false });
      grid.addStream(55, "charlie", fakeStream(), config);

      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;

      muteBtn.click();
      expect(mockSetUserVolume).toHaveBeenCalledWith(55, 0);

      muteBtn.click();
      expect(mockSetUserVolume).toHaveBeenCalledWith(55, 100);
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

    it("mic slider keeps the 0-200 boost range", () => {
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

      // Set volume to 150 via slider
      slider.value = "150";
      slider.dispatchEvent(new Event("input"));
      mockSetUserVolume.mockClear();

      // Mute via button
      muteBtn.click();
      expect(mockSetUserVolume).toHaveBeenCalledWith(77, 0);
      expect(slider.value).toBe("0");

      // Unmute via button — should restore to 150
      muteBtn.click();
      expect(mockSetUserVolume).toHaveBeenCalledWith(77, 150);
      expect(slider.value).toBe("150");
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

      voice.value = "150";
      voice.dispatchEvent(new Event("input"));
      expect(mockSetUserVolume).toHaveBeenCalledWith(2, 150);
      stream.value = "30";
      stream.dispatchEvent(new Event("input"));
      expect(mockSetScreenshareAudioVolume).toHaveBeenCalledWith(2, 0.3);

      const labels = [...menu.querySelectorAll("[role='menuitem']")].map((m) => m.textContent);
      expect(labels).toEqual(expect.arrayContaining(["Mute stream", "Stop watching"]));
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
      voice.value = "150";
      voice.dispatchEvent(new Event("input"));

      expect(cell(2).querySelector("output")!.textContent).toBe("150%");
      // The screen-share tile's own slider is the stream volume, not the voice.
      expect(cell(SCREEN).querySelector("output")!.textContent).toBe("100%");
      // Mute then unmute on the camera tile keeps the 150, not a stale 100.
      const mute = cell(2).querySelector<HTMLButtonElement>(".tile-mute-btn")!;
      mute.click();
      mute.click();
      expect(mockSetUserVolume).toHaveBeenLastCalledWith(2, 150);
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
      delete (document as { pictureInPictureEnabled?: unknown }).pictureInPictureEnabled;
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

    it("writes the self-share quality as 1080p, not 1,080p", () => {
      const track = {
        id: "t",
        kind: "video",
        muted: false,
        getSettings: () => ({ height: 1080, frameRate: 30 }),
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const stream = {
        getTracks: () => [track],
        getVideoTracks: () => [track],
        getAudioTracks: () => [],
      } as unknown as MediaStream;
      grid.addStream(1 + 1_000_000, "Your Screen", stream, {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: true,
      });
      expect(cell(1 + 1_000_000).querySelector(".video-self-detail")!.textContent).toContain(
        "1080p · 30 fps",
      );
    });

    it("offers Pop out only where picture-in-picture works", async () => {
      Object.defineProperty(document, "pictureInPictureEnabled", {
        configurable: true,
        value: false,
      });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      expect(control(SCREEN, "pip").hidden).toBe(true);

      grid.removeStream(SCREEN);
      Object.defineProperty(document, "pictureInPictureEnabled", {
        configurable: true,
        value: true,
      });
      const requestPip = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(HTMLVideoElement.prototype, "requestPictureInPicture", {
        configurable: true,
        value: requestPip,
      });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const pip = control(SCREEN, "pip");
      expect(pip.hidden).toBe(false);
      expect(pip.getAttribute("aria-label")).toBe("Pop out");
      pip.click();
      expect(requestPip).toHaveBeenCalledTimes(1);
      delete (HTMLVideoElement.prototype as { requestPictureInPicture?: unknown })
        .requestPictureInPicture;
    });

    it("brings a popped-out stream into full screen, and leaves it in the grid after", async () => {
      let pipElement: Element | null = null;
      const popOut = (el: Element): void => {
        pipElement = el;
      };
      const requestPip = vi.fn(function (this: HTMLVideoElement) {
        popOut(this);
        return Promise.resolve();
      });
      const exitPip = vi.fn(() => {
        pipElement = null;
        return Promise.resolve();
      });
      Object.defineProperty(document, "pictureInPictureElement", {
        configurable: true,
        get: () => pipElement,
      });
      Object.defineProperty(document, "exitPictureInPicture", {
        configurable: true,
        value: exitPip,
      });
      Object.defineProperty(HTMLVideoElement.prototype, "requestPictureInPicture", {
        configurable: true,
        value: requestPip,
      });
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        control(SCREEN, "pip").click();
        expect(pipElement).toBe(cell(SCREEN).querySelector("video"));

        control(SCREEN, "fullscreen").click();
        await Promise.resolve();
        expect(exitPip).toHaveBeenCalledTimes(1);
        expect(pipElement).toBeNull();
        expect(fullscreenElement).toBe(cell(SCREEN));

        control(SCREEN, "fullscreen").click();
        await Promise.resolve();
        expect(fullscreenElement).toBeNull();
        expect(requestPip).toHaveBeenCalledTimes(1);
        expect(pipElement).toBeNull();
        expect(cell(SCREEN).isConnected).toBe(true);

        exitPip.mockClear();
        requestPip.mockClear();
        control(SCREEN, "fullscreen").click();
        await Promise.resolve();
        control(SCREEN, "fullscreen").click();
        await Promise.resolve();
        expect(exitPip).not.toHaveBeenCalled();
        expect(requestPip).not.toHaveBeenCalled();
      } finally {
        delete (HTMLVideoElement.prototype as { requestPictureInPicture?: unknown })
          .requestPictureInPicture;
        delete (document as { exitPictureInPicture?: unknown }).exitPictureInPicture;
        delete (document as { pictureInPictureElement?: unknown }).pictureInPictureElement;
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
      // The sidebar hover preview reports through the session to the same tracks.
      mockSetRemoteVideoView.mockImplementation(
        (uid: number, type: "camera" | "screenshare", view: VideoView, preview?: boolean) =>
          tracks.setRemoteVideoView(uid, type, view, preview),
      );
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
      delete (document as { pictureInPictureElement?: unknown }).pictureInPictureElement;
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

    it("an open hover preview stops its video too while the app is hidden, and resumes at its size when shown", () => {
      addCameras();
      const { stream } = fakeStreamWithTrack();
      mockGetRemoteVideoStream.mockReturnValue(stream);
      vi.spyOn(HTMLVideoElement.prototype, "play").mockResolvedValue(undefined);
      const row = document.createElement("div");
      row.dataset["userId"] = "voice-row";
      sizes.set("voice-row", { width: 240, height: 40 });
      document.body.appendChild(row);
      const previews = new AbortController();
      attachStreamPreview(row, 2, "Otto", false, true, previews.signal);
      row.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      const width = Math.round(240 * devicePixelRatio);
      const previewSize = { width, height: Math.round((width * 9) / 16) };

      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(false);

      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(true);

      // The grid closes while the preview stays open: the preview's layer.
      resize({ 1: [0, 0], 2: [0, 0], 3: [0, 0] });
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(false);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(true);
      expect(pub(2).setVideoDimensions).toHaveBeenLastCalledWith(previewSize);
      previews.abort();
      row.remove();
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

    it("a popped-out tile keeps its video at the top layer while the grid is hidden", () => {
      addCameras();
      const video = cellOf(2).querySelector("video")!;
      Object.defineProperty(document, "pictureInPictureElement", {
        configurable: true,
        get: () => video,
      });
      video.dispatchEvent(new Event("enterpictureinpicture"));
      resize({ 1: [0, 0], 2: [0, 0], 3: [0, 0] });
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(true);
      expect(pub(2).setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
      expect(enabled(3)).toBe(false);
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
});
