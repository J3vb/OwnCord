import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  gifFavoritesStore,
  bindGifFavoritesApi,
  isGifFavorite,
  toggleGifFavorite,
  resetGifFavorites,
} from "@stores/gifFavorites.store";
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
