/**
 * Video and audio sources: blob: URLs through the authenticated fetch, and the
 * server-minted file links a `<video>` can stream from without a header.
 */

import { ensureHttpProxy } from "@lib/net/httpProxy";
import { getToken } from "@stores/auth.store";
import { desktop } from "../../../platform/desktop";
import { log } from "./attachmentUrls";
import { createObjectUrl, currentGeneration, revokeObjectUrl } from "./attachmentObjectUrls";
import {
  fileLinkInFlight,
  fileLinkRefused,
  fileLinks,
  mediaCache,
  mediaInFlight,
  type FileLink,
} from "./attachmentCacheState";
import { fetchServerFile, isServerUrl, sanitizeContentType } from "./attachmentServerFetch";

/**
 * Fetch a video/audio attachment through the same authenticated,
 * cert-pinned path images use (fetchServerFile attaches the session bearer
 * token, which /api/v1/files/{id} requires) and hand back a blob: URL.
 *
 * Deliberately not the image path: that one parks the bytes in IndexedDB too,
 * which is fine for a screenshot and ruinous for a 50 MB video. The Content-Type
 * goes through the same allowlist so a crafted header cannot turn a
 * permission-checked download into an executable type.
 */
export function fetchMediaAsObjectUrl(url: string): Promise<string | null> {
  const generation = currentGeneration();

  const cached = mediaCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = mediaInFlight.get(url);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<string | null> => {
    try {
      const res = await fetchServerFile(url);
      if (!res.ok) return null;
      const contentType = sanitizeContentType(res.headers.get("content-type") ?? "");
      const buffer = await res.arrayBuffer();
      const objectUrl = createObjectUrl(new Blob([buffer], { type: contentType }));
      if (objectUrl === null) return null;
      // A cache clear (channel switch, logout) during the fetch means this
      // blob belongs to a session that is gone — release it rather than
      // resurrecting it into the fresh cache.
      if (generation !== currentGeneration()) {
        revokeObjectUrl(objectUrl);
        return null;
      }
      mediaCache.set(url, objectUrl, buffer.byteLength);
      return objectUrl;
    } catch (err) {
      log.error("Failed to fetch media attachment", { url, error: String(err) });
      return null;
    }
  })();

  mediaInFlight.set(url, promise);
  void promise.finally(() => {
    if (mediaInFlight.get(url) === promise) {
      mediaInFlight.delete(url);
    }
  });

  return promise;
}

// ---------------------------------------------------------------------------
// File links: a <video> streams from a server-minted link
// ---------------------------------------------------------------------------

/** A link is replaced this long before the server expires it. */
const FILE_LINK_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The attachment path a link can be minted for (not /thumb). */
const FILE_LINK_PATH = /^\/api\/v1\/files\/[^/]+$/;

/** The parsed URL when a link can be minted for it: the server's own
 *  attachment path (not /thumb). */
function mintableUrl(url: string): URL | null {
  if (!isServerUrl(url)) return null;
  const parsed = new URL(url);
  return FILE_LINK_PATH.test(parsed.pathname) ? parsed : null;
}

/** The link's path and expiry from the server's reply, or null when malformed. */
function parseFileLinkBody(body: unknown): { path: string; expiresAtMs: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const { path, expires_at: expiresAt } = body as { path?: unknown; expires_at?: unknown };
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (typeof path !== "string" || !path.startsWith("/api/v1/files/") || Number.isNaN(expiresAtMs)) {
    return null;
  }
  return { path, expiresAtMs };
}

async function requestFileLink(url: string): Promise<FileLink | null> {
  const generation = currentGeneration();
  try {
    const parsed = mintableUrl(url);
    if (parsed === null) return null;
    const token = getToken();
    if (token === null) return null;
    const origin = await ensureHttpProxy(parsed.host);
    const res = await desktop.http.fetch(`${origin}${parsed.pathname}/link`, {
      method: "POST",
      // i18n-exempt: HTTP wire header value, never rendered
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404 || res.status === 405) {
      if (generation === currentGeneration()) fileLinkRefused.add(url);
      return null;
    }
    if (!res.ok) return null;
    const fields = parseFileLinkBody(await res.json());
    if (fields === null) return null;
    // A cache clear (logout, server switch) during the request: the link
    // belongs to a session that is gone.
    if (generation !== currentGeneration()) return null;
    const link: FileLink = { src: `${origin}${fields.path}`, expiresAtMs: fields.expiresAtMs };
    fileLinks.set(url, link);
    return link;
  } catch (err) {
    // The error text is logged, never the URL: a link is a credential.
    log.warn("File link request failed", { error: String(err) });
    return null;
  }
}

/** A usable streaming source for a server attachment, or null when there is
 *  none (an older server, a refused or failed request) and the caller should
 *  use the blob path. `fresh` discards the held link first. */
export function getFileLink(url: string, fresh = false): Promise<FileLink | null> {
  if (fresh) fileLinks.delete(url);
  if (fileLinkRefused.has(url)) return Promise.resolve(null);
  const held = fileLinks.get(url);
  if (held !== undefined && held.expiresAtMs - Date.now() > FILE_LINK_REFRESH_MARGIN_MS) {
    return Promise.resolve(held);
  }
  // A fresh link is wanted because the one in flight (or just held) may be
  // the one that failed, so it does not join an earlier request.
  const existing = fresh ? undefined : fileLinkInFlight.get(url);
  if (existing !== undefined) return existing;
  const promise = requestFileLink(url);
  fileLinkInFlight.set(url, promise);
  void promise.finally(() => {
    if (fileLinkInFlight.get(url) === promise) fileLinkInFlight.delete(url);
  });
  return promise;
}
