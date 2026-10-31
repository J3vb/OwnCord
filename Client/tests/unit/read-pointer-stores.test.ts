/** The read pointer in the channel and DM stores (WP 3D-5d). */
import { describe, it, expect, beforeEach } from "vitest";

import {
  channelsStore,
  getPointerOnOpen,
  setActiveChannel,
  setChannels,
  setReadPointer,
} from "@stores/channels.store";
import {
  addDmChannel,
  addDmToChannelsStore,
  dmChannelFromPayload,
  dmStore,
  setDmChannels,
  setDmReadPointer,
} from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { applyReadyDms } from "../../src/features/direct-messages/wsHandlers";
import type { DmChannelPayload, ReadyChannel } from "@lib/types";
import { resetChannelsState } from "../helpers/storeSeeds";

const ch = (id: number, pointer?: number): ReadyChannel => ({
  id,
  name: `c${id}`,
  type: "text",
  category: null,
  position: id,
  unread_count: 3,
  mention_count: 1,
  ...(pointer !== undefined ? { last_read_message_id: pointer } : {}),
});

const dm = (over: Partial<DmChannel> = {}): DmChannel => ({
  channelId: 50,
  recipient: { id: 7, username: "bob", avatar: "", status: "online" },
  participants: [],
  name: "",
  isGroup: false,
  lastMessageId: 30,
  lastReadMessageId: 10,
  lastMessage: "",
  lastMessageAt: "",
  unreadCount: 2,
  mentionCount: 1,
  ...over,
});

beforeEach(() => {
  resetChannelsState();
  dmStore.setState(() => ({ channels: [] }));
});

describe("channels store", () => {
  it("keeps the pointer ready sent, and undefined when it sent none", () => {
    setChannels([ch(1, 5), ch(2)]);
    expect(channelsStore.getState().channels.get(1)?.lastReadMessageId).toBe(5);
    expect(channelsStore.getState().channels.get(2)?.lastReadMessageId).toBeUndefined();
  });

  it("snapshots the pointer when a channel is opened, and not again until the next open", () => {
    setChannels([ch(1, 5)]);
    setActiveChannel(1);
    setReadPointer(1, 9);
    expect(getPointerOnOpen(1)).toBe(5);
    setActiveChannel(null);
    setActiveChannel(1);
    expect(getPointerOnOpen(1)).toBe(9);
  });

  it("forgets the snapshot when a new ready restates the channels", () => {
    setChannels([ch(1, 5)]);
    setActiveChannel(1);
    setChannels([ch(1, 6)]);
    expect(getPointerOnOpen(1)).toBeUndefined();
  });

  it("sets the pointer outright, back as well as forward", () => {
    setChannels([ch(1, 10)]);
    setReadPointer(1, 12);
    expect(channelsStore.getState().channels.get(1)?.lastReadMessageId).toBe(12);
    setReadPointer(1, 4);
    expect(channelsStore.getState().channels.get(1)?.lastReadMessageId).toBe(4);
  });

  it("sets both counts outright with the pointer, and leaves them alone without", () => {
    setChannels([ch(1, 10)]);
    setReadPointer(1, 12);
    expect(channelsStore.getState().channels.get(1)).toMatchObject({
      unreadCount: 3,
      mentionCount: 1,
    });
    setReadPointer(1, 12, { unread: 0, mention: 0 });
    expect(channelsStore.getState().channels.get(1)).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
  });

  it("is a no-op for a channel it does not know", () => {
    setChannels([ch(1, 10)]);
    setReadPointer(99, 12);
    expect([...channelsStore.getState().channels.keys()]).toEqual([1]);
  });
});

describe("DM store", () => {
  it("maps the pointer from a payload, and leaves it undefined when absent", () => {
    const base: DmChannelPayload = {
      channel_id: 50,
      recipient: { id: 7, username: "bob", avatar: "", status: "online" },
      last_message_id: 30,
      last_message: "",
      last_message_at: "",
      unread_count: 2,
    };
    expect(dmChannelFromPayload({ ...base, last_read_message_id: 10 }).lastReadMessageId).toBe(10);
    expect(dmChannelFromPayload(base).lastReadMessageId).toBeUndefined();
  });

  it("keeps its pointer across a dm_channel_open that carries none", () => {
    setDmChannels([dm()]);
    addDmChannel(dm({ lastReadMessageId: undefined }));
    expect(dmStore.getState().channels[0]?.lastReadMessageId).toBe(10);
  });

  it("copies the pointer into the channels-store mirror row", () => {
    addDmToChannelsStore(dm());
    expect(channelsStore.getState().channels.get(50)?.lastReadMessageId).toBe(10);
  });

  it("a ready restates the mirror row's pointer too", () => {
    setDmChannels([dm()]);
    addDmToChannelsStore(dm());
    applyReadyDms({
      channels: [],
      members: [],
      voice_states: [],
      roles: [],
      dm_channels: [
        {
          channel_id: 50,
          recipient: { id: 7, username: "bob", avatar: "", status: "online" },
          last_message_id: 30,
          last_message: "",
          last_message_at: "",
          unread_count: 2,
          mention_count: 1,
          last_read_message_id: 22,
        },
      ],
    });
    expect(dmStore.getState().channels[0]?.lastReadMessageId).toBe(22);
    expect(channelsStore.getState().channels.get(50)?.lastReadMessageId).toBe(22);
  });

  it("sets the pointer and counts outright", () => {
    setDmChannels([dm()]);
    setDmReadPointer(50, 4, { unread: 0, mention: 0 });
    expect(dmStore.getState().channels[0]).toMatchObject({
      lastReadMessageId: 4,
      unreadCount: 0,
      mentionCount: 0,
    });
  });
});
