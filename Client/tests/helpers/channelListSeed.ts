import { channelsStore, type Channel } from "../../src/stores/channels.store";

/** Replaces the channel store's channels (and active id) with exactly `channels`. */
export function seedChannelList(channels: Channel[], active: number | null = null): void {
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(channels.map((c) => [c.id, c])),
    activeChannelId: active,
    roles: [],
  }));
}
