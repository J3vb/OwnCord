// GIF search and trending, proxied by the user's own OwnCord server.
//
// The client NEVER talks to api.klipy.com and never holds the provider API
// key: a VITE_ build variable is inlined into the shipped bundle by design, so
// it can never hold a secret. The key lives in the server's `gif.api_key`
// config and the server makes the upstream call — see Server/api/gif_handler.go.
//
// The returned media URLs still point at Klipy's CDN, so they are validated
// against the CDN allowlist below before anything is rendered.

import type { ApiClient } from "../api";
import type { GifSearchResponse } from "../types";

const DEFAULT_LIMIT = 20;

/** The slice of the API client the GIF picker needs. */
export type GifApi = Pick<ApiClient, "gifSearch" | "gifTrending">;

/** The slice of the API client that saves a user's favorite GIFs. */
export type GifFavoritesApi = Pick<
  ApiClient,
  "gifFavorites" | "addGifFavorite" | "removeGifFavorite"
>;

export interface GifResult {
  readonly id: string;
  readonly title: string;
  /** tinygif URL for preview thumbnails */
  readonly url: string;
  /** Full-size gif URL for sending */
  readonly fullUrl: string;
}

/** One page of results plus the cursor for the next ("" when there is none). */
export interface GifPage {
  readonly gifs: readonly GifResult[];
  readonly next: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate that a URL originates from a trusted Klipy CDN domain. */
export function isAllowedGifUrl(url: string): boolean {
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

function parsePage(data: GifSearchResponse): GifPage {
  return { gifs: parseResults(data), next: data.next ?? "" };
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

/**
 * Search the server's GIF proxy for GIFs matching the given query. `pos` is
 * the previous page's `next` cursor; omit it for the first page.
 */
export async function searchGifs(
  api: GifApi,
  query: string,
  limit: number = DEFAULT_LIMIT,
  pos?: string,
): Promise<GifPage> {
  return parsePage(
    await (pos === undefined ? api.gifSearch(query, limit) : api.gifSearch(query, limit, pos)),
  );
}

/** Fetch currently trending GIFs via the server's GIF proxy (`pos` as above). */
export async function getTrendingGifs(
  api: GifApi,
  limit: number = DEFAULT_LIMIT,
  pos?: string,
): Promise<GifPage> {
  return parsePage(
    await (pos === undefined ? api.gifTrending(limit) : api.gifTrending(limit, pos)),
  );
}
