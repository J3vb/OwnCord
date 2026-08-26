import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchGifs, getTrendingGifs, type GifApi } from "../../src/lib/gifProvider";
import type { GifSearchResponse } from "../../src/lib/types";

// ---------------------------------------------------------------------------
// The GIF provider must go through the user's OWN server (api.ts, which is
// TOFU-pinned via the Rust http proxy) — never api.klipy.com, and never with
// an API key in this bundle.
// ---------------------------------------------------------------------------

const gifSearch = vi.fn<GifApi["gifSearch"]>();
const gifTrending = vi.fn<GifApi["gifTrending"]>();
const api: GifApi = { gifSearch, gifTrending };

beforeEach(() => {
  gifSearch.mockReset();
  gifTrending.mockReset();
  // A real fetch must never happen from this module.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("gifProvider must not call fetch directly");
    }),
  );
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function gifResult(
  id: string,
  overrides: { tinygif?: string | null; gif?: string | null; title?: string } = {},
) {
  const {
    tinygif = `https://media.klipy.com/${id}_tiny.gif`,
    gif = `https://media.klipy.com/${id}.gif`,
    title = `Title ${id}`,
  } = overrides;

  const media_formats: Record<string, { url: string }> = {};
  if (tinygif !== null) media_formats["tinygif"] = { url: tinygif };
  if (gif !== null) media_formats["gif"] = { url: gif };

  return { id, title, media_formats };
}

function response(results: unknown[]): GifSearchResponse {
  return { results } as GifSearchResponse;
}

// ---------------------------------------------------------------------------
// searchGifs
// ---------------------------------------------------------------------------

