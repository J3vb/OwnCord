/**
 * Withdraw a channel's message notifications once the reader has seen it,
 * as the phone's notification shade expects: a DM read here, or on another
 * device, leaves no notification behind. Seen means its unread count went
 * back to zero, or it is the channel on screen while the app is in front
 * (a message there while the app was hidden raised a notification but never
 * an unread count).
 *
 * Only the Android notifier tracks what it showed; elsewhere `clearMessages`
 * does nothing, and nothing here costs a native call unless it showed one.
 */

import { channelsStore } from "../../stores/channels.store";
import { dmStore } from "../../stores/dm.store";
import { Disposable } from "../../lib/disposable";
import type { Notifier } from "../../platform/contracts/notifications";

/** Channels and DMs with anything unread, from the stores as they are now. */
function unreadChannels(): Set<number> {
  const ids = new Set<number>();
  for (const ch of channelsStore.getState().channels.values()) {
    if (ch.unreadCount > 0 || ch.mentionCount > 0) ids.add(ch.id);
  }
  for (const dm of dmStore.getState().channels) {
    if (dm.unreadCount > 0 || dm.mentionCount > 0) ids.add(dm.channelId);
  }
  return ids;
}

/**
 * Keep the shade in step with what the reader has seen. The stop function
 * also withdraws every message notification still showing, so a logout or a
 * server switch leaves none that would open the wrong server's channel.
 */
export function startNotificationClearing(notifier: Pick<Notifier, "clearMessages">): () => void {
  const owner = new Disposable();
  const clear = (channelId?: number): void => {
    notifier.clearMessages(channelId).catch(() => {});
  };

  let unread = unreadChannels();
  const onUnreadChange = (): void => {
    const now = unreadChannels();
    for (const id of unread) {
      if (!now.has(id)) clear(id);
    }
    unread = now;
  };

  const clearOnScreen = (): void => {
    if (document.visibilityState !== "visible") return;
    const active = channelsStore.getState().activeChannelId;
    if (active !== null) clear(active);
  };

  owner.addCleanup(channelsStore.subscribe(onUnreadChange));
  owner.addCleanup(dmStore.subscribe(onUnreadChange));
  owner.addCleanup(channelsStore.subscribeSelector((s) => s.activeChannelId, clearOnScreen));
  document.addEventListener("visibilitychange", clearOnScreen, { signal: owner.signal });
  window.addEventListener("focus", clearOnScreen, { signal: owner.signal });
  clearOnScreen();

  return () => {
    owner.destroy();
    clear();
  };
}
