// How a notification reaches the user: the native or Web popup, the taskbar
// flash, and the target a click opens. notifications.ts decides whether and
// when; this only delivers.
import { createLogger } from "./logger";
import { getChannelMutesHost } from "./prefs/channelMutes";
import { jumpToMessage } from "./nav/messageNavigation";
import { desktop } from "../platform/desktop";
import type { NotificationTarget } from "../platform/contracts/notifications";
import { connectText } from "../i18n/connect";
import { isAndroidHost } from "./hostPlatform";

const log = createLogger("notifications");

/** Strip control characters from user-provided text and cap its length. */
export function sanitizeNotif(s: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars from user-provided strings
  const cleaned = s.replace(/[\x00-\x1F\x7F]/g, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
}

/**
 * The popup body for `rawContent`: its visible words, with a spoiler replaced
 * by its label rather than the hidden text, which would otherwise land verbatim
 * on a lock screen before anyone clicked to reveal it. A dynamic import of the
 * markdown tokenizer keeps it out of the startup closure. An attachment-only
 * message has no visible words, so it falls back to a count ("sent 2
 * attachments") rather than an empty body.
 */
async function plainBody(rawContent: string, attachmentCount: number): Promise<string> {
  const { markdownToPlainText } = await import("./text/markdown");
  const text = markdownToPlainText(rawContent, connectText("notifications.spoiler"));
  if (text === "" && attachmentCount > 0) {
    return connectText("notifications.attachment", { count: attachmentCount });
  }
  return sanitizeNotif(text, 100);
}

/** The server the client is signed into now, as a notification target names it. */
export function currentHost(): string {
  return getChannelMutesHost() ?? "";
}

/**
 * Open `channelId`/`messageId` from a notification or an `owncord://message/…`
 * link; with no `messageId` (a call notification, `owncord://channel/…`), open
 * the channel. When the source named a `host`, the jump is deferred until the signed-in
 * server is known (a cold-start toast launches the app before MainPage sets the
 * host and registers the jumper), then dropped if it named a different server —
 * its ids would otherwise name an unrelated channel here. A link that named no
 * server (a permalink pasted into chat) is always opened. One guard for both
 * sources, so they cannot drift.
 */
export function openMessageTarget(
  channelId: number,
  messageId: number | undefined,
  host?: string,
): void {
  // `jumpToMessage` buffers until the main page is live and applies the
  // cross-server guard at handoff, so a target that arrives during startup is
  // retained rather than discarded (F6).
  jumpToMessage(channelId, messageId, host);
}

/**
 * Open the message a clicked notification was for, through the same
 * cross-server guard as a deep link.
 */
export function openNotificationTarget(target: NotificationTarget): void {
  openMessageTarget(target.channelId, target.messageId, target.host);
}

/**
 * Fire a Tauri desktop notification. Falls back to Web Notification API.
 * Resolves whether the native notifier showed it; never rejects.
 *
 * The native host shows a message notification through its own command so a
 * click can open `target` (the plugin's desktop backend drops clicks); the Web
 * Notification fallback keeps its own `onclick`, which works in the browser.
 *
 * The Android app asks for the permission once after sign-in
 * (`features/unread-badge/permissionAsk.ts`) and in Settings, never from a
 * message, and has no Web Notification to fall back to.
 */
export function fireDesktopNotification(
  title: string,
  rawContent: string,
  attachmentCount: number,
  target: NotificationTarget,
): Promise<boolean> {
  return (async () => {
    const phone = isAndroidHost();
    try {
      let permitted = await desktop.notifier.permissionGranted();
      if (!permitted && !phone) {
        permitted = await desktop.notifier.requestPermission();
      }

      if (permitted) {
        await desktop.notifier.showMessage(
          title,
          await plainBody(rawContent, attachmentCount),
          target,
        );
      }
      return permitted;
    } catch (err) {
      if (phone) {
        log.warn("Notification not shown", err);
        return false;
      }
      log.debug("Tauri notification plugin unavailable, falling back to Web API", err);
      // Fallback to Web Notification API (dev mode / non-Tauri). Clicking it
      // focuses the window and opens the target as the native activation does.
      try {
        const body = await plainBody(rawContent, attachmentCount);
        const onClick = (): void => {
          window.focus();
          openNotificationTarget(target);
        };
        if (Notification.permission === "granted") {
          new Notification(title, { body }).addEventListener("click", onClick);
        } else if (Notification.permission !== "denied") {
          const result = await Notification.requestPermission();
          if (result === "granted") {
            new Notification(title, { body }).addEventListener("click", onClick);
          }
        }
      } catch (fallbackErr) {
        log.debug("Notifications not available", fallbackErr);
      }
      return false;
    }
  })();
}

/** Flash the taskbar icon to attract attention. */
export function flashTaskbar(): void {
  void (async () => {
    try {
      await desktop.notifier.flashTaskbar();
    } catch (err) {
      log.debug("Taskbar flash not available", err);
    }
  })();
}
