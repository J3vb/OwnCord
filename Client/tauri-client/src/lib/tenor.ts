// Tenor API v2 client — provides GIF search and trending.
// Uses the anonymous test key for development.

// Tenor API key — defaults to Google's public anonymous test key from
// https://developers.google.com/tenor/guides/quickstart
// This key is intentionally public (Google's demo key, not a secret).
// Override via VITE_TENOR_API_KEY at build time for production use.
const TENOR_API_KEY =
  // codeql[js/hardcoded-credentials] -- Google's public anonymous demo key, not a secret
  import.meta.env.VITE_TENOR_API_KEY ?? "AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ";
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

/** Trusted Tenor CDN origins for URL validation. */
const TENOR_ALLOWED_ORIGINS = new Set([
  "https://media.tenor.com",
  "https://c.tenor.com",
  "https://media1.tenor.com",
]);

/** Validate that a URL originates from a trusted Tenor domain. */
function isTenorUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return TENOR_ALLOWED_ORIGINS.has(parsed.origin) && parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseResults(data: TenorResponse): readonly TenorGif[] {
  return data.results
    .filter((r) => {
      const tinyUrl = r.media_formats.tinygif?.url ?? "";
      const gifUrl = r.media_formats.gif?.url ?? "";
      return tinyUrl && gifUrl && isTenorUrl(tinyUrl) && isTenorUrl(gifUrl);
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
export async function getTrendingGifs(limit: number = DEFAULT_LIMIT): Promise<readonly TenorGif[]> {
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
