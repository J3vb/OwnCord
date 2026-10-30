/**
 * The taskbar/tray unread badge: mentions plus unread direct messages, the Discord red badge.
 *
 *   - a guild channel contributes its mentions only — plain unread there is
 *     chatter, not a badge;
 *   - a DM contributes its unread count, or only its mentions once muted,
 *     exactly as the sidebar's DM header total does. A mute drops chatter and
 *     never a mention, so a muted channel's mentions still count
 *     (`channel-mutes.ts`);
 *   - a guild channel whose notification level is `nothing` (its own, else the
 *     server's) drops its mentions but never the DMs: a DM is a person writing
 *     to you, not server chatter.
 *
 *   - a followed thread contributes its mentions, judged by its parent: the
 *     parent must be a channel the reader still lists, and a parent at
 *     `nothing` drops them.
 *
 * The count is pushed to the native host when it changes, and again when the
 * window is shown or focused (Windows drops the overlay when the taskbar
 * button is recreated), so a message that does not move it costs no IPC call.
 */

import { channelsStore } from "../../stores/channels.store";
import { dmStore } from "../../stores/dm.store";
import { followedThreadsStore } from "../../stores/followedThreads.store";
import { isChannelMuted } from "../../lib/prefs/channelMutes";
import { channelLevelResolver } from "../../lib/prefs/notificationLevel";
import { Disposable } from "../../lib/disposable";
import { loadPref, onPrefChange } from "../../lib/prefs/preferences";
import type { Notifier } from "../../platform/contracts/notifications";

/**
 * Settings > Notifications > "Unread message badge"; on unless switched off.
 * A stored value of the wrong type reads as the default (on).
 */
export function unreadBadgeEnabled(): boolean {
  return loadPref<boolean>("unreadBadge", true);
}

/** The badge count for the connected server, from the stores as they are now. */
export function unreadBadgeCount(): number {
  let count = 0;
  const levelOf = channelLevelResolver();
  for (const ch of channelsStore.getState().channels.values()) {
    // DMs are counted from dmStore below; their channels-store row is a mirror.
    // Muted or not, a guild channel's mentions count: "excluding muted
    // channels" in D6 excludes their plain unread, never their mentions.
    if (ch.type !== "dm" && levelOf(ch.id) !== "nothing") count += ch.mentionCount;
  }
  const channels = channelsStore.getState().channels;
  for (const [parentId, rows] of followedThreadsStore.getState().byParent) {
    if (!channels.has(parentId) || levelOf(parentId) === "nothing") continue;
    for (const row of rows) count += row.mentions;
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
  // Off pushes 0 and keeps it there; turning it on pushes the live count.
  const sync = (): void => push(unreadBadgeEnabled() ? unreadBadgeCount() : 0);
  // Windows keeps the overlay on the taskbar button, which a hide from the
  // tray or an Explorer restart recreates bare; re-apply it when shown.
  const resync = (): void => {
    if (document.visibilityState !== "visible") return;
    pushed = null;
    sync();
  };

  owner.addCleanup(channelsStore.subscribe(sync));
  owner.addCleanup(dmStore.subscribe(sync));
  owner.addCleanup(followedThreadsStore.subscribe(sync));
  // Mutes and the notification level are prefs; every write announces itself.
  onPrefChange("any", sync, owner.signal);
  window.addEventListener("focus", resync, { signal: owner.signal });
  document.addEventListener("visibilitychange", resync, { signal: owner.signal });
  sync();

  return () => {
    owner.destroy();
    push(0);
  };
}
