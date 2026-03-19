import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchGifs, getTrendingGifs } from "../../src/lib/tenor";

// ---------------------------------------------------------------------------
// Fetch mock — global fetch used by tenor.ts (no plugin wrapper)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenorResult(
  id: string,
  overrides: {
    tinygif?: string | null;
    gif?: string | null;
    title?: string;
  } = {},
) {
  const { tinygif = `https://media.tenor.com/${id}_tiny.gif`, gif = `https://media.tenor.com/${id}.gif`, title = `Title ${id}` } = overrides;

  const media_formats: Record<string, { url: string }> = {};
  if (tinygif !== null) media_formats["tinygif"] = { url: tinygif };
  if (gif !== null) media_formats["gif"] = { url: gif };

  return { id, title, media_formats };
}

function okResponse(results: unknown[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve({ results }),
  } as unknown as Response;
}

function errorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

// Extracts a URLSearchParams object from the URL string passed to fetch.
function capturedParams(): URLSearchParams {
  const url = mockFetch.mock.calls[0]?.[0] as string;
  return new URLSearchParams(url.split("?")[1] ?? "");
}

function capturedUrl(): string {
  return mockFetch.mock.calls[0]?.[0] as string;
}

// ---------------------------------------------------------------------------
// searchGifs
// ---------------------------------------------------------------------------

describe("searchGifs", () => {
  describe("URL construction", () => {
    it("calls the Tenor search endpoint", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await searchGifs("cats");
      expect(capturedUrl()).toMatch(
        /^https:\/\/tenor\.googleapis\.com\/v2\/search/,
      );
    });

    it("includes the query param q", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await searchGifs("dogs");
      expect(capturedParams().get("q")).toBe("dogs");
    });

    it("includes the API key param", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await searchGifs("dogs");
      expect(capturedParams().get("key")).toBeTruthy();
    });

    it("includes media_filter param", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await searchGifs("dogs");
      expect(capturedParams().get("media_filter")).toBe("gif,tinygif");
    });

    it("defaults limit to 20", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await searchGifs("cats");
      expect(capturedParams().get("limit")).toBe("20");
    });

    it("passes an explicit limit override", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await searchGifs("cats", 5);
      expect(capturedParams().get("limit")).toBe("5");
    });

    it("URL-encodes special characters in the query", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await searchGifs("hello world & more");
      const q = capturedParams().get("q");
      expect(q).toBe("hello world & more");
    });
  });

  describe("result parsing", () => {
    it("returns an empty array when results are empty", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      const gifs = await searchGifs("nothing");
      expect(gifs).toEqual([]);
    });

    it("maps id, title, url (tinygif), and fullUrl (gif) correctly", async () => {
      mockFetch.mockResolvedValue(
        okResponse([tenorResult("abc123")]),
      );
      const gifs = await searchGifs("cats");
      expect(gifs).toHaveLength(1);
      expect(gifs[0]).toEqual({
        id: "abc123",
        title: "Title abc123",
        url: "https://media.tenor.com/abc123_tiny.gif",
        fullUrl: "https://media.tenor.com/abc123.gif",
      });
    });

    it("maps multiple results in order", async () => {
      mockFetch.mockResolvedValue(
        okResponse([tenorResult("a"), tenorResult("b"), tenorResult("c")]),
      );
      const gifs = await searchGifs("cats");
      expect(gifs.map((g) => g.id)).toEqual(["a", "b", "c"]);
    });

    it("filters out results with no tinygif format", async () => {
      mockFetch.mockResolvedValue(
        okResponse([
          tenorResult("keep"),
          tenorResult("drop", { tinygif: null }),
        ]),
      );
      const gifs = await searchGifs("cats");
      expect(gifs).toHaveLength(1);
      expect(gifs[0]?.id).toBe("keep");
    });

    it("filters out results with no gif format", async () => {
      mockFetch.mockResolvedValue(
        okResponse([
          tenorResult("keep"),
          tenorResult("drop", { gif: null }),
        ]),
      );
      const gifs = await searchGifs("cats");
      expect(gifs).toHaveLength(1);
      expect(gifs[0]?.id).toBe("keep");
    });

    it("filters out results missing both formats", async () => {
      mockFetch.mockResolvedValue(
        okResponse([
          tenorResult("drop", { tinygif: null, gif: null }),
          tenorResult("keep"),
        ]),
      );
      const gifs = await searchGifs("cats");
      expect(gifs).toHaveLength(1);
      expect(gifs[0]?.id).toBe("keep");
    });

    it("returns an empty array when all results lack required formats", async () => {
      mockFetch.mockResolvedValue(
        okResponse([
          tenorResult("x", { tinygif: null }),
          tenorResult("y", { gif: null }),
        ]),
      );
      const gifs = await searchGifs("cats");
      expect(gifs).toEqual([]);
    });
  });

  describe("HTTP error handling", () => {
    it("throws when the response is not ok", async () => {
      mockFetch.mockResolvedValue(errorResponse(429, "Too Many Requests"));
      await expect(searchGifs("cats")).rejects.toThrow();
    });

    it("error message includes the HTTP status code", async () => {
      mockFetch.mockResolvedValue(errorResponse(403, "Forbidden"));
      await expect(searchGifs("cats")).rejects.toThrow("403");
    });

    it("error message includes the status text", async () => {
      mockFetch.mockResolvedValue(errorResponse(403, "Forbidden"));
      await expect(searchGifs("cats")).rejects.toThrow("Forbidden");
    });

    it("throws when fetch itself rejects (network error)", async () => {
      mockFetch.mockRejectedValue(new Error("Network failure"));
      await expect(searchGifs("cats")).rejects.toThrow("Network failure");
    });
  });
});

