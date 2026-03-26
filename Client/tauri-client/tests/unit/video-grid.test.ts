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

  describe("grid layout updates correctly for different user counts", () => {
    function getGridColumns(): string {
      const root = container.querySelector(".video-grid") as HTMLElement;
      return root.style.gridTemplateColumns;
    }

    it("1 user: 1fr", () => {
      grid.addStream(1, "Alice", fakeStream());
      expect(getGridColumns()).toBe("1fr");
    });

    it("2 users: 1fr 1fr", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());
      expect(getGridColumns()).toBe("1fr 1fr");
    });

    it("4 users: 1fr 1fr", () => {
      for (let i = 1; i <= 4; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr");
    });

    it("5 users: 1fr 1fr 1fr", () => {
      for (let i = 1; i <= 5; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr");
    });

    it("9 users: 1fr 1fr 1fr", () => {
      for (let i = 1; i <= 9; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr");
    });

    it("10 users: 1fr 1fr 1fr 1fr", () => {
      for (let i = 1; i <= 10; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr 1fr");
    });

    it("layout updates when streams are removed", () => {
      for (let i = 1; i <= 5; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr");

      grid.removeStream(5);
      expect(getGridColumns()).toBe("1fr 1fr");
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
  });
});
