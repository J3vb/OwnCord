/**
 * Phase B Step 6 — second Solid.js leaf component.
 *
 * Renders a single row in the channel list. Reads from the existing
 * `channelsStore` via the Solid adapter so it stays in sync with whatever
 * the vanilla dispatcher writes into the store.
 *
 * This is the canonical example for migrating list-item components: pure
 * presentation, fed by an accessor, with a click handler delegated up to the
 * parent so the component knows nothing about the dispatcher.
 */

import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { fromStoreSlice } from "@lib/solidAdapter";
import { channelsStore, type Channel, type ChannelsState } from "@stores/channels.store";
import { Badge } from "./Badge";

export interface ChannelListItemProps {
  channelId: number;
  onSelect: (id: number) => void;
}

export function ChannelListItem(props: ChannelListItemProps): JSX.Element {
  // Subscribe to just this row's channel object so unrelated changes don't
  // re-render. Falsy → row is hidden until the channel arrives.
  const channel = fromStoreSlice<ChannelsState, Channel | undefined>(
    channelsStore,
    (s) => s.channels.get(props.channelId),
  );
  const isActive = fromStoreSlice<ChannelsState, boolean>(
    channelsStore,
    (s) => s.activeChannelId === props.channelId,
  );

  return (
    <Show when={channel()}>
      {(ch) => (
        <li
          class={"channel-list-item" + (isActive() ? " channel-list-item--active" : "")}
          onClick={() => props.onSelect(props.channelId)}
        >
          <span class="channel-list-item__hash">#</span>
          <span class="channel-list-item__name">{ch().name}</span>
          <Show when={ch().unreadCount > 0}>
            <Badge label={String(ch().unreadCount)} variant="dnd" />
          </Show>
        </li>
      )}
    </Show>
  );
}
