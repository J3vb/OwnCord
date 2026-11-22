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
 * The owncord:// link an app restart (an update, Clear & Restart) copied into
 * this launch: the restart starts the new process with the old one's command
 * line, so the link the old process was started from comes back as this
 * launch's start-up link. Null when this launch is no restart, the old process
 * had no link, on Android (no such restart) and whenever the host cannot
 * answer: the start-up link then opens as before.
 */
async function linkCopiedByRestart(): Promise<string | null> {
  if (isAndroidHost()) return null;
  const answer = await tryInvoke<unknown>("restart_startup_link");
  return answer.ok && typeof answer.value === "string" ? answer.value : null;
}

/**
 * Wire owncord:// deep links on desktop and Android. No-op outside Tauri. `onInvite` is called once per
 * recognized invite link and `onMessage` once per message permalink, or per
 * channel link with no message id, on both cold start and warm launches. A
 * start-up link that an app restart copied from the old process is skipped:
 * that process opened it already. Any other link opens.
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
    const copied = await linkCopiedByRestart();
    const startup = (await plugin.getCurrent()) ?? [];
    const fresh = startup.filter((url) => url !== copied);
    if (fresh.length < startup.length) log.info("Skipping the start-up link an app restart copied");
    dispatch(fresh);
    await plugin.onOpenUrl((urls) => dispatch(urls));
  } catch (err) {
    log.warn("Failed to initialize deep links", { error: String(err) });
  }
}

export const deepLinks: DeepLinks = { init };
