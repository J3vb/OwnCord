/**
 * Notification service — fires desktop notifications, flashes taskbar,
 * and plays sounds for incoming messages based on user preferences.
 */

import { loadPref } from "./preferences";
import { notificationAllowed } from "./channel-mutes";
import { effectiveNotificationLevel, shouldNotifyForLevel } from "./notificationLevel";
import { loadUserStatus } from "./userStatus";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { isWindowDetached } from "@stores/messages.store";
import type { ChatMessagePayload } from "./types";
import { mentionsCurrentUser } from "./mentions";
import { createLogger } from "./logger";
import { playNotificationSound } from "./notificationSound";
import { resolveAuthor } from "@lib/formatting";
import { resolveDisplayName } from "@lib/avatar";
import { desktop } from "../platform/desktop";
import { connectText } from "../i18n/connect";

const log = createLogger("notifications");

// The chimes live in `notificationSound.ts` so `pages/MainPage.ts` can ring a
// call without pulling this module (level gate, markdown body, dispatcher) into
// its chunk; re-exported here so existing importers of this module keep working.
export {
  cleanupNotificationAudio,
  startRingChime,
  stopRingChime,
  playNotificationSound,
} from "./notificationSound";

/** Check if the app window is currently focused. */
function isWindowFocused(): boolean {
  return document.hasFocus();
}

/**
 * Coalescing window (U1c): messages arriving within this long after the last
 * notification for the same channel are folded into that one alert, so a burst
 * of twenty lines is one popup, not twenty. A mention or a DM is never folded —
 * it is addressed to the reader, and dropping it would hide the thing the alert
 * exists for.
 */
const COALESCE_WINDOW_MS = 5000;

/** Last time (ms) a notification fired, by channel id. */
const lastNotifiedAt = new Map<number, number>();

/**
 * Whether this message is part of a burst already announced for its channel.
 * Records the new time when it is not, so the window measures from the alert
 * the reader actually saw. `alwaysNotify` (a mention or a DM) both bypasses the
 * check and refreshes the window.
 */
function shouldCoalesce(channelId: number, alwaysNotify: boolean, now: number): boolean {
  const last = lastNotifiedAt.get(channelId);
  if (alwaysNotify || last === undefined || now - last >= COALESCE_WINDOW_MS) {
    lastNotifiedAt.set(channelId, now);
    return false;
  }
  return true;
}

/** Forget coalescing state. Exported for tests and for logout. */
export function resetNotificationCoalescing(): void {
  lastNotifiedAt.clear();
}

/**
 * The name to show for a given channel/DM id, and whether it is a DM (a DM
 * gets no "#" prefix -- it is not a channel).
 *
 * DM ids are absent from channelsStore until the conversation is opened
 * (dispatcher.ts), so they must be checked first or the fallback below always
 * wins and a DM notification reads "Channel <id>". dmDisplayName is the one
 * place every DM-labelling surface (sidebar, header, quick switcher, and
 * this) agrees on what a conversation is called.
 */
function resolveNotificationChannel(channelId: number): { name: string; isDm: boolean } {
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  if (dm !== undefined) return { name: dmDisplayName(dm), isDm: true };
  const channel = channelsStore.getState().channels.get(channelId);
  return {
    name: channel?.name ?? connectText("notifications.channelFallback", { id: String(channelId) }),
    isDm: false,
  };
}

/**
 * Handle an incoming chat message — fire desktop notification, flash
 * taskbar, and play sound based on user preferences.
 *
 * Should be called from the dispatcher when a chat_message arrives.
 * Skips notifications for the current user's own messages and when
 * the window is focused on the message's channel.
 */
