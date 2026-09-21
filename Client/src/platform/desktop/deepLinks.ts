// owncord:// deep links through the native deep-link plugin. Lifted verbatim
// from `lib/deep-link.ts`'s `initDeepLinks` (B7-5); the parsers it dispatches
// through are pure and stay in `lib/deep-link.ts`.
//
// The plugin stays a dynamic `import()`: it is not part of the startup chunk
// today, and this registry is statically reachable from the entry.
import { createLogger } from "@lib/logger";
import { parseInviteLink, parseMessageLink } from "@lib/deep-link";
import type { DeepLinks } from "../contracts/deepLinks";

const log = createLogger("deep-link");

const SCHEME = "owncord";

/**
 * Wire owncord:// deep links. No-op outside Tauri. `onInvite` is called once per
 * recognized invite link and `onMessage` once per message permalink, on both
 * cold start and warm launches.
 */
async function init(
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

export const deepLinks: DeepLinks = { init };
