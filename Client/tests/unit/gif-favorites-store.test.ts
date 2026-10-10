import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  gifFavoritesStore,
  bindGifFavoritesApi,
  isGifFavorite,
  toggleGifFavorite,
  resetGifFavorites,
} from "@stores/gifFavorites.store";
import { ApiClientError } from "@lib/api";
import type { GifFavorite } from "@lib/types";
import type { GifFavoritesApi } from "@lib/gifProvider";

const fav = (n: string): GifFavorite => ({
  url: `https://media.klipy.com/${n}.gif`,
  preview_url: `https://media.klipy.com/${n}_t.gif`,
  title: n,
});

function makeApi(initial: readonly GifFavorite[] = []): GifFavoritesApi {
  return {
    gifFavorites: vi.fn().mockResolvedValue({ favorites: initial }),
    addGifFavorite: vi.fn().mockResolvedValue(undefined),
    removeGifFavorite: vi.fn().mockResolvedValue(undefined),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("gifFavorites store", () => {
  beforeEach(() => resetGifFavorites());

  it("loads the server list when an API is bound", async () => {
    bindGifFavoritesApi(makeApi([fav("b"), fav("a")]));
    await flush();
    expect(gifFavoritesStore.getState().favorites.map((f) => f.title)).toEqual(["b", "a"]);
    expect(isGifFavorite(fav("a").url)).toBe(true);
    expect(isGifFavorite("https://media.klipy.com/zzz.gif")).toBe(false);
  });

  it("adds a new favorite at the front and calls the API", async () => {
    const api = makeApi([fav("a")]);
    bindGifFavoritesApi(api);
    await flush();
    await toggleGifFavorite(fav("b"));
    expect(gifFavoritesStore.getState().favorites.map((f) => f.title)).toEqual(["b", "a"]);
    expect(api.addGifFavorite).toHaveBeenCalledWith(fav("b"));
  });

  it("removes an existing favorite and calls the API", async () => {
    const api = makeApi([fav("a")]);
    bindGifFavoritesApi(api);
    await flush();
    await toggleGifFavorite(fav("a"));
    expect(isGifFavorite(fav("a").url)).toBe(false);
    expect(api.removeGifFavorite).toHaveBeenCalledWith(fav("a").url);
  });

  it("restores a failed removal at its original position", async () => {
    const api = makeApi([fav("c"), fav("b"), fav("a")]);
    api.removeGifFavorite = vi.fn().mockRejectedValue(new Error("boom"));
    bindGifFavoritesApi(api);
    await flush();
    expect(await toggleGifFavorite(fav("b"))).toBe(false);
    expect(gifFavoritesStore.getState().favorites.map((f) => f.title)).toEqual(["c", "b", "a"]);
  });

  it("a failed removal restores the stored entry, not the caller's copy", async () => {
    const api = makeApi([fav("a")]);
    api.removeGifFavorite = vi.fn().mockRejectedValue(new Error("boom"));
    bindGifFavoritesApi(api);
    await flush();
    await toggleGifFavorite({ url: fav("a").url, preview_url: fav("a").url, title: "" });
    expect(gifFavoritesStore.getState().favorites).toEqual([fav("a")]);
  });

  it("marks favorites unsupported on a 404 and recovers on the next successful bind", async () => {
    const old = makeApi();
    old.gifFavorites = vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "nope"));
    bindGifFavoritesApi(old);
    await flush();
    expect(gifFavoritesStore.getState().unsupported).toBe(true);
    expect(await toggleGifFavorite(fav("a"))).toBe(false);
    bindGifFavoritesApi(makeApi([fav("a")]));
    await flush();
    expect(gifFavoritesStore.getState().unsupported).toBe(false);
    expect(isGifFavorite(fav("a").url)).toBe(true);
  });

  it("rolls back and reports failure when the server refuses", async () => {
    const api = makeApi();
    vi.mocked(api.addGifFavorite).mockRejectedValue(new Error("full"));
    bindGifFavoritesApi(api);
    await flush();
    await expect(toggleGifFavorite(fav("a"))).resolves.toBe(false);
    expect(isGifFavorite(fav("a").url)).toBe(false);
  });

  it("resolves true when the toggle is saved", async () => {
    bindGifFavoritesApi(makeApi());
    await flush();
    await expect(toggleGifFavorite(fav("a"))).resolves.toBe(true);
  });

  it("drops the previous account's favorites when a different API is bound", async () => {
    bindGifFavoritesApi(makeApi([fav("a")]));
    await flush();
    bindGifFavoritesApi(makeApi([]));
    expect(gifFavoritesStore.getState().favorites).toEqual([]);
  });
});
