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
  if (host === "") return null;
  const port = hasPort ? authority.slice(portAt + 1) : "";
  if (!/[^ -~]/.test(host)) return { host, port };
  try {
    return { host: new URL(`http://${host}`).hostname, port };
  } catch {
    return null;
  }
}

/** A link spelled the way the server stores it (Server/linkpreview/url.go): scheme and host
 *  lower-cased, trailing host dot and default port dropped, empty path "/", fragment dropped,
 *  path and query as written. Null for a link the server never previews (credentials, no host). */
export function normalizeLinkUrl(raw: string): string | null {
  const parts = LINK_PARTS.exec(raw.trim());
  if (parts === null) return null;
  const scheme = (parts[1] ?? "").toLowerCase();
  const authority = parts[2] ?? "";
  if (authority.includes("@")) return null;
  const split = splitAuthority(authority);
  if (split === null) return null;
  const defaultPort =
    (scheme === "http" && split.port === "80") || (scheme === "https" && split.port === "443");
  const hostPort = split.port !== "" && !defaultPort ? `${split.host}:${split.port}` : split.host;
  const path = parts[3] === undefined || parts[3] === "" ? "/" : parts[3];
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
