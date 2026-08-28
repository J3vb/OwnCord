// GIF search and trending, proxied by the user's own OwnCord server.
//
// The client NEVER talks to api.klipy.com and never holds the provider API
// key: a VITE_ build variable is inlined into the shipped bundle by design, so
// it can never hold a secret. The key lives in the server's `gif.api_key`
// config and the server makes the upstream call — see Server/api/gif_handler.go.
//
// The returned media URLs still point at Klipy's CDN, so they are validated
// against the CDN allowlist below before anything is rendered.

import type { ApiClient } from "./api";
import type { GifSearchResponse } from "./types";

const DEFAULT_LIMIT = 20;

/** The slice of the API client the GIF picker needs. */
export type GifApi = Pick<ApiClient, "gifSearch" | "gifTrending">;

export interface GifResult {
  readonly id: string;
  readonly title: string;
  /** tinygif URL for preview thumbnails */
  readonly url: string;
  /** Full-size gif URL for sending */
  readonly fullUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate that a URL originates from a trusted Klipy CDN domain. */
function isAllowedGifUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "klipy.com" || parsed.hostname.endsWith(".klipy.com"))
    );
  } catch {
    return false;
  }
}

function parseResults(data: GifSearchResponse): readonly GifResult[] {
  return data.results
    .filter((r) => {
      const tinyUrl = r.media_formats.tinygif?.url ?? "";
      const gifUrl = r.media_formats.gif?.url ?? "";
      return tinyUrl && gifUrl && isAllowedGifUrl(tinyUrl) && isAllowedGifUrl(gifUrl);
    })
    .map((r) => ({
      id: r.id,
      title: r.title,
      url: r.media_formats.tinygif!.url,
      fullUrl: r.media_formats.gif!.url,
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Search the server's GIF proxy for GIFs matching the given query. */
export async function searchGifs(
  api: GifApi,
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<readonly GifResult[]> {
  return parseResults(await api.gifSearch(query, limit));
}

/** Fetch currently trending GIFs via the server's GIF proxy. */
export async function getTrendingGifs(
  api: GifApi,
  limit: number = DEFAULT_LIMIT,
): Promise<readonly GifResult[]> {
  return parseResults(await api.gifTrending(limit));
}
