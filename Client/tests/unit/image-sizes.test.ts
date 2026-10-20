import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImageBoxStore,
  blobImageSize,
  clearImageSizes,
  fitImageBox,
  getImageBox,
  knownImageHeight,
  rememberBlobSize,
  setImageBox,
} from "../../src/components/message-list/image-sizes";
import { expectConsole } from "../helpers/console";
import { runSessionResets } from "../../src/lib/sessionRegistry";

const KEY = "owncord:settings:imageBoxes";

function stored(): unknown {
  const raw = localStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("fitImageBox", () => {
  it("scales under the 400x350 ceiling and keeps small images as they are", () => {
    expect(fitImageBox(1200, 800)).toEqual({ w: 400, h: 267 });
    expect(fitImageBox(800, 1200)).toEqual({ w: 233, h: 350 });
    expect(fitImageBox(120, 90)).toEqual({ w: 120, h: 90 });
  });

  it("refuses a size that is not positive and finite", () => {
    expect(fitImageBox(0, 10)).toBeNull();
    expect(fitImageBox(10, -1)).toBeNull();
    expect(fitImageBox(Number.NaN, 10)).toBeNull();
    expect(fitImageBox(Infinity, 10)).toBeNull();
  });

  it("never rounds a thin image down to nothing", () => {
    expect(fitImageBox(1, 20_000)).toEqual({ w: 1, h: 350 });
  });
});

describe("image box cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearImageSizes();
    localStorage.clear();
  });

  it("answers from memory and gives the list its estimate", () => {
    setImageBox("https://a.test/1.png", { w: 400, h: 267 });
    expect(getImageBox("https://a.test/1.png")).toEqual({ w: 400, h: 267 });
    expect(knownImageHeight("https://a.test/1.png")).toBe(267);
    expect(knownImageHeight("https://a.test/other.png")).toBeUndefined();
    vi.useRealTimers();
  });

  it("persists in one batched write and restores after a restart", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    setImageBox("https://a.test/1.png", { w: 10, h: 20 });
    setImageBox("https://a.test/2.png", { w: 30, h: 40 });
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual([
      ["https://a.test/1.png", 10, 20],
      ["https://a.test/2.png", 30, 40],
    ]);
    write.mockRestore();

    // A new page load: memory is empty, storage is not.
    const fresh = createImageBoxStore();
    expect(fresh.get("https://a.test/2.png")).toEqual({ w: 30, h: 40 });
    vi.useRealTimers();
  });

  it("writes nothing for a repeat of the stored value", () => {
    setImageBox("https://a.test/1.png", { w: 10, h: 20 });
    vi.advanceTimersByTime(1000);
    const write = vi.spyOn(Storage.prototype, "setItem");
    setImageBox("https://a.test/1.png", { w: 10, h: 20 });
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    vi.useRealTimers();
  });

  it("keeps the newest 500 and drops the oldest", () => {
    for (let i = 0; i < 501; i++) setImageBox(`https://a.test/${i}.png`, { w: 5, h: 5 });
    expect(getImageBox("https://a.test/0.png")).toBeUndefined();
    expect(getImageBox("https://a.test/1.png")).toEqual({ w: 5, h: 5 });
    vi.advanceTimersByTime(1000);
    expect((stored() as unknown[]).length).toBe(500);
    vi.useRealTimers();
  });

  it("ignores corrupt storage and malformed entries", () => {
    localStorage.setItem(KEY, "{not json");
    expect(createImageBoxStore().get("https://a.test/1.png")).toBeUndefined();

    localStorage.setItem(KEY, JSON.stringify([["ok", 1, 2], ["bad", 0, 2], [5], "x"]));
    const fresh = createImageBoxStore();
    expect(fresh.get("ok")).toEqual({ w: 1, h: 2 });
    expect(fresh.get("bad")).toBeUndefined();
    vi.useRealTimers();
  });

  it("keeps serving from memory when storage refuses the write", () => {
    const broken = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const store = createImageBoxStore();
    store.set("https://a.test/2.png", { w: 3, h: 4 });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expectConsole("warn", "Failed to save preference");
    expect(store.get("https://a.test/2.png")).toEqual({ w: 3, h: 4 });
    broken.mockRestore();
    vi.useRealTimers();
  });

  it("is cleared, in memory and in storage, by the session reset", () => {
    setImageBox("https://a.test/1.png", { w: 10, h: 20 });
    vi.advanceTimersByTime(1000);
    expect(stored()).not.toEqual([]);
    runSessionResets("user");
    expect(getImageBox("https://a.test/1.png")).toBeUndefined();
    expect(stored()).toEqual([]);
    // A write still pending when the reset ran is dropped, not replayed.
    vi.useRealTimers();
  });
});

describe("blob sizes", () => {
  it("remembers a sniffed size per blob URL and skips an unreadable one", () => {
    rememberBlobSize("blob:x/1", { width: 9, height: 8 });
    rememberBlobSize("blob:x/2", null);
    expect(blobImageSize("blob:x/1")).toEqual({ width: 9, height: 8 });
    expect(blobImageSize("blob:x/2")).toBeUndefined();
    clearImageSizes();
    expect(blobImageSize("blob:x/1")).toBeUndefined();
  });
});
