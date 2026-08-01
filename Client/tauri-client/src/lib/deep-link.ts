/**
 * owncord:// deep links.
 *
 * Two routes share the scheme:
 *
 *   owncord://invite/<code>              registration invite
 *   owncord://invite/<code>?host=<host>
 *   owncord://<code>                     (bare code — invite)
 *   owncord://message/<channelId>/<messageId>   message permalink
 *
 * OwnCord invites are *registration* invites (a code you supply when creating
 * an account on a server), so an invite link can only pre-fill and open the
 * register form — it cannot complete a join on its own. A message link opens
 * the channel and jumps to the message, and is ignored when the channel is not
 * visible to this user.
 *
 * Cold starts are handled via getCurrent(); while the app is already running,
 * the single-instance plugin (built with the "deep-link" feature) forwards the
 * link and onOpenUrl() fires.
 */

import { createLogger } from "./logger";

const log = createLogger("deep-link");

const SCHEME = "owncord";
const PREFIX = `${SCHEME}://`;
/** Route segment that owns the message-permalink form. */
const MESSAGE_ROUTE = "message";

export interface InviteLink {
  readonly code: string;
  readonly host?: string;
}

export interface MessageLink {
  readonly channelId: number;
  readonly messageId: number;
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
 * Parse an `owncord://message/<channelId>/<messageId>` permalink. Returns null
 * for any other owncord:// route, another scheme, or non-numeric ids. Pure.
 */
export function parseMessageLink(url: string): MessageLink | null {
  const parts = linkSegments(url);
  if (parts === null || parts.segments[0] !== MESSAGE_ROUTE) return null;
  const channelId = parseIdSegment(parts.segments[1]);
  const messageId = parseIdSegment(parts.segments[2]);
  if (channelId === null || messageId === null) return null;
  return { channelId, messageId };
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
  // A message permalink is not a bare invite code.
  if (segments[0] === MESSAGE_ROUTE) return null;
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
 * Wire owncord:// deep links. No-op outside Tauri. `onInvite` is called once per
 * recognized invite link and `onMessage` once per message permalink, on both
 * cold start and warm launches.
 */
export async function initDeepLinks(
  onInvite: (code: string, host?: string) => void,
  onMessage?: (channelId: number, messageId: number) => void,
): Promise<void> {
  let plugin: typeof import("@tauri-apps/plugin-deep-link");
  try {
    plugin = await import("@tauri-apps/plugin-deep-link");
  } catch {
    return; // not running under Tauri (e.g. dev browser / tests)
  }

  function dispatch(urls: readonly string[] | null): void {
    for (const url of urls ?? []) {
      const message = parseMessageLink(url);
      if (message !== null) {
        log.info("Deep-link message permalink received");
        onMessage?.(message.channelId, message.messageId);
        continue;
      }
      const invite = parseInviteLink(url);
      if (invite) {
        log.info("Deep-link invite received", { hasHost: invite.host !== undefined });
        onInvite(invite.code, invite.host);
      } else {
        log.warn("Ignoring unrecognized deep link");
      }
    }
  }

  try {
    // Runtime registration is idempotent and needed for dev + some Linux/Windows
    // setups; the installer also registers the scheme from tauri.conf.json.
    try {
      await plugin.register(SCHEME);
    } catch {
      // Already registered, or not permitted on this platform — ignore.
    }
    dispatch(await plugin.getCurrent());
    await plugin.onOpenUrl((urls) => dispatch(urls));
  } catch (err) {
    log.warn("Failed to initialize deep links", { error: String(err) });
  }
}
