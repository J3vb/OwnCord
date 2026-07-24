/**
 * owncord:// deep links.
 *
 * OwnCord invites are *registration* invites (a code you supply when creating
 * an account on a server), so a deep link can only pre-fill and open the
 * register form — it cannot complete a join on its own. Accepted forms:
 *
 *   owncord://invite/<code>
 *   owncord://invite/<code>?host=<host>
 *   owncord://<code>                     (bare code)
 *
 * Cold starts are handled via getCurrent(); while the app is already running,
 * the single-instance plugin (built with the "deep-link" feature) forwards the
 * link and onOpenUrl() fires.
 */

import { createLogger } from "./logger";

const log = createLogger("deep-link");

const SCHEME = "owncord";
const PREFIX = `${SCHEME}://`;

export interface InviteLink {
  readonly code: string;
  readonly host?: string;
}

/**
 * Parse an owncord:// invite link. Returns null if the URL isn't an owncord://
 * link or carries no code. Pure — no side effects, safe to unit test.
 */
export function parseInviteLink(url: string): InviteLink | null {
  if (!url.startsWith(PREFIX)) return null;

  let rest = url.slice(PREFIX.length);
  let host: string | undefined;

  const queryStart = rest.indexOf("?");
  if (queryStart !== -1) {
    const params = new URLSearchParams(rest.slice(queryStart + 1));
    const h = params.get("host")?.trim();
    if (h) host = h;
    rest = rest.slice(0, queryStart);
  }

  const segments = rest.replace(/\/+$/, "").split("/").filter(Boolean);
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
 * recognized invite link, on both cold start and warm launches.
 */
export async function initDeepLinks(
  onInvite: (code: string, host?: string) => void,
): Promise<void> {
  let plugin: typeof import("@tauri-apps/plugin-deep-link");
  try {
    plugin = await import("@tauri-apps/plugin-deep-link");
  } catch {
    return; // not running under Tauri (e.g. dev browser / tests)
  }

  function dispatch(urls: readonly string[] | null): void {
    for (const url of urls ?? []) {
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
