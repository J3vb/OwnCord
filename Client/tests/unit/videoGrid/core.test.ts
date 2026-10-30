import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { cascadedDeclaration } from "../../helpers/app-css";
import { computeGridLayout, type VideoGridComponent } from "../../../src/components/VideoGrid";
import {
  fakeStream,
  fakeStreamWithTrack,
  makeTileConfig,
  useVideoGridHarness,
} from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const {
  mockMuteScreenshareAudio,
  mockSetScreenshareAudioVolume,
  mockSetUserVolume,
  mockGetScreenshareAudioMuted,
  mockGetScreenshareAudioVolume,
  mockGetUserVolume,
  mockGetUserLocalMute,
  mockSetUserLocalMute,
} = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VideoGrid", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  useVideoGridHarness({
    wired: (c, g) => {
      container = c;
      grid = g;
    },
    currentGrid: () => grid,
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

    it("mute button toggles the user's local Mute when isScreenshare=false", () => {
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

    it("seeds the mic-tile slider from the persisted per-user volume, not a hardcoded 100%", () => {
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

    it("starts a mic tile muted when the persisted per-user volume is 0", () => {
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

    it("mic slider tops out at 200%", () => {
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

  describe("Ctrl + wheel zoom and drag pan", () => {
    const tile = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const zoomIn = (el: Element): void => {
      for (let i = 0; i < 5; i++) {
        el.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -1, ctrlKey: true, bubbles: true, cancelable: true }),
        );
      }
    };
    const scaleOf = (el: HTMLElement): number =>
      Number(el.style.getPropertyValue("--video-scale") || "1");

    it("zooms a webcam and a screen share, and leaves a plain wheel to scroll", () => {
      grid.addStream(1, "Alice", fakeStream(), makeTileConfig());
      grid.addStream(2, "Bob (Screen)", fakeStream(), makeTileConfig({ isScreenshare: true }));
      const plain = new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true });
      tile(1).dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(scaleOf(tile(1))).toBe(1);

      zoomIn(tile(1).querySelector("video")!);
      zoomIn(tile(2).querySelector(".video-cell-select")!);
      expect(scaleOf(tile(1))).toBeGreaterThan(2);
      expect(scaleOf(tile(2))).toBeGreaterThan(2);
    });

    it("a drag that pans a zoomed tile does not open it in focus view", () => {
      grid.addStream(1, "Alice", fakeStream(), makeTileConfig());
      grid.addStream(2, "Bob", fakeStream(), makeTileConfig());
      const select = tile(1).querySelector<HTMLButtonElement>(".video-cell-select")!;
      zoomIn(select);
      const at = (type: string, x: number) =>
        new MouseEvent(type, { clientX: x, clientY: 50, bubbles: true, cancelable: true });

      select.dispatchEvent(at("mousedown", 50));
      document.dispatchEvent(at("mousemove", 120));
      document.dispatchEvent(at("mouseup", 120));
      select.dispatchEvent(at("click", 120));
      expect(grid.getFocusedTileId()).toBeNull();

      select.dispatchEvent(at("mousedown", 50));
      document.dispatchEvent(at("mouseup", 50));
      select.dispatchEvent(at("click", 50));
      expect(grid.getFocusedTileId()).toBe(1);
    });

    it("a new stream on a zoomed tile starts unzoomed", () => {
      grid.addStream(1, "Alice", fakeStreamWithTrack().stream, makeTileConfig());
      zoomIn(tile(1));
      expect(scaleOf(tile(1))).toBeGreaterThan(1);

      grid.addStream(1, "Alice", fakeStreamWithTrack().stream, makeTileConfig());
      expect(scaleOf(tile(1))).toBe(1);
      expect(tile(1).classList.contains("video-zoomed")).toBe(false);
    });

    it("a stopped tile drops its zoom", () => {
      grid.addStream(2, "Bob (Screen)", fakeStream(), makeTileConfig({ isScreenshare: true }));
      zoomIn(tile(2));
      tile(2).querySelector<HTMLButtonElement>("[data-tile-control='stop']")!.click();
      expect(scaleOf(tile(2))).toBe(1);
    });

    it("your own screen share, which shows its cover, does not zoom", () => {
      grid.addStream(
        1,
        "Your screen",
        fakeStream(),
        makeTileConfig({ isSelf: true, isScreenshare: true }),
      );
      zoomIn(tile(1));
      expect(scaleOf(tile(1))).toBe(1);
    });

    it("the picture takes the view through the individual transform properties", () => {
      for (const sel of [".video-cell video", ".video-popout video"]) {
        expect(cascadedDeclaration(sel, "scale")).not.toBeNull();
        expect(cascadedDeclaration(sel, "translate")).not.toBeNull();
      }
    });
  });
});