describe("searchGifs", () => {
  describe("transport", () => {
    it("calls the server's GIF search endpoint via the api client", async () => {
      gifSearch.mockResolvedValue(response([]));
      await searchGifs(api, "cats");
      expect(gifSearch).toHaveBeenCalledTimes(1);
    });

    it("passes the query through", async () => {
      gifSearch.mockResolvedValue(response([]));
      await searchGifs(api, "dogs");
      expect(gifSearch).toHaveBeenCalledWith("dogs", 20);
    });

    it("defaults limit to 20", async () => {
      gifSearch.mockResolvedValue(response([]));
      await searchGifs(api, "cats");
      expect(gifSearch.mock.calls[0]?.[1]).toBe(20);
    });

    it("passes an explicit limit override", async () => {
      gifSearch.mockResolvedValue(response([]));
      await searchGifs(api, "cats", 5);
      expect(gifSearch.mock.calls[0]?.[1]).toBe(5);
    });

    it("never calls global fetch (no direct api.klipy.com traffic)", async () => {
      gifSearch.mockResolvedValue(response([]));
      await searchGifs(api, "cats");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("does not use the trending endpoint", async () => {
      gifSearch.mockResolvedValue(response([]));
      await searchGifs(api, "cats");
      expect(gifTrending).not.toHaveBeenCalled();
    });
  });

  describe("result parsing", () => {
    it("returns an empty array when results are empty", async () => {
      gifSearch.mockResolvedValue(response([]));
      expect(await searchGifs(api, "nothing")).toEqual([]);
    });

    it("maps id, title, url (tinygif), and fullUrl (gif) correctly", async () => {
      gifSearch.mockResolvedValue(response([gifResult("abc123")]));
      const gifs = await searchGifs(api, "cats");
      expect(gifs).toHaveLength(1);
      expect(gifs[0]).toEqual({
        id: "abc123",
        title: "Title abc123",
        url: "https://media.klipy.com/abc123_tiny.gif",
        fullUrl: "https://media.klipy.com/abc123.gif",
      });
    });

    it("maps multiple results in order", async () => {
      gifSearch.mockResolvedValue(response([gifResult("a"), gifResult("b"), gifResult("c")]));
      const gifs = await searchGifs(api, "cats");
      expect(gifs.map((g) => g.id)).toEqual(["a", "b", "c"]);
    });

    it("filters out results with no tinygif format", async () => {
      gifSearch.mockResolvedValue(
        response([gifResult("keep"), gifResult("drop", { tinygif: null })]),
      );
      const gifs = await searchGifs(api, "cats");
      expect(gifs.map((g) => g.id)).toEqual(["keep"]);
    });

    it("filters out results with no gif format", async () => {
      gifSearch.mockResolvedValue(response([gifResult("keep"), gifResult("drop", { gif: null })]));
      const gifs = await searchGifs(api, "cats");
      expect(gifs.map((g) => g.id)).toEqual(["keep"]);
    });

    it("returns an empty array when all results lack required formats", async () => {
      gifSearch.mockResolvedValue(
        response([gifResult("x", { tinygif: null }), gifResult("y", { gif: null })]),
      );
      expect(await searchGifs(api, "cats")).toEqual([]);
    });
  });

  // The server is trusted to hold the key, but not to dictate what the client
  // renders — media URLs are still pinned to the Klipy CDN.
  describe("CDN allowlist", () => {
    it("filters out results with non-Klipy CDN URLs", async () => {
      gifSearch.mockResolvedValue(
        response([
          gifResult("drop", {
            tinygif: "https://media.tenor.com/drop_tiny.gif",
            gif: "https://media.tenor.com/drop.gif",
          }),
          gifResult("keep", {
            tinygif: "https://static.klipy.com/keep_tiny.gif",
            gif: "https://static.klipy.com/keep.gif",
          }),
        ]),
      );
      const gifs = await searchGifs(api, "cats");
      expect(gifs.map((g) => g.id)).toEqual(["keep"]);
    });

    it("rejects http:// URLs on the allowed host", async () => {
      gifSearch.mockResolvedValue(
        response([
          gifResult("drop", {
            tinygif: "http://media.klipy.com/a_tiny.gif",
            gif: "http://media.klipy.com/a.gif",
          }),
        ]),
      );
      expect(await searchGifs(api, "cats")).toEqual([]);
    });

    it("rejects lookalike hosts that merely end in the allowed name", async () => {
      gifSearch.mockResolvedValue(
        response([
          gifResult("drop", {
            tinygif: "https://evilklipy.com/a_tiny.gif",
            gif: "https://evilklipy.com/a.gif",
          }),
        ]),
      );
      expect(await searchGifs(api, "cats")).toEqual([]);
    });

    it("rejects a klipy.com path on an attacker host", async () => {
      gifSearch.mockResolvedValue(
        response([
          gifResult("drop", {
            tinygif: "https://evil.example.com/klipy.com/a_tiny.gif",
            gif: "https://evil.example.com/klipy.com/a.gif",
          }),
        ]),
      );
      expect(await searchGifs(api, "cats")).toEqual([]);
    });

    it("rejects malformed URLs", async () => {
      gifSearch.mockResolvedValue(
        response([gifResult("drop", { tinygif: "not a url", gif: "also not a url" })]),
      );
      expect(await searchGifs(api, "cats")).toEqual([]);
    });
  });

  describe("error propagation", () => {
    it("propagates the api client's error so the picker can degrade", async () => {
      gifSearch.mockRejectedValue(new Error("Service Unavailable"));
      await expect(searchGifs(api, "cats")).rejects.toThrow("Service Unavailable");
    });
  });
});

// ---------------------------------------------------------------------------
// getTrendingGifs
// ---------------------------------------------------------------------------

describe("getTrendingGifs", () => {
  describe("transport", () => {
    it("calls the server's trending endpoint via the api client", async () => {
      gifTrending.mockResolvedValue(response([]));
      await getTrendingGifs(api);
      expect(gifTrending).toHaveBeenCalledTimes(1);
    });

    it("defaults limit to 20", async () => {
      gifTrending.mockResolvedValue(response([]));
      await getTrendingGifs(api);
      expect(gifTrending).toHaveBeenCalledWith(20);
    });

    it("passes an explicit limit override", async () => {
      gifTrending.mockResolvedValue(response([]));
      await getTrendingGifs(api, 10);
      expect(gifTrending).toHaveBeenCalledWith(10);
    });

    it("never calls global fetch (no direct api.klipy.com traffic)", async () => {
      gifTrending.mockResolvedValue(response([]));
      await getTrendingGifs(api);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("does not use the search endpoint", async () => {
      gifTrending.mockResolvedValue(response([]));
      await getTrendingGifs(api);
      expect(gifSearch).not.toHaveBeenCalled();
    });
  });

  describe("result parsing", () => {
    it("returns an empty array when results are empty", async () => {
      gifTrending.mockResolvedValue(response([]));
      expect(await getTrendingGifs(api)).toEqual([]);
    });

    it("maps fields correctly", async () => {
      gifTrending.mockResolvedValue(response([gifResult("trend1")]));
      const gifs = await getTrendingGifs(api);
      expect(gifs[0]).toEqual({
        id: "trend1",
        title: "Title trend1",
        url: "https://media.klipy.com/trend1_tiny.gif",
        fullUrl: "https://media.klipy.com/trend1.gif",
      });
    });

    it("filters out results with missing tinygif", async () => {
      gifTrending.mockResolvedValue(
        response([gifResult("keep"), gifResult("drop", { tinygif: null })]),
      );
      expect((await getTrendingGifs(api)).map((g) => g.id)).toEqual(["keep"]);
    });

    it("filters out results with missing gif", async () => {
      gifTrending.mockResolvedValue(
        response([gifResult("keep"), gifResult("drop", { gif: null })]),
      );
      expect((await getTrendingGifs(api)).map((g) => g.id)).toEqual(["keep"]);
    });

    it("enforces the CDN allowlist on trending results too", async () => {
      gifTrending.mockResolvedValue(
        response([
          gifResult("drop", {
            tinygif: "https://media.tenor.com/drop_tiny.gif",
            gif: "https://media.tenor.com/drop.gif",
          }),
        ]),
      );
      expect(await getTrendingGifs(api)).toEqual([]);
    });
  });

  describe("error propagation", () => {
    it("propagates the api client's error so the picker can degrade", async () => {
      gifTrending.mockRejectedValue(new Error("DNS lookup failed"));
      await expect(getTrendingGifs(api)).rejects.toThrow("DNS lookup failed");
    });
  });
});