// ---------------------------------------------------------------------------
// getTrendingGifs
// ---------------------------------------------------------------------------

describe("getTrendingGifs", () => {
  describe("URL construction", () => {
    it("calls the Tenor featured endpoint", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await getTrendingGifs();
      expect(capturedUrl()).toMatch(
        /^https:\/\/tenor\.googleapis\.com\/v2\/featured/,
      );
    });

    it("does not include a q param", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await getTrendingGifs();
      expect(capturedParams().has("q")).toBe(false);
    });

    it("includes the API key param", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await getTrendingGifs();
      expect(capturedParams().get("key")).toBeTruthy();
    });

    it("includes media_filter param", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await getTrendingGifs();
      expect(capturedParams().get("media_filter")).toBe("gif,tinygif");
    });

    it("defaults limit to 20", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await getTrendingGifs();
      expect(capturedParams().get("limit")).toBe("20");
    });

    it("passes an explicit limit override", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      await getTrendingGifs(10);
      expect(capturedParams().get("limit")).toBe("10");
    });
  });

  describe("result parsing", () => {
    it("returns an empty array when results are empty", async () => {
      mockFetch.mockResolvedValue(okResponse([]));
      const gifs = await getTrendingGifs();
      expect(gifs).toEqual([]);
    });

    it("maps fields correctly", async () => {
      mockFetch.mockResolvedValue(okResponse([tenorResult("trend1")]));
      const gifs = await getTrendingGifs();
      expect(gifs[0]).toEqual({
        id: "trend1",
        title: "Title trend1",
        url: "https://media.tenor.com/trend1_tiny.gif",
        fullUrl: "https://media.tenor.com/trend1.gif",
      });
    });

    it("filters out results with missing tinygif", async () => {
      mockFetch.mockResolvedValue(
        okResponse([
          tenorResult("keep"),
          tenorResult("drop", { tinygif: null }),
        ]),
      );
      const gifs = await getTrendingGifs();
      expect(gifs.map((g) => g.id)).toEqual(["keep"]);
    });

    it("filters out results with missing gif", async () => {
      mockFetch.mockResolvedValue(
        okResponse([
          tenorResult("keep"),
          tenorResult("drop", { gif: null }),
        ]),
      );
      const gifs = await getTrendingGifs();
      expect(gifs.map((g) => g.id)).toEqual(["keep"]);
    });
  });

  describe("HTTP error handling", () => {
    it("throws when the response is not ok", async () => {
      mockFetch.mockResolvedValue(errorResponse(500, "Internal Server Error"));
      await expect(getTrendingGifs()).rejects.toThrow();
    });

    it("error message includes the HTTP status code", async () => {
      mockFetch.mockResolvedValue(errorResponse(503, "Service Unavailable"));
      await expect(getTrendingGifs()).rejects.toThrow("503");
    });

    it("error message includes the status text", async () => {
      mockFetch.mockResolvedValue(errorResponse(503, "Service Unavailable"));
      await expect(getTrendingGifs()).rejects.toThrow("Service Unavailable");
    });

    it("throws when fetch itself rejects (network error)", async () => {
      mockFetch.mockRejectedValue(new Error("DNS lookup failed"));
      await expect(getTrendingGifs()).rejects.toThrow("DNS lookup failed");
    });
  });
});
