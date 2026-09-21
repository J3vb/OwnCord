import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyReadyBlocks, applyReadyDms, handleDmChannelOpen } from "./wsHandlers";
import { dmStore } from "../../stores/dm.store";
import { channelsStore, resetChannelsStore } from "../../stores/channels.store";
import type { Channel } from "../../stores/channels.store";
import { blocksStore, resetBlocksStore, setUserBlockedByThem } from "../../stores/blocks.store";
import type { DispatchContext, Payload } from "../connection/dispatchContext";
import { createReconnectClock } from "../connection/dispatchContext";

vi.spyOn(console, "info").mockImplementation(() => {});

const recipient = { id: 7, username: "bob", avatar: "a.png", status: "online" };

function dmRow(id: number, unreadCount: number, mentionCount: number): Channel {
  return {
    id,
    name: "bob",
    type: "dm",
    category: null,
    topic: "",
    position: 0,
    unreadCount,
    mentionCount,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    nsfw: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
  };
}

function ready(dmChannels: Payload<"ready">["dm_channels"]): Payload<"ready"> {
  return { dm_channels: dmChannels } as Payload<"ready">;
}

function ctxWith(api: DispatchContext["api"]): DispatchContext {
  return { ws: { send: vi.fn(), disconnect: vi.fn() }, api, clock: createReconnectClock() };
}

beforeEach(() => {
  dmStore.setState(() => ({ channels: [] }));
  resetChannelsStore();
  resetBlocksStore();
});

describe("handleDmChannelOpen", () => {
  it("maps a pre-group payload's lone recipient to a one-element participant list", () => {
    handleDmChannelOpen({
      channel_id: 5,
      recipient,
      last_message_id: null,
      last_message: "",
      last_message_at: "",
      unread_count: 2,
    });

    expect(dmStore.getState().channels).toEqual([
      {
        channelId: 5,
        recipient: { ...recipient, displayName: "" },
        participants: [{ ...recipient, displayName: "" }],
        name: "",
        isGroup: false,
        lastMessageId: null,
        lastMessage: "",
        lastMessageAt: "",
        unreadCount: 2,
        mentionCount: 0,
      },
    ]);
  });
});

describe("applyReadyDms", () => {
  it("drops mirror rows for DMs the payload no longer has and restates the counts", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([
        [1, dmRow(1, 0, 0)],
        [2, dmRow(2, 0, 0)],
      ]),
    }));

    applyReadyDms(
      ready([
        {
          channel_id: 1,
          recipient,
          last_message_id: null,
          last_message: "",
          last_message_at: "",
          unread_count: 4,
          mention_count: 1,
        },
      ]),
    );

    const rows = channelsStore.getState().channels;
    expect([...rows.keys()]).toEqual([1]);
    expect(rows.get(1)).toMatchObject({ unreadCount: 4, mentionCount: 1 });
    expect(dmStore.getState().channels.map((dm) => dm.channelId)).toEqual([1]);
  });

  it("keeps the channels state identity when every mirror row already agrees", () => {
    channelsStore.setState((prev) => ({ ...prev, channels: new Map([[1, dmRow(1, 3, 0)]]) }));
    const before = channelsStore.getState();

    applyReadyDms(
      ready([
        {
          channel_id: 1,
          recipient,
          last_message_id: null,
          last_message: "",
          last_message_at: "",
          unread_count: 3,
        },
      ]),
    );

    expect(channelsStore.getState()).toBe(before);
  });

  it("treats a missing dm_channels field as no open DMs", () => {
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 9,
          recipient: { ...recipient, displayName: "" },
          participants: [],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));

    applyReadyDms(ready(undefined));

    expect(dmStore.getState().channels).toEqual([]);
  });
});

describe("applyReadyBlocks", () => {
  it("clears blocked-by-them even without an api", () => {
    setUserBlockedByThem(7, true);

    applyReadyBlocks(ctxWith(undefined));

    expect(blocksStore.getState().blockedByThem.size).toBe(0);
  });

  it("applies the fetched block list", async () => {
    const listBlocks = vi.fn(async () => ({ blocked_user_ids: [3, 4] }));

    applyReadyBlocks(ctxWith({ listBlocks }));
    await vi.waitFor(() => expect(blocksStore.getState().blockedByMe).toEqual(new Set([3, 4])));
  });
});
