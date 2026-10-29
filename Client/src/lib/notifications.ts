/**
 * Notification service — fires desktop notifications, flashes taskbar,
 * and plays sounds for incoming messages based on user preferences.
 */

import { loadPref } from "./preferences";
import { getChannelMutesHost, notificationAllowed } from "./channel-mutes";
import { channelNotificationLevel, shouldNotifyForLevel } from "./notificationLevel";
import { loadUserStatus } from "./userStatus";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { isWindowDetached } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { blocksStore } from "@stores/blocks.store";
import type { ChannelActivityEntry, ChatMessagePayload } from "./types";
import { isServerRowKind } from "./messageKind";
import { mentionsCurrentUser } from "./mentions";
import { jumpToMessage } from "./message-navigation";
import { createLogger } from "./logger";
import { registerSessionReset } from "./sessionRegistry";
import { cleanupNotificationAudio, playNotificationSound } from "./notificationSound";
import { soundSwitchOn } from "./soundPrefs";
import { resolveAuthor } from "@lib/formatting";
import { resolveDisplayName } from "@lib/avatar";
import { desktop } from "../platform/desktop";
import type { NotificationTarget } from "../platform/contracts/notifications";
import { connectText } from "../i18n/connect";

const log = createLogger("notifications");

/** Check if the app window is currently focused. */
function isWindowFocused(): boolean {
  return document.hasFocus();
}

/**
 * Coalescing window (U1c): messages arriving within this long after the last
 * notification for the same channel are folded into that one alert, so a burst
 * of twenty lines is one popup, not twenty; a DM burst folds the same way. A
 * mention is never folded — it is addressed to the reader, and dropping it
 * would hide the thing the alert exists for.
 */
const COALESCE_WINDOW_MS = 5000;

/** Last time (ms) a notification fired, by channel id. */
const lastNotifiedAt = new Map<number, number>();

/**
 * Whether this message is part of a burst already announced for its channel.
 * Records the new time when it is not, so the window measures from the alert
 * the reader actually saw. `alwaysNotify` (a mention) both bypasses the
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

// App-lifetime. Coalescing is keyed by channel id, which is only unique per
// server, so a stale window from the previous profile must not suppress the
// next server's first notification for the same id.
void registerSessionReset("notifications:audio", () => cleanupNotificationAudio(), {
  phase: "session",
});
// App-lifetime, like the entry above.
void registerSessionReset("notifications:coalescing", resetNotificationCoalescing, {
  phase: "session",
});

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
 * A followed thread an alert is for. A thread notifies as its parent
 * channel does: the parent's level and mute apply, and the popup is titled
 * "#parent › thread". `watching` is true while the reader has the thread open.
 */
export interface ThreadNotifyContext {
  readonly parentId: number;
  readonly name: string;
  readonly watching: boolean;
}

/** The "#channel" label of an alert, with the thread name after it for a thread. */
function alertLabel(channelName: string, thread: ThreadNotifyContext | undefined): string {
  return thread === undefined
    ? `#${channelName}`
    : connectText("notifications.inThread", { channel: `#${channelName}`, thread: thread.name });
}

/** The chime's preference gate: the "Notification Sounds" group switch
 *  AND the switch of the sound that would play, a mention's or a plain
 *  message's. Do Not Disturb is the caller's. */
function chimeEnabled(mentioned: boolean): boolean {
  return (
    loadPref<boolean>("notificationSounds", true) &&
    soundSwitchOn(mentioned ? "mention" : "message")
  );
}

/**
 * Handle an incoming chat message — fire desktop notification, flash
 * taskbar, and play sound based on user preferences.
 *
 * Should be called from the dispatcher when a chat_message arrives.
 * Skips notifications for the current user's own messages, for authors the
 * user has blocked, and when the window is focused on the message's channel; while focused on another
 * channel, only the chime may play.
 */
