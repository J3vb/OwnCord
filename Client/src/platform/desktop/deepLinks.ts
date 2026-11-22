// owncord:// deep links through the native deep-link plugin. Lifted verbatim
// from `lib/nav/deepLink.ts`'s `initDeepLinks`; the parsers it dispatches
// through are pure and stay in `lib/nav/deepLink.ts`.
//
// The plugin stays a dynamic `import()`: it is not part of the startup chunk
// today, and this registry is statically reachable from the entry.
import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";
import { parseChannelLink, parseInviteLink, parseMessageLink } from "@lib/nav/deepLink";
import type { DeepLinks } from "../contracts/deepLinks";
import { tryInvoke } from "./nativeInvoke";

const log = createLogger("deep-link");

const SCHEME = "owncord";

/**
 * Whether the host says this process was started by an app restart (an update
 * or Clear & Restart). A restart copies the old process's command line, so an
 * owncord:// link the first launch carried is this launch's start-up link too.
 * False on Android (no such restart) and whenever the host cannot answer: the
 * start-up link then opens as before.
 */
async function startedByAppRestart(): Promise<boolean> {
  if (isAndroidHost()) return false;
  const answer = await tryInvoke<unknown>("launch_was_restart");
  return answer.ok && answer.value === true;
}

/**
 * Wire owncord:// deep links on desktop and Android. No-op outside Tauri. `onInvite` is called once per
 * recognized invite link and `onMessage` once per message permalink, or per
 * channel link with no message id, on both cold start and warm launches. The
 * start-up link of an app restart is skipped: it is the link the app was first
 * started with, already opened then. Links that arrive later still open.
 */
async function init(
  onInvite: (code: string, host?: string) => void,
  onMessage?: (channelId: number, messageId: number | undefined, host?: string) => void,
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
        onMessage?.(message.channelId, message.messageId, message.host);
        continue;
      }
      const channel = parseChannelLink(url);
      if (channel !== null) {
        log.info("Deep-link channel received");
        onMessage?.(channel.channelId, undefined, channel.host);
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
    // Android has no runtime registration: the manifest's intent filter is it.
    if (!isAndroidHost()) {
      try {
        await plugin.register(SCHEME);
      } catch {
        // Already registered, or not permitted on this platform — ignore.
      }
    }
    const restarted = await startedByAppRestart();
    const current = await plugin.getCurrent();
    if (restarted && (current?.length ?? 0) > 0) {
      log.info("Skipping the start-up link of an app restart");
    } else {
      dispatch(current);
    }
    await plugin.onOpenUrl((urls) => dispatch(urls));
  } catch (err) {
    log.warn("Failed to initialize deep links", { error: String(err) });
  }
}

export const deepLinks: DeepLinks = { init };
