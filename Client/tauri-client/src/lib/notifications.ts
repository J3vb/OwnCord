/**
 * Notification service — fires desktop notifications, flashes taskbar,
 * and plays sounds for incoming messages based on user preferences.
 */

import { loadPref } from "./preferences";
import { notificationAllowed } from "./channel-mutes";
import { loadUserStatus } from "./userStatus";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import type { ChatMessagePayload } from "./types";
import { mentionsCurrentUser } from "./mentions";
import { createLogger } from "./logger";
import { resolveAuthor } from "@components/message-list/formatting";
import { resolveDisplayName } from "@lib/avatar";

const log = createLogger("notifications");

/** Check if the app window is currently focused. */
function isWindowFocused(): boolean {
  return document.hasFocus();
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
  return { name: channel?.name ?? `Channel ${channelId}`, isDm: false };
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

  // Don't notify if the window is focused AND the message is in the active channel
  const activeChannelId = channelsStore.getState().activeChannelId;
  if (isWindowFocused() && payload.channel_id === activeChannelId) return;

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

  const { name: channelName, isDm } = resolveNotificationChannel(payload.channel_id);
  const channelLabel = isDm ? channelName : `#${channelName}`;

  // The name to show for the author, resolved the same way the message list
  // resolves it (resolveAuthor prefers the live membersStore nickname over
  // whatever was frozen into the payload; resolveDisplayName falls back to
  // the username when no nickname is set). Without this the notification
  // names the sender differently from the message row it points at.
  const authorName = resolveDisplayName(resolveAuthor(payload.user));

  // oxlint-disable-next-line consistent-function-scoping -- co-located with its sole caller for readability
  function sanitizeNotif(s: string, maxLen: number): string {
    // eslint-disable-next-line no-control-regex -- intentional: strip control chars from user-provided strings
    const cleaned = s.replace(/[\x00-\x1F\x7F]/g, "");
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
  }

  const title = sanitizeNotif(
    mentioned
      ? `${authorName} mentioned you in ${channelLabel}`
      : `${authorName} in ${channelLabel}`,
    80,
  );
  const body = sanitizeNotif(payload.content, 100);

  // Desktop notification
  if (!dnd && loadPref<boolean>("desktopNotifications", true)) {
    fireDesktopNotification(title, body);
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

/** Fire a Tauri desktop notification. Falls back to Web Notification API. */
function fireDesktopNotification(title: string, body: string): void {
  void (async () => {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import("@tauri-apps/plugin-notification");

      let permitted = await isPermissionGranted();
      if (!permitted) {
        const result = await requestPermission();
        permitted = result === "granted";
      }

      if (permitted) {
        sendNotification({ title, body });
      }
    } catch {
      // Fallback to Web Notification API (dev mode / non-Tauri)
      try {
        if (Notification.permission === "granted") {
          void new Notification(title, { body });
        } else if (Notification.permission !== "denied") {
          const result = await Notification.requestPermission();
          if (result === "granted") {
            void new Notification(title, { body });
          }
        }
      } catch {
        log.debug("Notifications not available");
      }
    }
  })();
}

/** Flash the taskbar icon to attract attention. */
function flashTaskbar(): void {
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.requestUserAttention(2); // Informational attention
    } catch {
      log.debug("Taskbar flash not available");
    }
  })();
}

// Simple notification sound using Web Audio API
let notifAudioCtx: AudioContext | null = null;

/** Close and release the notification AudioContext. Call on logout/cleanup. */
export function cleanupNotificationAudio(): void {
  stopRingChime();
  if (notifAudioCtx !== null) {
    notifAudioCtx.close().catch((err) => {
      log.warn("Failed to close notification AudioContext", err);
    });
    notifAudioCtx = null;
  }
}

// The ring chime repeats until the call is answered, declined or times out —
// unlike a message chime, which fires once. It reuses playNotificationSound so
// a call sounds like the app rather than like a second app.
let ringInterval: ReturnType<typeof setInterval> | null = null;

/** Start the repeating incoming-call chime. Idempotent. */
export function startRingChime(): void {
  if (ringInterval !== null) return;
  // DND silences a call chime for the same reason it silences a message one:
  // the settings panel promises no notification sounds, and a ringing phone is
  // the loudest possible violation of that. The banner still appears.
  if (loadUserStatus() === "dnd") return;
  if (!loadPref<boolean>("notificationSounds", true)) return;
  playNotificationSound();
  ringInterval = setInterval(() => playNotificationSound(), 2000);
}

/** Stop the repeating incoming-call chime. Idempotent. */
export function stopRingChime(): void {
  if (ringInterval === null) return;
  clearInterval(ringInterval);
  ringInterval = null;
}

/** Play a brief notification chime. */
function playNotificationSound(): void {
  try {
    if (notifAudioCtx === null) {
      notifAudioCtx = new AudioContext();
    }
    const ctx = notifAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.setValueAtTime(600, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    log.debug("Notification sound not available");
  }
}
