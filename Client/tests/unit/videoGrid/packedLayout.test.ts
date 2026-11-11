import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { packTiles } from "../../../src/features/voice/videoGrid/packLayout";
import { aspectMoved, tileSizeOf } from "../../../src/features/voice/videoGrid/gridSizing";
import { SURFACE_RESIZE_EVENT } from "../../../src/lib/voice/videoSurface";
import type { VideoGridComponent } from "../../../src/features/voice/videoGrid/VideoGrid";
import {
  fakePopup,
  fakeStream,
  makeTileConfig,
  useVideoGridHarness,
} from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const SHARE = 7 + 1_000_000;

describe("VideoGrid packed layout", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;
  let gridSize = { width: 2000, height: 700 };
  let popupSize = { width: 900, height: 500 };

  useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  const tile = (id: number): HTMLElement =>
    document.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
  const px = (el: HTMLElement, prop: "width" | "height" | "left" | "top"): number =>
    parseFloat(el.style[prop]);

  function sizeVideo(id: number, width: number, height: number): HTMLVideoElement {
    const video = tile(id).querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: width });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: height });
    return video;
  }

  function addCamera(id: number): void {
    grid.addStream(id, `User ${id}`, fakeStream(), makeTileConfig({ audioUserId: id }));
  }

  beforeEach(() => {
    gridSize = { width: 2000, height: 700 };
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const size = this.ownerDocument === document ? gridSize : popupSize;
      return { ...size, top: 0, left: 0, right: size.width, bottom: size.height } as DOMRect;
    });
  });

  afterEach(() => {
    grid.destroy?.();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws a 32:9 screen share in its own shape, largest of the tiles", () => {
    addCamera(2);
    addCamera(3);
    grid.addStream(SHARE, "Otto (Screen)", fakeStream(), makeTileConfig({ isScreenshare: true }));
    sizeVideo(2, 1280, 720);
    sizeVideo(3, 1280, 720);
    sizeVideo(SHARE, 5120, 1440).dispatchEvent(new Event("loadedmetadata"));
    vi.advanceTimersByTime(50);

    const share = tile(SHARE);
    const shape = px(share, "width") / px(share, "height");
    expect(Math.abs(shape - 32 / 9)).toBeLessThan(0.15);
    const area = (el: HTMLElement): number => px(el, "width") * px(el, "height");
    expect(area(share)).toBeGreaterThan(area(tile(2)));
    expect(area(share)).toBeGreaterThan(area(tile(3)));
    expect(px(tile(2), "width") / px(tile(2), "height")).toBeCloseTo(16 / 9, 1);
  });

  describe("re-packing on a change of shape", () => {
    function settle(): void {
      addCamera(2);
      sizeVideo(2, 1280, 720).dispatchEvent(new Event("loadedmetadata"));
      vi.advanceTimersByTime(50);
    }

    it("packs again when the picture's aspect moves more than 2%", () => {
      settle();
      const before = px(tile(2), "width") / px(tile(2), "height");
      sizeVideo(2, 1000, 1000).dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(50);
      const after = px(tile(2), "width") / px(tile(2), "height");
      expect(before).toBeGreaterThan(1.7);
      expect(after).toBeCloseTo(1, 1);
    });

    it("does not pack again for a change under 2%", () => {
      settle();
      const frames = vi.spyOn(window, "requestAnimationFrame");
      sizeVideo(2, 1280, 713).dispatchEvent(new Event("resize"));
      expect(frames).not.toHaveBeenCalled();
      sizeVideo(2, 1280, 600).dispatchEvent(new Event("resize"));
      expect(frames).toHaveBeenCalledTimes(1);
    });

    it("packs again when a canvas-drawn picture in the tile changes size", () => {
      settle();
      sizeVideo(2, 1000, 1000).dispatchEvent(new Event(SURFACE_RESIZE_EVENT, { bubbles: true }));
      vi.advanceTimersByTime(50);
      expect(px(tile(2), "width") / px(tile(2), "height")).toBeCloseTo(1, 1);
    });

    it("stops listening when the tile goes", () => {
      settle();
      const video = tile(2).querySelector("video")!;
      grid.removeStream(2);
      const frames = vi.spyOn(window, "requestAnimationFrame");
      Object.defineProperty(video, "videoWidth", { configurable: true, value: 10 });
      video.dispatchEvent(new Event("resize"));
      expect(frames).not.toHaveBeenCalled();
    });
  });

  it("lays the call out against the window it was popped out into", () => {
    grid.setCallbacks({
      callControls: {
        onMuteToggle: vi.fn(),
        onDeafenToggle: vi.fn(),
        onLeave: vi.fn(),
      },
    });
    grid.setExitVisible(true);
    addCamera(2);
    const popup = fakePopup();
    vi.stubGlobal("open", () => popup.win);
    document.querySelector<HTMLButtonElement>("[data-grid-control='popout']")!.click();
    vi.advanceTimersByTime(50);

    const cell = popup.doc.querySelector<HTMLElement>(".video-cell[data-user-id='2']")!;
    // Room for the control bar comes off the window's height.
    const [rect] = packTiles(popupSize.width, popupSize.height - 56, [
      { id: 0, aspect: 16 / 9, size: "medium" },
    ]);
    expect(px(cell, "width")).toBe(rect!.w);
    expect(px(cell, "height")).toBe(rect!.h);
    expect(px(cell, "top")).toBe(rect!.y);
  });

  it("clears the inline places in focus mode and packs again on the way out", () => {
    addCamera(2);
    addCamera(3);
    vi.advanceTimersByTime(50);
    const root = document.querySelector<HTMLElement>("[data-testid='video-grid']")!;
    expect(root.classList.contains("video-grid--packed")).toBe(true);
    const packed = tile(3).style.left;
    expect(packed).not.toBe("");

    tile(2).querySelector<HTMLButtonElement>("[data-tile-control='select']")!.click();
    expect(root.classList.contains("video-grid--packed")).toBe(false);
    for (const id of [2, 3]) {
      for (const prop of ["left", "top", "width", "height"] as const) {
        expect(tile(id).style[prop]).toBe("");
      }
    }

    tile(2).querySelector<HTMLButtonElement>("[data-tile-control='grid']")!.click();
    expect(root.classList.contains("video-grid--packed")).toBe(true);
    expect(tile(3).style.left).toBe(packed);
    expect(px(tile(3), "width")).toBeGreaterThan(0);
  });

  it("marks a tile the packer gives no width as having no room, and frees it again", () => {
    gridSize = { width: 20, height: 20 };
    addCamera(2);
    addCamera(3);
    for (const id of [2, 3]) expect(tile(id).classList.contains("video-cell--no-room")).toBe(true);
    expect(tile(2).hidden).toBe(false);

    gridSize = { width: 2000, height: 700 };
    grid.addStream(4, "User 4", fakeStream(), makeTileConfig({ audioUserId: 4 }));
    for (const id of [2, 3, 4]) {
      expect(tile(id).classList.contains("video-cell--no-room")).toBe(false);
    }
  });

  it("keeps the tiles in the flow until the grid has a size", () => {
    gridSize = { width: 0, height: 0 };
    addCamera(2);
    vi.advanceTimersByTime(50);
    const root = document.querySelector<HTMLElement>("[data-testid='video-grid']")!;
    expect(root.classList.contains("video-grid--packed")).toBe(false);
    expect(tile(2).style.left).toBe("");

    gridSize = { width: 2000, height: 700 };
    addCamera(3);
    vi.advanceTimersByTime(50);
    expect(root.classList.contains("video-grid--packed")).toBe(true);
    expect(px(tile(2), "width")).toBeGreaterThan(0);
  });

  it("asks for the default tile sizes and a 2% aspect tolerance", () => {
    const entry = (isScreenshare: boolean) =>
      ({ config: makeTileConfig({ isScreenshare }) }) as unknown as Parameters<
        typeof tileSizeOf
      >[0];
    expect(tileSizeOf(entry(true))).toBe("large");
    expect(tileSizeOf(entry(false))).toBe("medium");
    expect(tileSizeOf(undefined)).toBe("medium");
    expect(aspectMoved(undefined, 1.5)).toBe(true);
    expect(aspectMoved(1.5, 1.52)).toBe(false);
    expect(aspectMoved(1.5, 1.54)).toBe(true);
  });
});
