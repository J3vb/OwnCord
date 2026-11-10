import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindVideoZoom } from "../../../../src/lib/ui/zoomPan";
import { videoZoomFrame } from "../../../../src/lib/ui/videoZoomNavigator";

describe("video zoom navigator geometry", () => {
  it("shows half of each source dimension at 200%, and a quarter at 400%", () => {
    for (const scale of [2, 4, 8]) {
      const box = videoZoomFrame(800, 450, 3840, 2160, { scale, x: 0, y: 0 });
      expect(box.width).toBeCloseTo(1 / scale);
      expect(box.height).toBeCloseTo(1 / scale);
      expect(box.left).toBeCloseTo((1 - 1 / scale) / 2);
      expect(box.top).toBeCloseTo((1 - 1 / scale) / 2);
    }
  });

  it("accounts for letterboxing, pillarboxing, and source aspect ratio", () => {
    const wide = videoZoomFrame(800, 600, 3840, 1080, { scale: 2, x: -400, y: 0 });
    expect(wide.left).toBeCloseTo(0.5);
    expect(wide.width).toBeCloseTo(0.5);
    expect(wide.top).toBe(0);
    expect(wide.height).toBe(1);
    const portrait = videoZoomFrame(800, 450, 1080, 1920, { scale: 2, x: 0, y: 0 });
    expect(portrait.left).toBe(0);
    expect(portrait.width).toBe(1);
    expect(portrait.top).toBeCloseTo(0.25);
    expect(portrait.height).toBeCloseTo(0.5);
  });
});

describe("video zoom navigator lifecycle and interaction", () => {
  let scope: AbortController | undefined;
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    scope?.abort();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  function mount(streamType = "screenshare") {
    const host = document.createElement("div");
    host.dataset.streamType = streamType;
    const video = document.createElement("video");
    Object.defineProperties(video, {
      srcObject: { configurable: true, value: { getVideoTracks: () => [] } },
      videoWidth: { value: 3840 },
      videoHeight: { value: 2160 },
    });
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 450 },
    });
    host.getBoundingClientRect = () => new DOMRect(0, 0, 800, 450);
    host.append(video);
    document.body.append(host);
    scope = new AbortController();
    const view = bindVideoZoom(host, scope.signal);
    return { host, view, video };
  }

  it("creates no overview at 100%, scales its viewport, and hides and recentres on reset", () => {
    const { host, view } = mount();
    expect(host.querySelector(".video-zoom-nav")).toBeNull();
    view.setScale(2);
    const root = host.querySelector<HTMLElement>(".video-zoom-nav")!;
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".video-zoom-nav__percent")?.textContent).toBe("200%");
    expect(root.querySelector("canvas")!.width).toBe(192);
    view.setScale(4);
    expect(root.querySelector(".video-zoom-nav__percent")?.textContent).toBe("400%");
    view.panBy(300, -100);
    root.querySelector<HTMLButtonElement>(".video-zoom-nav__reset")!.click();
    expect(root.hidden).toBe(true);
    expect(view.scale).toBe(1);
    expect(view.x).toBe(0);
    expect(view.y).toBe(0);
  });

  it("moves the viewport in the arrow direction without passing a source edge", () => {
    const { host, view } = mount();
    view.setScale(2);
    const map = host.querySelector<HTMLButtonElement>(".video-zoom-nav__map")!;
    for (let i = 0; i < 50; i++) {
      map.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
    expect(view.x).toBe(-400);
    expect(host.style.getPropertyValue("--video-pan")).toBe("-400px 0px");
    map.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(view.y).toBeLessThan(0);
  });

  it("keeps cameras free of the overview", () => {
    const { host, view } = mount("camera");
    view.setScale(4);
    expect(host.querySelector(".video-zoom-nav")).toBeNull();
  });

  it("draws the visible area over the decoded frame and stops copying at 100%", () => {
    vi.useFakeTimers();
    const ctx = { drawImage: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), clearRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    const { view, video } = mount();
    Object.defineProperty(video, "readyState", { value: 2 });
    view.setScale(2);
    expect(ctx.drawImage).toHaveBeenLastCalledWith(video, 0, 0, 192, 108);
    expect(ctx.strokeRect).toHaveBeenLastCalledWith(49, 28, 94, 52);
    view.panBy(-400, 225);
    expect(ctx.strokeRect).toHaveBeenLastCalledWith(97, 1, 94, 52);
    view.reset();
    const copies = ctx.drawImage.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(ctx.drawImage).toHaveBeenCalledTimes(copies);
  });

  it("drags inside the map without jumping, and cancels the document listeners on close", () => {
    const { host, view } = mount();
    view.setScale(2);
    const map = host.querySelector<HTMLButtonElement>(".video-zoom-nav__map")!;
    Object.defineProperties(map, { clientWidth: { value: 192 }, clientHeight: { value: 108 } });
    map.getBoundingClientRect = () => new DOMRect(0, 0, 192, 108);
    const pointer = (type: string, x: number, y: number) =>
      new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
    map.dispatchEvent(pointer("pointerdown", 96, 54));
    expect(view.x).toBe(0);
    expect(view.y).toBe(0);
    document.dispatchEvent(pointer("pointermove", 150, 70));
    expect(view.x).toBeLessThan(0);
    expect(view.y).toBeLessThan(0);
    const position = [view.x, view.y];
    scope!.abort();
    document.dispatchEvent(pointer("pointermove", 0, 0));
    expect([view.x, view.y]).toEqual(position);
  });

  it("removes its DOM and ignores further view changes once the owner closes", () => {
    const { host, view } = mount();
    view.setScale(2);
    scope!.abort();
    expect(host.querySelector(".video-zoom-nav")).toBeNull();
    view.setScale(4);
    expect(host.querySelector(".video-zoom-nav")).toBeNull();
  });
});
