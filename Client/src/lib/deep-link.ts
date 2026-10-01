/**
 * owncord:// deep links.
 *
 * Three routes share the scheme:
 *
 *   owncord://invite/<code>              registration invite
 *   owncord://invite/<code>?host=<host>
 *   owncord://<code>                     (bare code — invite)
 *   owncord://message/<channelId>/<messageId>            message permalink
 *   owncord://message/<channelId>/<messageId>?host=<host>  a toast's launch URI
 *   owncord://channel/<channelId>?host=<host>  a call toast's launch URI (DP-24)
 *
 * OwnCord invites are *registration* invites (a code you supply when creating
 * an account on a server), so an invite link can only pre-fill and open the
 * register form — it cannot complete a join on its own. A message link opens
 * the channel and jumps to the message, and is ignored when the channel is not
 * visible to this user. A Windows message toast's launch URI carries `host` so
 * a click from Action Center names its server; a link whose host is not the
 * signed-in server is ignored rather than opening an unrelated message.
 *
 * Cold starts are handled via getCurrent(); while the app is already running,
 * the single-instance plugin (built with the "deep-link" feature) forwards the
 * link and onOpenUrl() fires. That native wiring is `platform/desktop/deepLinks.ts`
 * (B7-5); the parsers here are pure and need no native seam.
 */

const SCHEME = "owncord";
const PREFIX = `${SCHEME}://`;
/** Route segment that owns the message-permalink form. */
const MESSAGE_ROUTE = "message";
/** Route segment of a call notification's launch URI: it opens the DM. */
const CHANNEL_ROUTE = "channel";

export interface InviteLink {
  readonly code: string;
  readonly host?: string;
}

export interface MessageLink {
  readonly channelId: number;
  readonly messageId: number;
  /**
   * The server the link named, when it carried one. A Windows message toast
   * sets this so a click from Action Center after the banner timed out still
   * says which server it was for; channel and message ids are only unique per
   * server, so the app must ignore a target for a server it is not signed into.
   */
  readonly host?: string;
}

/** A call notification's target: the DM, on the server `host` names. */
export interface ChannelLink {
  readonly channelId: number;
  readonly host?: string;
}

/** Split an owncord:// URL into its path segments, or null for other schemes. */
function linkSegments(url: string): { segments: string[]; query: string } | null {
  if (!url.startsWith(PREFIX)) return null;
  let rest = url.slice(PREFIX.length);
  let query = "";
  const queryStart = rest.indexOf("?");
  if (queryStart !== -1) {
    query = rest.slice(queryStart + 1);
    rest = rest.slice(0, queryStart);
  }
  return { segments: rest.replace(/\/+$/, "").split("/").filter(Boolean), query };
}

/** Parse a positive integer segment, or null when it is anything else. */
function parseIdSegment(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Build the canonical permalink for a message. The inverse of
 * {@link parseMessageLink}.
 */
export function formatMessageLink(channelId: number, messageId: number): string {
  return `${PREFIX}${MESSAGE_ROUTE}/${channelId}/${messageId}`;
}

/**
 * Parse an `owncord://message/<channelId>/<messageId>` permalink, with an
 * optional `?host=` naming the server it came from. Returns null for any other
 * owncord:// route, another scheme, or non-numeric ids. Pure.
 */
export function parseMessageLink(url: string): MessageLink | null {
  const parts = linkSegments(url);
  if (parts === null || parts.segments[0] !== MESSAGE_ROUTE) return null;
  const channelId = parseIdSegment(parts.segments[1]);
  const messageId = parseIdSegment(parts.segments[2]);
  if (channelId === null || messageId === null) return null;
  const host = hostParam(parts.query);
  return host === "" ? { channelId, messageId } : { channelId, messageId, host };
}

/**
 * Parse an `owncord://channel/<channelId>` link, with an optional `?host=`: a
 * call notification's launch URI. Validated exactly as a message permalink is.
 * Returns null for any other route, another scheme, or a non-numeric id. Pure.
 */
export function parseChannelLink(url: string): ChannelLink | null {
  const parts = linkSegments(url);
  if (parts === null || parts.segments[0] !== CHANNEL_ROUTE) return null;
  const channelId = parseIdSegment(parts.segments[1]);
  if (channelId === null) return null;
  const host = hostParam(parts.query);
  return host === "" ? { channelId } : { channelId, host };
}

/** The trimmed `host` query parameter, or "" when there is none. */
function hostParam(query: string): string {
  return query === "" ? "" : (new URLSearchParams(query).get("host") ?? "").trim();
}

/**
 * Parse an owncord:// invite link. Returns null if the URL isn't an owncord://
 * link, is a different route (e.g. a message permalink), or carries no code.
 * Pure — no side effects, safe to unit test.
 */
export function parseInviteLink(url: string): InviteLink | null {
  const parts = linkSegments(url);
  if (parts === null) return null;

  let host: string | undefined;
  if (parts.query !== "") {
    const h = new URLSearchParams(parts.query).get("host")?.trim();
    if (h) host = h;
  }

  const segments = parts.segments;
  // A message permalink or a channel link is not a bare invite code.
  if (segments[0] === MESSAGE_ROUTE || segments[0] === CHANNEL_ROUTE) return null;
  // `owncord://invite/<code>` or bare `owncord://<code>`.
  const codeSegment = segments[0] === "invite" ? segments[1] : segments[0];
  if (!codeSegment) return null;

  let code: string;
  try {
    code = decodeURIComponent(codeSegment);
  } catch {
    code = codeSegment;
  }
  code = code.trim();
  if (!code) return null;

  return host ? { code, host } : { code };
}

/**
 * Normalise a raw invite code for submission: trim, then lower-case, and
 * accept a pasted `owncord://invite/<code>` (or bare `owncord://<code>`) link
 * by pulling its code out first. Server codes are lower-case hex and redemption
 * is an exact, case-sensitive match, so a typed/pasted upper-case code or a
 * whole link would otherwise be refused with the same opaque 400. Never throws,
 * and an empty result means the caller should fall back to its own required
 * check. Pure.
 */
export function normaliseInviteCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const link = parseInviteLink(trimmed);
  const code = link ? link.code : trimmed;
  return code.trim().toLowerCase();
}
