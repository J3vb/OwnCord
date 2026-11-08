import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackPickerCategory } from "../../../../src/features/messaging/pickerScroll";
import { useMountContainer } from "../../../helpers/mountContainer";
import { stubCapturingResizeObserver } from "../../../helpers/resizeObserverStub";

describe("emoji picker scrolling", () => {
  let root: HTMLDivElement;
  let scope: AbortController;
  let frames: Map<number, FrameRequestCallback>;
  let resizes: Array<() => void>;
  let nextFrame: number;

  useMountContainer((container) => {
    root = container;
  });

  beforeEach(() => {
    scope = new AbortController();
    frames = new Map();
    resizes = [];
    nextFrame = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
    stubCapturingResizeObserver(resizes);
  });

  afterEach(() => {
    scope.abort();
    vi.unstubAllGlobals();
  });

  function flushFrame(): void {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  }

  function fixture() {
    const bar = document.createElement("div");
    const area = document.createElement("div");
    root.append(bar, area);
    const reads = [0, 200, 400].map((top, i) => {
      const label = document.createElement("div");
      label.className = "ep-category-label";
      label.dataset.category = String(i);
      const read = vi.fn(() => top);
      Object.defineProperty(label, "offsetTop", { get: read });
      area.appendChild(label);
      const button = document.createElement("button");
      button.className = "ep-category-btn";
      button.dataset.category = String(i);
      bar.appendChild(button);
      return read;
    });
    const refresh = trackPickerCategory(area, bar, scope.signal);
    refresh();
    flushFrame();
    return { area, bar, reads, refresh };
  }

  it("coalesces fast scrolling and reuses measured category positions", () => {
    const { area, bar, reads } = fixture();
    expect(bar.querySelector(".active")?.getAttribute("data-category")).toBe("0");
    for (let i = 0; i < 20; i++) {
      area.scrollTop = 450;
      area.dispatchEvent(new Event("scroll"));
    }
    expect(frames.size).toBe(1);
    flushFrame();
    expect(bar.querySelector(".active")?.getAttribute("data-category")).toBe("2");
    reads.forEach((read) => expect(read).toHaveBeenCalledOnce());
    area.scrollTop = 0;
    area.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(bar.querySelector(".active")?.getAttribute("data-category")).toBe("0");
    reads.forEach((read) => expect(read).toHaveBeenCalledOnce());
  });

  it("measures again after resizing or rebuilding the categories", () => {
    const { area, bar, reads, refresh } = fixture();
    reads[1]!.mockReturnValue(100);
    reads[2]!.mockReturnValue(180);
    area.scrollTop = 190;
    resizes[0]!();
    flushFrame();
    expect(bar.querySelector(".active")?.getAttribute("data-category")).toBe("2");
    reads.forEach((read) => expect(read).toHaveBeenCalledTimes(2));
    refresh();
    flushFrame();
    reads.forEach((read) => expect(read).toHaveBeenCalledTimes(3));
  });

  it("does not rewrite category classes when scrolling within the same category", () => {
    const { area, bar } = fixture();
    const toggle = vi.spyOn(bar.children[0]!.classList, "toggle");
    area.scrollTop = 50;
    area.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("cancels pending scroll work when the picker closes", () => {
    const { area, reads } = fixture();
    area.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    scope.abort();
    expect(frames.size).toBe(0);
    area.dispatchEvent(new Event("scroll"));
    flushFrame();
    reads.forEach((read) => expect(read).toHaveBeenCalledOnce());
  });
});
