/**
 * Server-built link previews: which cards a message shows and where their
 * thumbnails come from. The server fetched the linked page once; the viewer's
 * computer contacts only the OwnCord server (the thumbnail route, through the
 * same authenticated, cert-pinned fetch and durable image cache attachments
 * use), so nothing here goes through the external-content broker or asks for
 * external-content consent.
 */

import type { LinkPreviewCard } from "@lib/types";
import { linkPreviewsEnabled } from "@lib/net/serverCapabilities";
import { fetchImageAsObjectUrl } from "./attachments";
import { resolveServerUrl } from "./attachmentUrls";
import type { ImageLoadOptions } from "./attachmentExternal";

/** The message fields that decide whether it shows server cards. */
export interface CardSource {
  readonly linkPreviews?: readonly LinkPreviewCard[];
}

/**
 * The cards a message shows, or null when its server does not build them and
 * the local fetch (the legacy path) applies. A row that holds cards, even an
 * empty list, is a server row. A row with none, on a server whose `ready`
 * advertised the link_previews capability, has no card yet (a backfill pending, or a link the server could
 * not fetch): an empty list, never the local fetch.
 */
export function serverCardsFor(msg: CardSource): readonly LinkPreviewCard[] | null {
  if (msg.linkPreviews !== undefined) return msg.linkPreviews;
  return linkPreviewsEnabled() ? [] : null;
}

const LINK_PARTS = /^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** An authority's host (lower-cased, no trailing dot, punycode) and port, or null for no usable host. */
function splitAuthority(authority: string): { host: string; port: string } | null {
  const portAt = authority.lastIndexOf(":");
  const hasPort = portAt > authority.lastIndexOf("]");
  const rawHost = (hasPort ? authority.slice(0, portAt) : authority).toLowerCase();
  const host = rawHost.replace(/\.$/, "");
  if (host === "" || host.includes("%")) return null;
  const port = hasPort ? authority.slice(portAt + 1) : "";
  if (!/[^ -~]/.test(host)) return { host, port };
  try {
    return { host: new URL(`http://${host}`).hostname, port };
  } catch {
    return null;
  }
}

// -- Path spelling: Go's url.URL.EscapedPath, which the server stores ----------

/** Bytes Go's shouldEscape leaves alone in a path (encodePath mode). */
const PATH_PLAIN = /^[A-Za-z0-9\-_.~$&+=:@/;,]$/;
/** Characters a path may already hold for Go to keep it as written (validEncoded). */
const PATH_VALID = /^[A-Za-z0-9\-_.~$&+=:@/;,!'()*[\]%]$/;

/** The bytes a path's %XX escapes stand for, or null for a bad escape (Go refuses the link). */
function unescapePath(raw: string): number[] | null {
  const out: number[] = [];
  const bytes = new TextEncoder().encode(raw);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x25) {
      out.push(bytes[i]!);
      continue;
    }
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    out.push(Number.parseInt(hex, 16));
    i += 2;
  }
  return out;
}

/** Go's escape(s, encodePath): every byte outside the plain set as upper-case %XX. */
function escapePath(bytes: readonly number[]): string {
  return bytes
    .map((b) => {
      const ch = String.fromCharCode(b);
      return b < 0x80 && PATH_PLAIN.test(ch)
        ? ch
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** The path as the server writes it: as given when it is validly encoded, else
 *  decoded and encoded again (so a space, `|`, `{`, or a non-ASCII letter becomes %XX
 *  and %2f decodes to /). Null when the path holds a bad %-escape. */
function normalizePath(raw: string): string | null {
  const unescaped = unescapePath(raw);
  if (unescaped === null) return null;
  const valid = [...raw].every((ch) => PATH_VALID.test(ch));
  const path = valid ? raw : escapePath(unescaped);
  return path === "" ? "/" : path;
}

/** A link spelled the way the server stores it (Server/linkpreview/url.go): scheme and host
 *  lower-cased, trailing host dot and default port dropped, path as Go's EscapedPath writes it
 *  ("/" when empty), fragment dropped, query as written. Null for a link the server never
 *  previews (credentials, no host, a bad escape). The cases both sides must agree on are in
 *  protocol/fixtures/link-url-normalisation.json. */
export function normalizeLinkUrl(raw: string): string | null {
  const parts = LINK_PARTS.exec(raw.trim());
  if (parts === null) return null;
  const scheme = (parts[1] ?? "").toLowerCase();
  const authority = parts[2] ?? "";
  if (authority.includes("@")) return null;
  const split = splitAuthority(authority);
  const path = normalizePath(parts[3] ?? "");
  if (split === null || path === null) return null;
  const defaultPort =
    (scheme === "http" && split.port === "80") || (scheme === "https" && split.port === "443");
  const hostPort = split.port !== "" && !defaultPort ? `${split.host}:${split.port}` : split.host;
  return `${scheme}://${hostPort}${path}${parts[4] ?? ""}`;
}

/** The card the server built for `url` (a link as it appears in the message text), if any. */
export function cardForUrl(
  cards: readonly LinkPreviewCard[],
  url: string,
): LinkPreviewCard | undefined {
  const normalized = normalizeLinkUrl(url);
  return cards.find((card) => card.url === url || (normalized !== null && card.url === normalized));
}

/** A card with a picture and nothing else: the link is itself an image. */
export function isImageOnlyCard(card: LinkPreviewCard): boolean {
  return (
    card.image !== undefined &&
    (card.title ?? "").trim() === "" &&
    (card.description ?? "").trim() === "" &&
    (card.site_name ?? "").trim() === ""
  );
}

const THUMBNAIL_HASH = /^[0-9a-f]{64}$/;

/** Where a card's thumbnail is served, or null when it has none or the hash is not one. */
export function cardThumbnailUrl(card: LinkPreviewCard): string | null {
  const hash = card.image?.hash;
  if (hash === undefined || !THUMBNAIL_HASH.test(hash)) return null;
  return resolveServerUrl(`/api/v1/link-previews/images/${hash}`);
}

/** The thumbnail at `url` as a blob: URL: memory, then the durable image cache,
 *  then the server once. Null when it could not be had. */
export function loadCardThumbnail(url: string, opts?: ImageLoadOptions): Promise<string | null> {
  return fetchImageAsObjectUrl(url, opts);
}
