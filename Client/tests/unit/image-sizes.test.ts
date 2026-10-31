import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImageBoxStore,
  blobImageSize,
  clearImageSizes,
  fitImageBox,
  getImageBox,
  imageSizeGeneration,
  knownImageHeight,
  rememberBlobSize,
  setImageBox,
} from "../../src/features/messaging/content/imageSizes";
import { expectConsole } from "../helpers/console";
import { runSessionResets } from "../../src/lib/net/sessionRegistry";

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
    vi.advanceTimersByTime(3000);
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
    vi.advanceTimersByTime(3000);
    const write = vi.spyOn(Storage.prototype, "setItem");
    setImageBox("https://a.test/1.png", { w: 10, h: 20 });
    vi.advanceTimersByTime(3000);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    vi.useRealTimers();
  });

  it("keeps the newest 500 and drops the oldest", () => {
    for (let i = 0; i < 501; i++) setImageBox(`https://a.test/${i}.png`, { w: 5, h: 5 });
    expect(getImageBox("https://a.test/0.png")).toBeUndefined();
    expect(getImageBox("https://a.test/1.png")).toEqual({ w: 5, h: 5 });
    vi.advanceTimersByTime(3000);
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
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    expectConsole("warn", "Failed to save preference");
    expect(store.get("https://a.test/2.png")).toEqual({ w: 3, h: 4 });
    broken.mockRestore();
    vi.useRealTimers();
  });

  it("does not cache or persist a URL longer than 1 KB", () => {
    const long = `https://a.test/${"x".repeat(1100)}.png`;
    expect(setImageBox(long, { w: 10, h: 10 })).toBeUndefined();
    expect(getImageBox(long)).toBeUndefined();
    setImageBox("https://a.test/short.png", { w: 10, h: 10 });
    vi.advanceTimersByTime(3000);
    expect(JSON.stringify(stored())).not.toContain("xxxx");
    vi.useRealTimers();
  });

  it("caps the persisted copy at 96 KB by dropping the oldest entries", () => {
    // 500 entries of ~1000 bytes each would serialize to ~500 KB.
    for (let i = 0; i < 500; i++) {
      setImageBox(`https://a.test/${i}/${"p".repeat(950)}.png`, { w: 10, h: 10 });
    }
    expect(getImageBox(`https://a.test/0/${"p".repeat(950)}.png`)).toBeDefined(); // memory keeps all
    vi.advanceTimersByTime(3000);
    const raw = localStorage.getItem(KEY)!;
    expect(raw.length).toBeLessThanOrEqual(96 * 1024 + 64);
    const rows = stored() as Array<[string, number, number]>;
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.length).toBeLessThan(500);
    // The newest survive, the oldest went.
    expect(rows[rows.length - 1]![0]).toContain("/499/");
    expect(rows[0]![0]).not.toContain("/0/");
    vi.useRealTimers();
  });

  it("rejects stored boxes outside the 400x350 ceiling or not whole pixels", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        ["wide", 401, 10],
        ["tall", 10, 351],
        ["frac", 10.5, 10],
        ["neg", -1, 10],
        ["big", 9000, 9000],
        ["ok", 400, 350],
        ["m", 20, 30, 1],
      ]),
    );
    const fresh = createImageBoxStore();
    for (const url of ["wide", "tall", "frac", "neg", "big"]) {
      expect(fresh.get(url), url).toBeUndefined();
    }
    expect(fresh.get("ok")).toEqual({ w: 400, h: 350 });
    expect(fresh.get("m")).toEqual({ w: 20, h: 30, measured: true });
  });

  it("refuses a box outside the ceiling", () => {
    expect(setImageBox("https://a.test/huge.png", { w: 800, h: 100 })).toBeUndefined();
    expect(getImageBox("https://a.test/huge.png")).toBeUndefined();
    vi.useRealTimers();
  });

  it("never lets a sniffed box replace a measured one, and a measured one replaces a sniffed one", () => {
    const url = "https://a.test/rotated.jpg";
    setImageBox(url, { w: 400, h: 200 });
    expect(setImageBox(url, { w: 175, h: 350, measured: true })).toEqual({
      w: 175,
      h: 350,
      measured: true,
    });
    // The header still reads landscape on the next mount: the cache stays put.
    expect(setImageBox(url, { w: 400, h: 200 })).toEqual({ w: 175, h: 350, measured: true });
    expect(getImageBox(url)).toEqual({ w: 175, h: 350, measured: true });
    vi.advanceTimersByTime(3000);
    expect(stored()).toEqual([[url, 175, 350, 1]]);
    vi.useRealTimers();
  });

  it("drops a write from before the session reset", () => {
    const before = imageSizeGeneration();
    clearImageSizes();
    expect(imageSizeGeneration()).toBe(before + 1);
    expect(setImageBox("https://a.test/old.png", { w: 10, h: 10 }, before)).toBeUndefined();
    expect(getImageBox("https://a.test/old.png")).toBeUndefined();
    expect(setImageBox("https://a.test/new.png", { w: 10, h: 10 }, imageSizeGeneration())).toEqual({
      w: 10,
      h: 10,
    });
    vi.useRealTimers();
  });

  it("is cleared, in memory and in storage, by the session reset", () => {
    setImageBox("https://a.test/1.png", { w: 10, h: 20 });
    vi.advanceTimersByTime(3000);
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
