/**
 * Server host state, URL resolution and MIME checks for attachments.
 */

import { createLogger } from "@lib/logger";
import { formatByteSize } from "@lib/voice/connectionStats";
import { authStore } from "@stores/auth.store";
import { bracketBareIPv6Host } from "@lib/ws";
import type { Attachment } from "@lib/types";
import { setExternalConsentScope } from "../../features/content-consent/external";

export const log = createLogger("attachments");

// -- Server host state --------------------------------------------------------

/** Module-level server host for resolving relative attachment URLs. */
export let serverHost: string | null = null;

/** Set the server host (called once from MainPage on connect).
 *  Strips a trailing default-HTTPS ":443" and lowercases, mirroring
 *  normalizeHostForCertCompare in lib/ws.ts and cert_store_key in
 *  src-tauri/src/tofu.rs — config hosts are stored verbatim (e.g.
 *  "Example.COM:443") but WHATWG URL drops the default port for https:,
 *  so isServerUrl's host comparison must normalize the same way or a
 *  ":443"-suffixed host never matches its own resolved URLs.
 *
 *  Only strip the trailing ":443" when what's left is unambiguously a host
 *  (no remaining colon) or a bracketed IPv6 literal (ends in "]", as in
 *  "[::1]:443") — otherwise a bare IPv6 literal whose final hextet is "443"
 *  (e.g. "fd00::443") would have that hextet eaten as if it were a port,
 *  same guard as tofu.rs::cert_store_key.
 *
 *  A bare (unbracketed) IPv6 literal is then wrapped in brackets so it forms
 *  a parseable authority: resolveServerUrl interpolates serverHost directly
 *  into a URL, and WHATWG's URL.host is always the bracketed form for IPv6,
 *  so isServerUrl's comparison also needs the bracketed form to ever match. */
export function setServerHost(host: string): void {
  const withoutPort =
    host.endsWith(":443") && (!host.slice(0, -4).includes(":") || host.slice(0, -4).endsWith("]"))
      ? host.slice(0, -4)
      : host;
  serverHost = bracketBareIPv6Host(withoutPort).toLowerCase();
  setExternalConsentScope(serverHost);
}

/** Resolve a potentially relative URL to a full URL using the server host. */
export function resolveServerUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (serverHost !== null) {
    return `https://${serverHost}${url}`;
  }
  return url;
}

// -- Helpers ------------------------------------------------------------------

export function formatFileSize(bytes: number): string {
  return formatByteSize(bytes, 1024, "KB", 1);
}

/** Strip any `; codecs=…` parameters and normalise case before matching. */
function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether the attachment should render as an inline <img>.
 *  image/svg+xml is excluded: an SVG can carry script, and it is the one image
 *  type the data-URI allowlist already refuses — inlining it only ever produced
 *  a permanently-loading placeholder, so it belongs on the download chip. */
export function isImageMime(mime: string): boolean {
  const base = baseMime(mime);
  // A HEIC or TIFF is shown through the server's JPEG preview; a
  // server that does not advertise thumbnails has none, so it stays a file.
  if (isConvertedImageMime(base)) return authStore.getState().uploadPolicy?.thumbnails === true;
  return base.startsWith("image/") && base !== "image/svg+xml";
}

/** Image types no webview decodes, which the server previews as a JPEG at the
 *  file's `/thumb` route. The original is kept; Download gives it. */
export function isConvertedImageMime(mime: string): boolean {
  const base = baseMime(mime);
  return base === "image/heic" || base === "image/heif" || base === "image/tiff";
}

/** Container MIME types we are willing to hand to a <video> element.
 *  An allowlist, not a `video/` prefix test: an unknown container gets the
 *  download chip rather than a player that silently fails to decode. */
const INLINE_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/3gpp",
  "video/x-m4v",
  "video/x-matroska",
]);

/** Video extensions trusted only when the server could not type the file
 *  (a .mov stored before it learned QuickTime, a .3gp it still stores as
 *  generic). A player that cannot decode one falls back to the download chip.
 *  .avi is deliberately absent: the engines do not read it. */
const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "webm", "mkv", "3gp", "ogv"]);

/** Container MIME types we are willing to hand to an <audio> element.
 *  Includes the common aliases servers emit for MP3 and WAV. */
const INLINE_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
]);

/** Whether the attachment should render as an inline <video> player.
 *  image/svg+xml can never reach here — SVG stays excluded from every inline
 *  path because it can carry script. */
export function isVideoMime(mime: string): boolean {
  return INLINE_VIDEO_MIMES.has(baseMime(mime));
}

/** Whether the attachment should render as an inline <video> player: by its
 *  MIME type, or by its extension when that type is the generic one. */
export function isVideoAttachment(att: Pick<Attachment, "mime" | "filename">): boolean {
  if (isVideoMime(att.mime)) return true;
  const base = baseMime(att.mime);
  if (base !== "" && base !== "application/octet-stream") return false;
  const dot = att.filename.lastIndexOf(".");
  return dot > 0 && VIDEO_EXTENSIONS.has(att.filename.slice(dot + 1).toLowerCase());
}

/** Whether the attachment should render as an inline <audio> player. */
export function isAudioMime(mime: string): boolean {
  return INLINE_AUDIO_MIMES.has(baseMime(mime));
}

export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
