/**
 * Server-content URL rules and the authenticated fetch: which URLs are the
 * configured server's, which are external, the Content-Type allowlist, and the
 * cert-pinned fetch that attaches the session token to the server's own routes.
 */

import { ensureHttpProxy } from "@lib/net/httpProxy";
import { authStore, getToken } from "@stores/auth.store";
import { desktop } from "../../../platform/desktop";
import { isConvertedImageMime, serverHost } from "./attachmentUrls";

/** Safe MIME types allowed as a server Blob's type — blocks script injection via crafted Content-Type. */
// Note: image/svg+xml is intentionally excluded — SVGs can execute JS if
// loaded in <object>, <embed>, or <iframe> contexts. Only raster formats
// are considered safe for blob: URL rendering via <img>.
const SAFE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/3gpp",
  "video/x-m4v",
  "video/x-matroska",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
]);

/** Sanitize a Content-Type header value for use as a Blob's type. */
export function sanitizeContentType(raw: string): string {
  const mime = raw.split(";")[0]?.trim() ?? "";
  return SAFE_MIME_TYPES.has(mime) ? raw : "application/octet-stream";
}

/** Check if a URL points to the configured OwnCord server. */
export function isServerUrl(url: string): boolean {
  if (serverHost === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.host === serverHost;
  } catch {
    return false;
  }
}

/** An absolute http(s) URL on some host other than the configured server —
 *  content the external-content broker, not the TOFU proxy, fetches. */
export function isExternalUrl(url: string): boolean {
  if (isServerUrl(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Image types the server scales into a bounded preview. A server too old to
 *  scale a WebP answers its /thumb with the file itself. */
const SCALED_IMAGE_MIMES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The server's bounded preview of an image file, or the file itself
 *  on a server that does not advertise thumbnails or for a type the server
 *  passes through unchanged (only JPEG, PNG and WebP are scaled). A HEIC, HEIF
 *  or TIFF always takes the preview: the file itself is not an image to a
 *  webview. */
export function thumbnailUrl(fileUrl: string, mime: string): string {
  if (
    authStore.getState().uploadPolicy?.thumbnails !== true ||
    (!SCALED_IMAGE_MIMES.has(mime) && !isConvertedImageMime(mime)) ||
    !isServerUrl(fileUrl)
  ) {
    return fileUrl;
  }
  const parsed = new URL(fileUrl);
  if (!/^\/api\/v1\/files\/[^/]+$/.test(parsed.pathname)) return fileUrl;
  parsed.pathname += "/thumb";
  return parsed.toString();
}

/** The URL whose bytes a webview can show in full: the file itself, or for a
 *  HEIC, HEIF or TIFF its JPEG preview. */
export function shownImageUrl(fileUrl: string, mime: string): string {
  return isConvertedImageMime(mime) ? thumbnailUrl(fileUrl, mime) : fileUrl;
}

/** Report whether a URL targets the configured OwnCord server host. */
export function isTrustedServerUrl(url: string): boolean {
  return isServerUrl(url);
}

/**
 * Server content routes that legitimately require the session bearer token:
 * attachments (channel ACLs), custom emoji and stickers (authenticated so an
 * emoji or sticker is not a tracking pixel) and link preview thumbnails. A server-host URL outside these is fetched without
 * credentials — otherwise a same-host URL someone put in a field the client
 * renders, such as an avatar, makes every viewer issue an authenticated
 * request to an arbitrary path on the server's own origin.
 */
const TOKEN_BEARING_ROUTES = [
  "/api/v1/files/",
  "/api/v1/emoji/",
  "/api/v1/stickers/",
  "/api/v1/link-previews/images/",
];

function isTokenBearingServerPath(pathname: string): boolean {
  return TOKEN_BEARING_ROUTES.some((route) => pathname.startsWith(route));
}

/**
 * Fetch a file from the OwnCord server through the Rust HTTP TOFU proxy's
 * loopback origin (cert-pinned) with the session bearer token attached —
 * /api/v1/files/{id} enforces channel ACLs, so an unauthenticated request
 * would 401. The token is only ever sent to the configured server host, and
 * only for the server's own content routes.
 *
 * Server URLs only. An external URL is never fetched directly: images
 * go through the external-content broker (`fetchExternalImage`), and anything
 * else is refused here rather than handed to a general-purpose client.
 */
export async function fetchServerFile(
  url: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  // i18n-exempt: internal guard, logged by the caller, never rendered
  if (!isServerUrl(url)) throw new Error("external URLs are fetched only through the broker");
  const parsed = new URL(url);
  const origin = await ensureHttpProxy(parsed.host);
  const headers: Record<string, string> = { ...extraHeaders };
  const token = getToken();
  if (token !== null && isTokenBearingServerPath(parsed.pathname)) {
    // i18n-exempt: HTTP wire header value, never rendered
    headers["Authorization"] = `Bearer ${token}`;
  }
  return desktop.http.fetch(`${origin}${parsed.pathname}${parsed.search}`, { headers });
}
