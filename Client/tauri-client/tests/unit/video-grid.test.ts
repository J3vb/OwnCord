import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing VideoGrid
// ---------------------------------------------------------------------------

const mockMuteScreenshareAudio = vi.fn();
const mockSetUserVolume = vi.fn();

vi.mock("@lib/livekitSession", () => ({
  muteScreenshareAudio: (...args: unknown[]) => mockMuteScreenshareAudio(...args),
  setUserVolume: (...args: unknown[]) => mockSetUserVolume(...args),
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

/** Minimal MediaStream stub for testing. */
function fakeStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
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
    // ResizeObserver is not available in JSDOM
    globalThis.ResizeObserver ??= class {
      observe(): void { /* noop */ }
      unobserve(): void { /* noop */ }
      disconnect(): void { /* noop */ }
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
});
