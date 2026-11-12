import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPickerImages } from "../../../../src/features/messaging/pickerImages";
import { createDeferred } from "../../../helpers/deferred";
import { useMountContainer } from "../../../helpers/mountContainer";

describe("picker image loading", () => {
  let root: HTMLDivElement;
  let scope: AbortController;
  let notify: IntersectionObserverCallback;
  let observer: IntersectionObserver;
  const disconnect = vi.fn();
  const unobserve = vi.fn();

  useMountContainer((container) => {
    root = container;
  });

  beforeEach(() => {
    scope = new AbortController();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
          observer = this as unknown as IntersectionObserver;
        }
        observe(): void {}
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
  });

  afterEach(() => {
    scope.abort();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function image(): HTMLImageElement {
    const img = document.createElement("img");
    root.appendChild(img);
    return img;
  }

  function entry(target: Element, top: number, nearby = true): IntersectionObserverEntry {
    return {
      target,
      isIntersecting: nearby,
      intersectionRatio: nearby ? 1 : 0,
      boundingClientRect: new DOMRect(0, top, 80, 80),
      rootBounds: new DOMRect(0, -320, 320, 960),
      intersectionRect: new DOMRect(0, top, 80, 80),
      time: 0,
    };
  }

  function report(entries: IntersectionObserverEntry[]): void {
    notify(entries, observer);
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }

  it("downloads nothing outside the scroll buffer", () => {
    const images = createPickerImages(root, scope.signal);
    const img = image();
    const load = vi.fn(async () => "blob:offscreen");
    images.observe(img, load);
    report([entry(img, 1000, false)]);
    expect(load).not.toHaveBeenCalled();
    expect(img.hasAttribute("src")).toBe(false);
  });

  it("starts visible images before nearby previews and bounds simultaneous downloads", async () => {
    const images = createPickerImages(root, scope.signal);
    const tasks = Array.from({ length: 12 }, () => createDeferred<string | null>());
    const cells = tasks.map(() => image());
    const started: number[] = [];
    tasks.forEach((task, i) =>
      images.observe(cells[i]!, () => {
        started.push(i);
        return task.promise;
      }),
    );
    report(cells.map((img, i) => entry(img, i < 6 ? 500 : 10)));
    expect(started).toEqual([6, 7, 8, 9, 10, 11]);
    tasks[6]!.resolve("blob:visible");
    await flush();
    expect(cells[6]!.getAttribute("src")).toBe("blob:visible");
    expect(started).toEqual([6, 7, 8, 9, 10, 11, 0]);
    expect(unobserve).toHaveBeenCalledWith(cells[6]);
  });

  it("leaves previews scrolled away from out of the queue", async () => {
    const images = createPickerImages(root, scope.signal);
    const held = createDeferred<string | null>();
    const busy = Array.from({ length: 6 }, () => image());
    busy.forEach((img) => images.observe(img, () => held.promise));
    report(busy.map((img) => entry(img, 10)));
    const old = image();
    const oldLoad = vi.fn(async () => "blob:old");
    images.observe(old, oldLoad);
    report([entry(old, 500)]);
    const fresh = image();
    const freshLoad = vi.fn(async () => "blob:fresh");
    images.observe(fresh, freshLoad);
    report([entry(old, -1000, false), entry(fresh, 10)]);
    held.resolve("blob:busy");
    await flush();
    expect(oldLoad).not.toHaveBeenCalled();
    expect(freshLoad).toHaveBeenCalledOnce();
    expect(fresh.getAttribute("src")).toBe("blob:fresh");
  });

  it("discards queued work and late results after a grid rebuild", async () => {
    const images = createPickerImages(root, scope.signal);
    const held = createDeferred<string | null>();
    const old = image();
    images.observe(old, () => held.promise);
    report([entry(old, 10)]);
    const queued = image();
    const queuedLoad = vi.fn(async () => "blob:queued");
    images.observe(queued, queuedLoad);
    images.clear();
    report([entry(queued, 10)]);
    const fresh = image();
    images.observe(fresh, async () => "blob:fresh");
    report([entry(fresh, 10)]);
    held.resolve("blob:old");
    await flush();
    expect(old.hasAttribute("src")).toBe(false);
    expect(queuedLoad).not.toHaveBeenCalled();
    expect(fresh.getAttribute("src")).toBe("blob:fresh");
    expect(disconnect).toHaveBeenCalled();
  });

  it("never updates a removed image or a closed picker", async () => {
    const images = createPickerImages(root, scope.signal);
    const held = createDeferred<string | null>();
    const removed = image();
    const closed = image();
    images.observe(removed, () => held.promise);
    images.observe(closed, () => held.promise);
    report([entry(removed, 10), entry(closed, 100)]);
    removed.remove();
    scope.abort();
    held.resolve("blob:late");
    await flush();
    expect(removed.hasAttribute("src")).toBe(false);
    expect(closed.hasAttribute("src")).toBe(false);
    const load = vi.fn(async () => "blob:closed");
    images.observe(image(), load);
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps loading after an image fails and supports a custom display callback", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const images = createPickerImages(root, scope.signal);
    const failed = image();
    const good = image();
    const show = vi.fn();
    images.observe(failed, async () => {
      throw new Error("offline");
    });
    images.observe(good, async () => "blob:good", show);
    await flush();
    expect(failed.hasAttribute("src")).toBe(false);
    expect(show).toHaveBeenCalledExactlyOnceWith("blob:good");
    expect(good.hasAttribute("src")).toBe(false);
  });

  it("does not assign a source when the fetch returns no image", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const images = createPickerImages(root, scope.signal);
    const img = image();
    images.observe(img, async () => null);
    await flush();
    expect(img.hasAttribute("src")).toBe(false);
  });
});