export function notifyIncomingMessage(payload: ChatMessagePayload): void {
  const currentUser = authStore.getState().user;

  // Don't notify for own messages
  if (currentUser !== null && payload.user.id === currentUser.id) return;

  // Don't notify if the window is focused AND the message is in the active
  // channel — UNLESS that channel is showing a detached around-window
  // (OC-0204). "Active" only means this is the channel on screen; a jump to
  // an old permalink/reply/search hit can leave it detached from the live
  // tail (messages.store's detachedChannels), in which case the user is
  // reading back-history and cannot see the new message at all — addMessage
  // silently refuses to append it. Without this check that combination
  // suppresses the one thing that would have told the user anything arrived.
  const activeChannelId = channelsStore.getState().activeChannelId;
  if (
    isWindowFocused() &&
    payload.channel_id === activeChannelId &&
    !isWindowDetached(payload.channel_id)
  ) {
    return;
  }

  const mentionInfo = {
    mentions: payload.mentions,
    mentionsEveryone: payload.mentions_everyone,
  };
  const directMention = mentionsCurrentUser(payload.content, mentionInfo);
  const everyoneMention = payload.mentions_everyone === true;

  // "Suppress @everyone" now means exactly that: only a notification the
  // @everyone/@here caused is dropped. A message that also names the user is
  // theirs to see, and an @everyone the sender lacked the permission for never
  // reached mention status in the first place, so it is not suppressed either.
  if (loadPref<boolean>("suppressEveryone", false) && everyoneMention && !directMention) {
    return;
  }

  const mentioned = directMention || everyoneMention;

  // How much this server may interrupt (U1b): All / Mentions only / Nothing,
  // a global preference with a per-server override. This is the first gate
  // because `nothing` must silence the popup, the chime AND the taskbar flash —
  // unlike a channel mute, which deliberately lets a direct mention through.
  const { name: channelName, isDm } = resolveNotificationChannel(payload.channel_id);
  if (!shouldNotifyForLevel(effectiveNotificationLevel(), { mentioned, isDm })) return;

  // A muted channel stops making noise entirely — popup, chime AND taskbar
  // flash, because a flashing taskbar is exactly the interruption the mute was
  // asked for. The unread badge is untouched (it is drawn from the store, not
  // from here) and just renders dimmed. A message that names the reader is
  // never silenced: see @lib/channel-mutes.
  if (!notificationAllowed(payload.channel_id, mentioned)) return;

  // Do Not Disturb — the settings panel promises "You will not receive desktop
  // notifications", so honour it for the popup and the chime. The taskbar
  // flash stays: it's a passive hint, not a notification.
  const dnd = loadUserStatus() === "dnd";

  // A burst of channel messages is one alert, not twenty (U1c). A mention or a
  // DM is always announced, and both are what the reader might otherwise miss.
  if (shouldCoalesce(payload.channel_id, mentioned || isDm, Date.now())) return;

  const channelLabel = isDm ? channelName : `#${channelName}`;

  // The name to show for the author, resolved the same way the message list
  // resolves it (resolveAuthor prefers the live membersStore nickname over
  // whatever was frozen into the payload; resolveDisplayName falls back to
  // the username when no nickname is set). Without this the notification
  // names the sender differently from the message row it points at.
  const authorName = resolveDisplayName(resolveAuthor(payload.user));

  const title = sanitizeNotif(
    mentioned
      ? connectText("notifications.mentioned", { author: authorName, channel: channelLabel })
      : connectText("notifications.inChannel", { author: authorName, channel: channelLabel }),
    80,
  );

  // Desktop notification. The body (the message's visible words, spoiler
  // label instead of hidden text) is computed inside the async path through a
  // dynamic import of the markdown tokenizer: this module is in the startup
  // closure, so a static import would drag the tokenizer in with it
  // (bundle-budget's startup-closure gate).
  if (!dnd && loadPref<boolean>("desktopNotifications", true)) {
    fireDesktopNotification(title, payload.content);
  }

  // Flash taskbar
  if (loadPref<boolean>("flashTaskbar", true)) {
    flashTaskbar();
  }

  // Notification sound
  if (!dnd && loadPref<boolean>("notificationSounds", true)) {
    playNotificationSound();
  }
}

/** Strip control characters from user-provided text and cap its length. */
function sanitizeNotif(s: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars from user-provided strings
  const cleaned = s.replace(/[\x00-\x1F\x7F]/g, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
}

/**
 * The popup body for `rawContent`: its visible words, with a spoiler replaced
 * by its label rather than the hidden text, which would otherwise land verbatim
 * on a lock screen before anyone clicked to reveal it. A dynamic import of the
 * markdown tokenizer keeps it out of the startup closure.
 */
async function plainBody(rawContent: string): Promise<string> {
  const { markdownToPlainText } = await import("./markdown");
  return sanitizeNotif(markdownToPlainText(rawContent, connectText("notifications.spoiler")), 100);
}

/** Fire a Tauri desktop notification. Falls back to Web Notification API. */
function fireDesktopNotification(title: string, rawContent: string): void {
  void (async () => {
    try {
      let permitted = await desktop.notifier.permissionGranted();
      if (!permitted) {
        permitted = await desktop.notifier.requestPermission();
      }

      if (permitted) {
        await desktop.notifier.show(title, await plainBody(rawContent));
      }
    } catch (err) {
      log.debug("Tauri notification plugin unavailable, falling back to Web API", err);
      // Fallback to Web Notification API (dev mode / non-Tauri)
      try {
        const body = await plainBody(rawContent);
        if (Notification.permission === "granted") {
          void new Notification(title, { body });
        } else if (Notification.permission !== "denied") {
          const result = await Notification.requestPermission();
          if (result === "granted") {
            void new Notification(title, { body });
          }
        }
      } catch (fallbackErr) {
        log.debug("Notifications not available", fallbackErr);
      }
    }
  })();
}

/** Flash the taskbar icon to attract attention. */
function flashTaskbar(): void {
  void (async () => {
    try {
      await desktop.notifier.flashTaskbar();
    } catch (err) {
      log.debug("Taskbar flash not available", err);
    }
  })();
}