export function notifyIncomingMessage(payload: ChatMessagePayload): void {
  const currentUser = authStore.getState().user;

  // A server row (a call log or a group event) is a record, not a message: the
  // ring was the live signal for a call, so it gets no chime and no toast (the unread badge still counts it).
  if (isServerRowKind(payload.kind)) return;

  // Don't notify for own messages
  if (currentUser !== null && payload.user.id === currentUser.id) return;

  // Nor for a blocked author: no popup, flash or chime at any level
  if (blocksStore.getState().blockedByMe.has(payload.user.id)) return;

  // Don't notify if the window is focused AND the message is in the active
  // channel — UNLESS that channel is showing a detached around-window.
  // "Active" only means this is the channel on screen; a jump to
  // an old permalink/reply/search hit can leave it detached from the live
  // tail (messages.store's detachedChannels), in which case the user is
  // reading back-history and cannot see the new message at all — addMessage
  // silently refuses to append it. Without this check that combination
  // suppresses the one thing that would have told the user anything arrived.
  const focused = isWindowFocused();
  const activeChannelId = channelsStore.getState().activeChannelId;
  if (focused && payload.channel_id === activeChannelId && !isWindowDetached(payload.channel_id)) {
    return;
  }

  // While the app is focused and the message is in some other
  // channel, the popup and the taskbar flash are interruptions the user cannot
  // act on without leaving what they are doing, so they are suppressed. The
  // chime still plays (Discord desktop's behaviour) — but the window being
  // focused on a *different* channel is the only case: a detached
  // around-window in the active channel must still popup and flash,
  // because the new message is not on screen at all.
  const focusedElsewhere = focused && payload.channel_id !== activeChannelId;

  const mentionInfo = {
    mentions: payload.mentions,
    mentionsEveryone: payload.mentions_everyone,
    mentionRoles: payload.mention_roles,
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
  // A DM passes every level; its own mute and Do Not Disturb still apply.
  const { name: channelName, isDm } = resolveNotificationChannel(payload.channel_id);
  if (!shouldNotifyForLevel(channelNotificationLevel(payload.channel_id), { mentioned, isDm }))
    return;

  // A muted channel stops making noise entirely — popup, chime AND taskbar
  // flash, because a flashing taskbar is exactly the interruption the mute was
  // asked for. The unread badge is untouched (it is drawn from the store, not
  // from here) and just renders dimmed. A message that names the reader is
  // never silenced: see @lib/channel-mutes.
  if (!notificationAllowed(payload.channel_id, mentioned)) return;

  // Do Not Disturb — the settings panel promises "You will not receive desktop
  // notifications", so honour it for the popup, the chime and the taskbar
  // flash alike (a mention included, matching the popup and chime).
  const dnd = loadUserStatus() === "dnd";
  const showPopup = !dnd && !focusedElsewhere && loadPref<boolean>("desktopNotifications", true);
  const flash = !dnd && !focusedElsewhere && loadPref<boolean>("flashTaskbar", true);
  const chime = !dnd && chimeEnabled(mentioned);
  if (!showPopup && !flash && !chime) return;

  // A burst of messages in one channel is one alert, not twenty (U1c); a DM is
  // a channel like any other. A mention is always announced — it is what the
  // reader might otherwise miss.
  if (shouldCoalesce(payload.channel_id, mentioned, Date.now())) return;

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
  if (showPopup) {
    fireDesktopNotification(title, payload.content, payload.attachments.length, {
      host: currentHost(),
      channelId: payload.channel_id,
      messageId: payload.id,
    });
  }

  // Flash taskbar
  if (flash) {
    flashTaskbar();
  }

  // Notification sound
  if (chime) {
    playNotificationSound();
  }
}

/**
 * Announce a mention in a channel the reader is not looking at (an interim
 * alert). The server's `mention_count` frame is the only thing that reaches
 * the client for such a channel (its `chat_message` goes to the focused
 * channel alone), and it carries a total, not the message — so this alert has
 * no author or body and its target opens the channel, not a message.
 *
 * Gates mirror notifyIncomingMessage for a mention: level (`nothing` silences
 * all), channel mute (a mention passes it), Do Not Disturb, the popup/flash/
 * chime preferences, and the focused-on-another-channel rule (chime only).
 * Never coalesced — a mention is always announced. A DM is skipped: its badge
 * and its own chat_message are handled separately.
 *
 * The server's total also counts @everyone and @here, and the frame does not
 * say which kind raised it, so "Suppress @everyone" keeps these alerts off
 * entirely rather than let every @everyone through.
 */
export function notifyMention(channelId: number, thread?: ThreadNotifyContext): void {
  // A thread answers to its parent for the name, the level and the mute.
  const authority = thread?.parentId ?? channelId;
  const { name: channelName, isDm } = resolveNotificationChannel(authority);
  if (isDm) return;
  if (loadPref<boolean>("suppressEveryone", false)) return;

  const focused = isWindowFocused();
  if (focused && isViewing(channelId, thread)) return;
  const focusedElsewhere = focused && !isOpenSurface(channelId, thread);

  if (
    !shouldNotifyForLevel(channelNotificationLevel(authority), { mentioned: true, isDm: false })
  ) {
    return;
  }
  if (!notificationAllowed(authority, true)) return;

  const dnd = loadUserStatus() === "dnd";
  const showPopup = !dnd && !focusedElsewhere && loadPref<boolean>("desktopNotifications", true);
  const flash = !dnd && !focusedElsewhere && loadPref<boolean>("flashTaskbar", true);
  const chime = !dnd && chimeEnabled(true);

  if (showPopup) {
    const title = sanitizeNotif(
      connectText("notifications.mentionedIn", { channel: alertLabel(channelName, thread) }),
      80,
    );
    fireDesktopNotification(title, "", 0, { host: currentHost(), channelId: authority });
  }
  if (flash) flashTaskbar();
  if (chime) playNotificationSound();
}

/**
 * Announce one `channel_activity` entry: a new message in a channel the reader
 * is not viewing. The frame carries no content, so the popup has a
 * title and no body; it names the author when the frame does, and opens the
 * message itself.
 *
 * Gates match notifyIncomingMessage: own and blocked authors never alert,
 * "Suppress @everyone" drops an alert only the @everyone/@here caused (a
 * direct mention still alerts), then level, channel mute, Do Not Disturb, the
 * popup/flash/chime preferences, the focused-elsewhere rule and burst
 * coalescing. A DM is skipped: its own chat_message reaches every participant.
 */
export function notifyChannelActivity(
  entry: ChannelActivityEntry,
  thread?: ThreadNotifyContext,
): void {
  const authority = thread?.parentId ?? entry.channel_id;
  const { name: channelName, isDm } = resolveNotificationChannel(authority);
  if (isDm) return;

  const authorId = entry.author_id;
  if (authorId !== undefined) {
    if (authStore.getState().user?.id === authorId) return;
    if (blocksStore.getState().blockedByMe.has(authorId)) return;
  }

  const directMention = entry.mentions_you;
  const everyoneMention = entry.mentions_everyone;
  if (loadPref<boolean>("suppressEveryone", false) && everyoneMention && !directMention) return;
  const mentioned = directMention || everyoneMention;

  const focused = isWindowFocused();
  if (focused && isViewing(entry.channel_id, thread)) return;
  const focusedElsewhere = focused && !isOpenSurface(entry.channel_id, thread);

  // A followed thread's plain messages pass only a parent at "all": the level
  // check below needs a mention at any lower level, as in any channel.
  if (
    !shouldNotifyForLevel(channelNotificationLevel(authority), {
      mentioned,
      isDm: false,
    })
  )
    return;
  if (!notificationAllowed(authority, mentioned)) return;

  const dnd = loadUserStatus() === "dnd";
  const showPopup = !dnd && !focusedElsewhere && loadPref<boolean>("desktopNotifications", true);
  const flash = !dnd && !focusedElsewhere && loadPref<boolean>("flashTaskbar", true);
  const chime = !dnd && chimeEnabled(mentioned);
  if (!showPopup && !flash && !chime) return;

  if (shouldCoalesce(entry.channel_id, mentioned, Date.now())) return;

  if (showPopup) {
    const channel = alertLabel(channelName, thread);
    const member =
      authorId === undefined ? undefined : membersStore.getState().members.get(authorId);
    const author = member === undefined ? null : resolveDisplayName(member);
    const title =
      author === null
        ? mentioned
          ? connectText("notifications.mentionedIn", { channel })
          : connectText("notifications.newIn", { channel })
        : mentioned
          ? connectText("notifications.mentioned", { author, channel })
          : connectText("notifications.inChannel", { author, channel });
    // A thread's message is not in its parent's list, so the click opens the parent.
    fireDesktopNotification(
      sanitizeNotif(title, 80),
      "",
      0,
      thread === undefined
        ? { host: currentHost(), channelId: entry.channel_id, messageId: entry.message_id }
        : { host: currentHost(), channelId: authority },
    );
  }
  if (flash) flashTaskbar();
  if (chime) playNotificationSound();
}

/** Whether `channelId` is the open channel, or the open thread: the reader's current surface. */
function isOpenSurface(channelId: number, thread: ThreadNotifyContext | undefined): boolean {
  return thread !== undefined
    ? thread.watching
    : channelId === channelsStore.getState().activeChannelId;
}

/** Whether the reader can see `channelId` now: its surface, unless a detached window hides the live tail. */
function isViewing(channelId: number, thread: ThreadNotifyContext | undefined): boolean {
  return isOpenSurface(channelId, thread) && (thread !== undefined || !isWindowDetached(channelId));
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
 * markdown tokenizer keeps it out of the startup closure. An attachment-only
 * message has no visible words, so it falls back to a count ("sent 2
 * attachments") rather than an empty body.
 */
async function plainBody(rawContent: string, attachmentCount: number): Promise<string> {
  const { markdownToPlainText } = await import("./markdown");
  const text = markdownToPlainText(rawContent, connectText("notifications.spoiler"));
  if (text === "" && attachmentCount > 0) {
    return connectText("notifications.attachment", { count: attachmentCount });
  }
  return sanitizeNotif(text, 100);
}

/** The server the client is signed into now, as a notification target names it. */
function currentHost(): string {
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
 *
 * The native host shows a message notification through its own command so a
 * click can open `target` (the plugin's desktop backend drops clicks); the Web
 * Notification fallback keeps its own `onclick`, which works in the browser.
 */
function fireDesktopNotification(
  title: string,
  rawContent: string,
  attachmentCount: number,
  target: NotificationTarget,
): void {
  void (async () => {
    try {
      let permitted = await desktop.notifier.permissionGranted();
      if (!permitted) {
        permitted = await desktop.notifier.requestPermission();
      }

      if (permitted) {
        await desktop.notifier.showMessage(
          title,
          await plainBody(rawContent, attachmentCount),
          target,
        );
      }
    } catch (err) {
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
