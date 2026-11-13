/**
 * The channel a side panel (pins, threads, media) was opened for. The panel
 * lives only while that channel is the active one, still exists for the
 * viewer and is not behind the NSFW gate: anything else closes it, so it never
 * shows one channel's content over another.
 */

import type { Disposable } from "@lib/disposable";
import { channelsStore, type ChannelsState } from "@stores/channels.store";
import { nsfwContentBlocked } from "../content-consent/nsfw";

function panelChannelLive(s: ChannelsState, channelId: number): boolean {
  return (
    s.activeChannelId === channelId && s.channels.has(channelId) && !nsfwContentBlocked(channelId)
  );
}

/** Whether a load for a panel opened for `openedFor` landed too late to show:
 *  the viewer moved to another channel, or this one became gated, meanwhile. */
export function sidePanelStale(openedFor: number | null, current: number | null): boolean {
  return openedFor === null || openedFor !== current || nsfwContentBlocked(openedFor);
}

/** Close the panel when its channel is left, deleted, unreadable or gated. */
export function closeWhenChannelLeft(live: Disposable, channelId: number, close: () => void): void {
  live.onStoreChange(
    channelsStore,
    (s) => panelChannelLive(s, channelId),
    (stillOpen) => {
      if (!stillOpen) close();
    },
  );
}
