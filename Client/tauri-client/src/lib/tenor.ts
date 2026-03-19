// Tenor API v2 client — provides GIF search and trending.
// Uses the anonymous test key for development.

// Google's public anonymous Tenor API key (not a secret — safe to commit).
// See: https://developers.google.com/tenor/guides/quickstart
const TENOR_API_KEY = "AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ";
const TENOR_BASE = "https://tenor.googleapis.com/v2";
const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenorGif {
  readonly id: string;
  readonly title: string;
  /** tinygif URL for preview thumbnails */
  readonly url: string;
  /** Full-size gif URL for sending */
  readonly fullUrl: string;
}

interface TenorMediaFormat {
  readonly url: string;
}

interface TenorResult {
  readonly id: string;
  readonly title: string;
  readonly media_formats: {
    readonly tinygif?: TenorMediaFormat;
    readonly gif?: TenorMediaFormat;
  };
}

interface TenorResponse {
  readonly results: readonly TenorResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResults(data: TenorResponse): readonly TenorGif[] {
  return data.results
    .filter((r) => r.media_formats.tinygif?.url && r.media_formats.gif?.url)
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
 * Search Tenor for GIFs matching the given query.
 */
export async function searchGifs(
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<readonly TenorGif[]> {
  const params = new URLSearchParams({
    q: query,
    key: TENOR_API_KEY,
    limit: String(limit),
    media_filter: "gif,tinygif",
  });

  const res = await fetch(`${TENOR_BASE}/search?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Tenor search failed: ${res.status} ${res.statusText}`);
  }
  const data: TenorResponse = await res.json();
  return parseResults(data);
}

/**
 * Fetch currently trending GIFs from Tenor.
 */
export async function getTrendingGifs(
  limit: number = DEFAULT_LIMIT,
): Promise<readonly TenorGif[]> {
  const params = new URLSearchParams({
    key: TENOR_API_KEY,
    limit: String(limit),
    media_filter: "gif,tinygif",
  });

  const res = await fetch(`${TENOR_BASE}/featured?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Tenor trending failed: ${res.status} ${res.statusText}`);
  }
  const data: TenorResponse = await res.json();
  return parseResults(data);
}
