import { describe, it, expect, vi } from "vitest";
import {
  createGifPager,
  MAX_PAGES,
  RETRY_COOLDOWN_MAX_MS,
  RETRY_COOLDOWN_MS,
} from "../../src/lib/media/gifPager";
import { ApiClientError } from "../../src/lib/api";
import type { GifPage, GifResult } from "../../src/lib/media/gifProvider";

function gif(id: string): GifResult {
  return {
    id,
    title: id,
    url: `https://media.klipy.com/${id}_t.gif`,
    fullUrl: `https://media.klipy.com/${id}.gif`,
  };
}

function page(ids: string[], next: string): GifPage {
  return { gifs: ids.map(gif), next };
}

const ids = (gifs: readonly GifResult[] | null): string[] | null => gifs?.map((g) => g.id) ?? null;

describe("createGifPager", () => {
  it("appends the next page, sending the cursor it was given", async () => {
    const pager = createGifPager();
    expect(ids(pager.begin(page(["a", "b"], "C1")))).toEqual(["a", "b"]);
    const fetchPage = vi.fn(async () => page(["c", "d"], "C2"));

    expect(ids(await pager.loadMore(fetchPage))).toEqual(["c", "d"]);
    expect(fetchPage).toHaveBeenCalledWith("C1");
    expect(pager.hasMore()).toBe(true);

    await pager.loadMore(fetchPage);
    expect(fetchPage).toHaveBeenLastCalledWith("C2");
  });

  it("drops ids already shown and keeps the new ones, in order", async () => {
    const pager = createGifPager();
    pager.begin(page(["a", "b"], "C1"));
    const fresh = await pager.loadMore(async () => page(["b", "c", "a", "d", "c"], "C2"));
    expect(ids(fresh)).toEqual(["c", "d"]);
  });

  it("dedupes inside the first page too", () => {
    const pager = createGifPager();
    expect(ids(pager.begin(page(["a", "a", "b"], "")))).toEqual(["a", "b"]);
  });

  it("stops when next is empty", async () => {
    const pager = createGifPager();
    pager.begin(page(["a"], "C1"));
    expect(ids(await pager.loadMore(async () => page(["b"], "")))).toEqual(["b"]);
    expect(pager.hasMore()).toBe(false);

    const fetchPage = vi.fn(async () => page(["z"], "C9"));
    expect(await pager.loadMore(fetchPage)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("does not page at all when the first page has no next", async () => {
    const pager = createGifPager();
    pager.begin(page(["a"], ""));
    expect(pager.hasMore()).toBe(false);
  });

  it("stops on a page of only duplicates, even if it carries a cursor (pos ignored upstream)", async () => {
    const pager = createGifPager();
    pager.begin(page(["a", "b"], "C1"));
    expect(ids(await pager.loadMore(async () => page(["a", "b"], "C1")))).toEqual([]);
    expect(pager.hasMore()).toBe(false);

    const fetchPage = vi.fn(async () => page(["c"], "C2"));
    expect(await pager.loadMore(fetchPage)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("drops a page that resolves after the query changed", async () => {
    const pager = createGifPager();
    pager.begin(page(["a"], "OLD"));
    let resolveOld!: (p: GifPage) => void;
    const pending = pager.loadMore(() => new Promise<GifPage>((r) => (resolveOld = r)));

    // The query changes: a new first page begins while the old page is in flight.
    expect(ids(pager.begin(page(["x"], "NEW")))).toEqual(["x"]);
    resolveOld(page(["b", "c"], "OLD2"));

    expect(await pending).toBeNull();
    // The stale page neither leaked its ids nor its cursor into the new query.
    const fetchPage = vi.fn(async () => page(["b"], ""));
    expect(ids(await pager.loadMore(fetchPage))).toEqual(["b"]);
    expect(fetchPage).toHaveBeenCalledWith("NEW");
  });

  it("drops a page that resolves after reset (tab switch)", async () => {
    const pager = createGifPager();
    pager.begin(page(["a"], "C1"));
    let resolveOld!: (p: GifPage) => void;
    const pending = pager.loadMore(() => new Promise<GifPage>((r) => (resolveOld = r)));
    pager.reset();
    resolveOld(page(["b"], "C2"));
    expect(await pending).toBeNull();
    expect(pager.hasMore()).toBe(false);
  });

  it("runs one page at a time", async () => {
    const pager = createGifPager();
    pager.begin(page(["a"], "C1"));
    let resolveFirst!: (p: GifPage) => void;
    const first = pager.loadMore(() => new Promise<GifPage>((r) => (resolveFirst = r)));
    const second = vi.fn(async () => page(["z"], ""));
    expect(await pager.loadMore(second)).toBeNull();
    expect(second).not.toHaveBeenCalled();
    resolveFirst(page(["b"], ""));
    expect(ids(await first)).toEqual(["b"]);
  });

  it("keeps the cursor after an error and retries the same page after the cooldown", async () => {
    let t = 1000;
    const pager = createGifPager(() => t);
    pager.begin(page(["a"], "C1"));
    expect(await pager.loadMore(async () => Promise.reject(new Error("offline")))).toBeNull();
    expect(pager.failed()).toBe(true);
    expect(pager.hasMore()).toBe(true);

    const fetchPage = vi.fn(async () => page(["b"], ""));
    t += RETRY_COOLDOWN_MS - 1;
    expect(await pager.loadMore(fetchPage)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();

    t += 1;
    expect(ids(await pager.loadMore(fetchPage))).toEqual(["b"]);
    expect(fetchPage).toHaveBeenCalledWith("C1");
    expect(pager.failed()).toBe(false);
  });

  it("doubles the cooldown per consecutive failure, up to the maximum", async () => {
    let t = 0;
    const pager = createGifPager(() => t);
    pager.begin(page(["a"], "C1"));
    const boom = vi.fn(async (): Promise<GifPage> => Promise.reject(new Error("offline")));
    let expected = RETRY_COOLDOWN_MS;
    for (let i = 0; i < 6; i++) {
      await pager.loadMore(boom);
      const calls = boom.mock.calls.length;
      t += expected - 1;
      await pager.loadMore(boom);
      expect(boom.mock.calls.length).toBe(calls);
      t += 1;
      expected = Math.min(expected * 2, RETRY_COOLDOWN_MAX_MS);
    }
    expect(expected).toBe(RETRY_COOLDOWN_MAX_MS);
  });

  it.each([
    ["a 400", new ApiClientError(400, "INVALID_INPUT", "bad")],
    ["a 404", new ApiClientError(404, "NOT_FOUND", "gone")],
    ["GIF_DISABLED", new ApiClientError(503, "GIF_DISABLED", "off")],
  ])("stops for good on %s", async (_name, err) => {
    const pager = createGifPager(() => 0);
    pager.begin(page(["a"], "C1"));
    expect(await pager.loadMore(() => Promise.reject(err))).toBeNull();
    expect(pager.hasMore()).toBe(false);
    expect(pager.failed()).toBe(false);
  });

  it.each([
    ["a 429", new ApiClientError(429, "RATE_LIMITED", "slow")],
    ["a 502", new ApiClientError(502, "BAD_GATEWAY", "up")],
  ])("keeps paging after %s", async (_name, err) => {
    const pager = createGifPager(() => 0);
    pager.begin(page(["a"], "C1"));
    await pager.loadMore(() => Promise.reject(err));
    expect(pager.hasMore()).toBe(true);
    expect(pager.failed()).toBe(true);
  });

  it("dedupes by full URL when a result has no id", async () => {
    const pager = createGifPager();
    const noId = (n: string): GifResult => ({ ...gif(n), id: "" });
    expect(pager.begin({ gifs: [noId("x"), noId("y")], next: "C1" })).toHaveLength(2);
    const fresh = await pager.loadMore(async () => ({ gifs: [noId("y"), noId("z")], next: "C2" }));
    expect(fresh?.map((g) => g.fullUrl)).toEqual(["https://media.klipy.com/z.gif"]);
  });

  it("stops after MAX_PAGES pages per query", async () => {
    const pager = createGifPager();
    pager.begin(page(["p1"], "C"));
    let n = 1;
    while (pager.hasMore()) {
      n++;
      await pager.loadMore(async () => page([`p${n}`], "C"));
      expect(n).toBeLessThanOrEqual(MAX_PAGES);
    }
    expect(n).toBe(MAX_PAGES);
  });
});
