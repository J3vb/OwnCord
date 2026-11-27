/**
 * Under Command Deck, DM mode no longer swaps the channel list for the DM list,
 * so nothing else ends it when the user goes back to a channel. This is the
 * one rule that does: when the open channel becomes one that is not a DM while
 * DM mode is on, DM mode ends.
 */
import type { Disposable } from "@lib/disposable";
import { channelsStore } from "@stores/channels.store";
import { setSidebarMode, uiStore } from "@stores/ui.store";

/**
 * Subscribes to the open channel on `owner`. When it changes to a channel that
 * exists and is not a DM (a group DM is one) while DM mode is on, the mode goes
 * back to "channels" and `forgetChannel` drops the channel the back path would
 * have returned to: the new channel is already open, so there is nothing to
 * return to. A `null` or unknown id does nothing; the content view handles it.
 */
export function followActiveChannel(owner: Disposable, forgetChannel: () => void): void {
  owner.onStoreChange(
    channelsStore,
    (s) => s.activeChannelId,
    (id: number | null) => {
      if (id === null || uiStore.getState().sidebarMode !== "dms") return;
      const channel = channelsStore.getState().channels.get(id);
      if (channel === undefined || channel.type === "dm") return;
      setSidebarMode("channels");
      forgetChannel();
    },
  );
}
