/**
 * The taskbar/tray unread badge (DP-27, owner decision D6 (a)): mentions plus
 * unread direct messages, the Discord red badge.
 *
 *   - a guild channel contributes its mentions only — plain unread there is
 *     chatter, not a badge;
 *   - a DM contributes its unread count, or only its mentions once muted,
 *     exactly as the sidebar's DM header total does. A mute drops chatter and
 *     never a mention, so a muted channel's mentions still count
 *     (`channel-mutes.ts`);
 *   - the `nothing` notification level counts nothing.
 *
 * The count is pushed to the native host only when it changes, so a message
 * that does not move it costs no IPC call.
 */

import { channelsStore } from "../../stores/channels.store";
import { dmStore } from "../../stores/dm.store";
import { isChannelMuted } from "../../lib/channel-mutes";
import { effectiveNotificationLevel } from "../../lib/notificationLevel";
import { Disposable } from "../../lib/disposable";
import type { Notifier } from "../../platform/contracts/notifications";

/** The badge count for the connected server, from the stores as they are now. */
export function unreadBadgeCount(): number {
  if (effectiveNotificationLevel() === "nothing") return 0;
  let count = 0;
  for (const ch of channelsStore.getState().channels.values()) {
    // DMs are counted from dmStore below; their channels-store row is a mirror.
    // Muted or not, a guild channel's mentions count: "excluding muted
    // channels" in D6 excludes their plain unread, never their mentions.
    if (ch.type !== "dm") count += ch.mentionCount;
  }
  for (const dm of dmStore.getState().channels) {
    count += isChannelMuted(dm.channelId) ? dm.mentionCount : dm.unreadCount;
  }
  return count;
}

/**
 * Keep the native badge in step with the stores, the mutes and the level.
 * Returns a stop function that also clears the badge, so a logout or a server
 * switch does not leave the previous session's count on the taskbar.
 */
export function startUnreadBadge(badge: Pick<Notifier, "setUnreadBadge">): () => void {
  const owner = new Disposable();
  let pushed: number | null = null;
  const push = (count: number): void => {
    if (count === pushed) return;
    pushed = count;
    // A browser host or an older native host has no badge; nothing to do.
    badge.setUnreadBadge(count).catch(() => {});
  };
  const sync = (): void => push(unreadBadgeCount());
  // Windows keeps the overlay on the taskbar button, which a hide from the
  // tray or an Explorer restart recreates bare; re-apply it when shown.
  const resync = (): void => {
    if (document.visibilityState !== "visible") return;
    pushed = null;
    sync();
  };

  owner.addCleanup(channelsStore.subscribe(sync));
  owner.addCleanup(dmStore.subscribe(sync));
  // Mutes and the notification level are prefs; every write announces itself.
  window.addEventListener("owncord:pref-change", sync, { signal: owner.signal });
  window.addEventListener("focus", resync, { signal: owner.signal });
  document.addEventListener("visibilitychange", resync, { signal: owner.signal });
  sync();

  return () => {
    owner.destroy();
    push(0);
  };
}
