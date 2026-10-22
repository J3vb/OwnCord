import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyReadyBlocks, applyReadyDms, handleDmChannelOpen } from "./wsHandlers";
import { dmStore, dmChannelFromPayload } from "../../stores/dm.store";
import { channelsStore, resetChannelsStore } from "../../stores/channels.store";
import type { Channel } from "../../stores/channels.store";
import { blocksStore, resetBlocksStore, setUserBlockedByThem } from "../../stores/blocks.store";
import type { Payload } from "../connection/dispatchContext";

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
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
  };
}

function ready(dmChannels: Payload<"ready">["dm_channels"]): Payload<"ready"> {
  return { dm_channels: dmChannels } as Payload<"ready">;
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

describe("group owner_id (WP 3B-11a)", () => {
  const carol = { id: 8, username: "carol", avatar: "", status: "online" };
  const dave = { id: 9, username: "dave", avatar: "", status: "offline" };
  const group = (over: Record<string, unknown> = {}): Payload<"dm_channel_open"> => ({
    channel_id: 6,
    recipient,
    recipients: [recipient, carol],
    name: "Crew",
    is_group: true,
    last_message_id: null,
    last_message: "",
    last_message_at: "",
    unread_count: 0,
    ...over,
  });

  it("maps owner_id to ownerId on dm_channel_open and on ready", () => {
    handleDmChannelOpen(group({ owner_id: 8 }));
    expect(dmStore.getState().channels[0]?.ownerId).toBe(8);

    dmStore.setState(() => ({ channels: [] }));
    applyReadyDms(ready([group({ owner_id: 7 })] as Payload<"ready">["dm_channels"]));
    expect(dmStore.getState().channels[0]?.ownerId).toBe(7);
  });

  it("leaves ownerId unset for a server without it, and for a 1:1", () => {
    handleDmChannelOpen(group());
    expect("ownerId" in dmStore.getState().channels[0]!).toBe(false);
    handleDmChannelOpen(group({ channel_id: 7, is_group: false, recipients: [recipient] }));
    expect("ownerId" in dmStore.getState().channels[0]!).toBe(false);
  });

  it("dmChannelFromPayload (the REST mapper) maps it the same way", () => {
    expect(dmChannelFromPayload(group({ owner_id: 8 })).ownerId).toBe(8);
    expect("ownerId" in dmChannelFromPayload(group())).toBe(false);
  });

  it("a later dm_channel_open replaces the participants and the owner", () => {
    handleDmChannelOpen(group({ owner_id: 7 }));
    handleDmChannelOpen(group({ recipients: [recipient, dave], owner_id: 9 }));

    const [only, ...rest] = dmStore.getState().channels;
    expect(rest).toEqual([]);
    expect(only?.participants.map((p) => p.id)).toEqual([7, 9]);
    expect(only?.ownerId).toBe(9);
  });

  it("maps icon in both mappers, keeping an empty string", () => {
    handleDmChannelOpen(group({ owner_id: 7, icon: "/api/v1/files/3" }));
    expect(dmStore.getState().channels[0]?.icon).toBe("/api/v1/files/3");
    expect(dmChannelFromPayload(group({ icon: "/api/v1/files/4" })).icon).toBe("/api/v1/files/4");
    expect(dmChannelFromPayload(group({ icon: "" })).icon).toBe("");
    expect("icon" in dmChannelFromPayload(group())).toBe(false);
  });

  it("a newer summary replaces the icon, including back to none", () => {
    handleDmChannelOpen(group({ owner_id: 7, icon: "/api/v1/files/3" }));
    handleDmChannelOpen(group({ owner_id: 7, icon: "/api/v1/files/5" }));
    expect(dmStore.getState().channels[0]?.icon).toBe("/api/v1/files/5");
    handleDmChannelOpen(group({ owner_id: 7, icon: "" }));
    expect(dmStore.getState().channels[0]?.icon).toBe("");
    applyReadyDms(ready([group({ owner_id: 7, icon: "/api/v1/files/6" })] as never));
    expect(dmStore.getState().channels[0]?.icon).toBe("/api/v1/files/6");
  });

  it("a later dm_channel_open without owner_id drops a stale owner", () => {
    handleDmChannelOpen(group({ owner_id: 7 }));
    handleDmChannelOpen(group());
    expect("ownerId" in dmStore.getState().channels[0]!).toBe(false);
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

    applyReadyBlocks(undefined);

    expect(blocksStore.getState().blockedByThem.size).toBe(0);
  });

  it("applies the fetched block list", async () => {
    const listBlocks = vi.fn(async () => ({ blocked_user_ids: [3, 4] }));

    applyReadyBlocks({ listBlocks });
    await vi.waitFor(() => expect(blocksStore.getState().blockedByMe).toEqual(new Set([3, 4])));
  });
});
