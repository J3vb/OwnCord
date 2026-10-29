import { describe, it, expect, beforeEach, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@lib/toast", () => toastMock);

import {
  gifFavoritesAvailable,
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const titles = (): string[] => gifFavoritesStore.getState().favorites.map((f) => f.title);

describe("gifFavorites store", () => {
  beforeEach(() => {
    resetGifFavorites();
    toastMock.showToast.mockClear();
  });

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

  describe("availability", () => {
    it("is unavailable before an API is bound, available after, and unavailable after a reset", async () => {
      expect(gifFavoritesAvailable()).toBe(false);
      bindGifFavoritesApi(makeApi());
      expect(gifFavoritesAvailable()).toBe(true);
      await flush();
      expect(gifFavoritesAvailable()).toBe(true);
      resetGifFavorites();
      expect(gifFavoritesAvailable()).toBe(false);
    });

    it("is unavailable once the server answered 404", async () => {
      const api = makeApi();
      api.gifFavorites = vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "nope"));
      bindGifFavoritesApi(api);
      await flush();
      expect(gifFavoritesAvailable()).toBe(false);
    });
  });

  describe("binding", () => {
    it("loads once when the same client is bound again and keeps what it loaded", async () => {
      const api = makeApi([fav("a")]);
      bindGifFavoritesApi(api);
      await flush();
      bindGifFavoritesApi(api);
      await flush();
      expect(api.gifFavorites).toHaveBeenCalledTimes(1);
      expect(titles()).toEqual(["a"]);
    });

    it("keeps a favorite toggled on while the load was in flight, without duplicating it", async () => {
      const load = deferred<{ favorites: readonly GifFavorite[] }>();
      const api = makeApi();
      api.gifFavorites = vi.fn().mockReturnValue(load.promise);
      bindGifFavoritesApi(api);
      await toggleGifFavorite(fav("new"));
      load.resolve({ favorites: [fav("new"), fav("old")] });
      await flush();
      expect(titles()).toEqual(["new", "old"]);
    });

    it("keeps the unsupported flag until a load succeeds", async () => {
      const old = makeApi();
      old.gifFavorites = vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "nope"));
      bindGifFavoritesApi(old);
      await flush();
      const load = deferred<{ favorites: readonly GifFavorite[] }>();
      const next = makeApi();
      next.gifFavorites = vi.fn().mockReturnValue(load.promise);
      bindGifFavoritesApi(next);
      expect(gifFavoritesStore.getState().unsupported).toBe(true);
      load.resolve({ favorites: [] });
      await flush();
      expect(gifFavoritesStore.getState().unsupported).toBe(false);
    });

    it("unbinds after a failed load so binding again retries it", async () => {
      const api = makeApi([fav("a")]);
      vi.mocked(api.gifFavorites).mockRejectedValueOnce(new Error("offline"));
      bindGifFavoritesApi(api);
      await flush();
      expect(gifFavoritesAvailable()).toBe(false);
      expect(gifFavoritesStore.getState().unsupported).toBe(false);
      bindGifFavoritesApi(api);
      await flush();
      expect(api.gifFavorites).toHaveBeenCalledTimes(2);
      expect(titles()).toEqual(["a"]);
    });

    it("does not mark a non-404 API error as unsupported", async () => {
      const api = makeApi();
      api.gifFavorites = vi.fn().mockRejectedValue(new ApiClientError(500, "SERVER", "down"));
      bindGifFavoritesApi(api);
      await flush();
      expect(gifFavoritesStore.getState().unsupported).toBe(false);
    });

    it("ignores a load that finishes after a reset", async () => {
      const load = deferred<{ favorites: readonly GifFavorite[] }>();
      const api = makeApi();
      api.gifFavorites = vi.fn().mockReturnValue(load.promise);
      bindGifFavoritesApi(api);
      resetGifFavorites();
      load.resolve({ favorites: [fav("stale")] });
      await flush();
      expect(titles()).toEqual([]);
    });

    it("ignores a load failure that arrives after a reset and a new bind", async () => {
      const load = deferred<{ favorites: readonly GifFavorite[] }>();
      const first = makeApi();
      first.gifFavorites = vi.fn().mockReturnValue(load.promise);
      bindGifFavoritesApi(first);
      resetGifFavorites();
      bindGifFavoritesApi(makeApi([fav("b")]));
      load.reject(new ApiClientError(404, "NOT_FOUND", "nope"));
      await flush();
      expect(gifFavoritesAvailable()).toBe(true);
      expect(gifFavoritesStore.getState().unsupported).toBe(false);
      expect(titles()).toEqual(["b"]);
    });
  });

  describe("toggling", () => {
    it("refuses with an error toast and no change when no API is bound", async () => {
      await expect(toggleGifFavorite(fav("a"))).resolves.toBe(false);
      expect(titles()).toEqual([]);
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "Couldn't update favorites",
        "error",
      );
    });

    it("shows no toast when the server accepts", async () => {
      bindGifFavoritesApi(makeApi([fav("a")]));
      await flush();
      await toggleGifFavorite(fav("b"));
      await toggleGifFavorite(fav("a"));
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("rolls back an add and toasts the generic failure", async () => {
      const api = makeApi([fav("a")]);
      vi.mocked(api.addGifFavorite).mockRejectedValue(new Error("boom"));
      bindGifFavoritesApi(api);
      await flush();
      await toggleGifFavorite(fav("b"));
      expect(titles()).toEqual(["a"]);
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "Couldn't update favorites",
        "error",
      );
    });

    it("toasts the limit message when the server says the list is full", async () => {
      const api = makeApi();
      vi.mocked(api.addGifFavorite).mockRejectedValue(
        new ApiClientError(409, "GIF_FAVORITES_FULL", "full"),
      );
      bindGifFavoritesApi(api);
      await flush();
      await expect(toggleGifFavorite(fav("a"))).resolves.toBe(false);
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "You've reached the limit of saved GIFs. Remove one to add another.",
        "error",
      );
    });

    it("toasts the generic message for an API error with another code", async () => {
      const api = makeApi();
      vi.mocked(api.addGifFavorite).mockRejectedValue(new ApiClientError(409, "OTHER", "no"));
      bindGifFavoritesApi(api);
      await flush();
      await toggleGifFavorite(fav("a"));
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "Couldn't update favorites",
        "error",
      );
    });

    it("restores a failed removal of the last entry in place", async () => {
      const api = makeApi([fav("c"), fav("b"), fav("a")]);
      api.removeGifFavorite = vi.fn().mockRejectedValue(new Error("boom"));
      bindGifFavoritesApi(api);
      await flush();
      await toggleGifFavorite(fav("a"));
      expect(titles()).toEqual(["c", "b", "a"]);
    });

    it("restores a failed removal of the first entry in place", async () => {
      const api = makeApi([fav("c"), fav("b"), fav("a")]);
      api.removeGifFavorite = vi.fn().mockRejectedValue(new Error("boom"));
      bindGifFavoritesApi(api);
      await flush();
      await toggleGifFavorite(fav("c"));
      expect(titles()).toEqual(["c", "b", "a"]);
    });

    it("shows the optimistic change before the server answers", async () => {
      const call = deferred<undefined>();
      const api = makeApi([fav("a")]);
      api.addGifFavorite = vi.fn().mockReturnValue(call.promise);
      bindGifFavoritesApi(api);
      await flush();
      const result = toggleGifFavorite(fav("b"));
      expect(titles()).toEqual(["b", "a"]);
      call.resolve(undefined);
      await expect(result).resolves.toBe(true);
    });

    it("sends one request when the same GIF is toggled twice in flight", async () => {
      const call = deferred<undefined>();
      const api = makeApi();
      api.addGifFavorite = vi.fn().mockReturnValue(call.promise);
      bindGifFavoritesApi(api);
      await flush();
      const first = toggleGifFavorite(fav("a"));
      await expect(toggleGifFavorite(fav("a"))).resolves.toBe(true);
      expect(api.addGifFavorite).toHaveBeenCalledTimes(1);
      expect(api.removeGifFavorite).not.toHaveBeenCalled();
      call.resolve(undefined);
      await first;
      expect(titles()).toEqual(["a"]);
    });

    it("lets the same GIF be toggled again once the first request settled", async () => {
      const api = makeApi();
      bindGifFavoritesApi(api);
      await flush();
      await toggleGifFavorite(fav("a"));
      await toggleGifFavorite(fav("a"));
      expect(api.addGifFavorite).toHaveBeenCalledTimes(1);
      expect(api.removeGifFavorite).toHaveBeenCalledTimes(1);
      expect(titles()).toEqual([]);
    });

    it("lets the same GIF be toggled again after a failed request", async () => {
      const api = makeApi();
      vi.mocked(api.addGifFavorite).mockRejectedValueOnce(new Error("boom"));
      bindGifFavoritesApi(api);
      await flush();
      await toggleGifFavorite(fav("a"));
      await expect(toggleGifFavorite(fav("a"))).resolves.toBe(true);
      expect(api.addGifFavorite).toHaveBeenCalledTimes(2);
      expect(titles()).toEqual(["a"]);
    });

    it("leaves a new session alone when a failure from the old one arrives after a reset", async () => {
      const call = deferred<undefined>();
      const api = makeApi();
      api.addGifFavorite = vi.fn().mockReturnValue(call.promise);
      bindGifFavoritesApi(api);
      await flush();
      const result = toggleGifFavorite(fav("a"));
      resetGifFavorites();
      const next = makeApi([fav("z")]);
      bindGifFavoritesApi(next);
      await flush();
      call.reject(new Error("late"));
      await expect(result).resolves.toBe(false);
      expect(titles()).toEqual(["z"]);
      expect(toastMock.showToast).not.toHaveBeenCalled();
      // The reset cleared the in-flight mark, so the new session can toggle the same GIF.
      await expect(toggleGifFavorite(fav("a"))).resolves.toBe(true);
      expect(next.addGifFavorite).toHaveBeenCalledTimes(1);
    });

    it("keeps the in-flight mark of the new session when an old request settles", async () => {
      const oldCall = deferred<undefined>();
      const oldApi = makeApi();
      oldApi.addGifFavorite = vi.fn().mockReturnValue(oldCall.promise);
      bindGifFavoritesApi(oldApi);
      await flush();
      const oldResult = toggleGifFavorite(fav("a"));
      resetGifFavorites();
      const newCall = deferred<undefined>();
      const newApi = makeApi();
      newApi.addGifFavorite = vi.fn().mockReturnValue(newCall.promise);
      bindGifFavoritesApi(newApi);
      await flush();
      const newResult = toggleGifFavorite(fav("a"));
      oldCall.resolve(undefined);
      await oldResult;
      // The old request settling must not clear the new session's mark.
      await expect(toggleGifFavorite(fav("a"))).resolves.toBe(true);
      expect(newApi.addGifFavorite).toHaveBeenCalledTimes(1);
      expect(newApi.removeGifFavorite).not.toHaveBeenCalled();
      newCall.resolve(undefined);
      await newResult;
    });
  });

  describe("reset", () => {
    it("empties the list, drops the API and clears the unsupported flag", async () => {
      const old = makeApi();
      old.gifFavorites = vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "nope"));
      bindGifFavoritesApi(old);
      await flush();
      resetGifFavorites();
      expect(gifFavoritesStore.getState()).toEqual({ favorites: [], unsupported: false });
      await expect(toggleGifFavorite(fav("a"))).resolves.toBe(false);
    });
  });
});
