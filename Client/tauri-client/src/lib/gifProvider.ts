// Klipy GIF API client — provides GIF search and trending.
// Drop-in replacement for Tenor (EOL June 30, 2026).
// Register at partner.klipy.com to get a production API key.
// Override via VITE_KLIPY_API_KEY at build time.
const KLIPY_API_KEY = import.meta.env.VITE_KLIPY_API_KEY ?? "";
const GIF_API_BASE = "https://api.klipy.com/v2";
const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GifResult {
  readonly id: string;
  readonly title: string;
  /** tinygif URL for preview thumbnails */
  readonly url: string;
  /** Full-size gif URL for sending */
  readonly fullUrl: string;
}

interface GifMediaFormat {
  readonly url: string;
}

interface GifApiResult {
  readonly id: string;
  readonly title: string;
  readonly media_formats: {
    readonly tinygif?: GifMediaFormat;
    readonly gif?: GifMediaFormat;
  };
}

interface GifSearchResponse {
  readonly results: readonly GifApiResult[];
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

/**
 * Search Klipy for GIFs matching the given query.
 */
export async function searchGifs(
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<readonly GifResult[]> {
  const params = new URLSearchParams({
    q: query,
    key: KLIPY_API_KEY,
    limit: String(limit),
    media_filter: "gif,tinygif",
  });

  const res = await fetch(`${GIF_API_BASE}/search?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`GIF search failed: ${res.status} ${res.statusText}`);
  }
  const data: GifSearchResponse = await res.json();
  return parseResults(data);
}

/**
 * Fetch currently trending GIFs from Klipy.
 */
export async function getTrendingGifs(
  limit: number = DEFAULT_LIMIT,
): Promise<readonly GifResult[]> {
  const params = new URLSearchParams({
    key: KLIPY_API_KEY,
    limit: String(limit),
    media_filter: "gif,tinygif",
  });

  const res = await fetch(`${GIF_API_BASE}/featured?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`GIF trending failed: ${res.status} ${res.statusText}`);
  }
  const data: GifSearchResponse = await res.json();
  return parseResults(data);
}
