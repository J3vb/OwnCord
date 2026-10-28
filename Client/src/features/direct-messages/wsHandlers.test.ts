import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyReadyBlocks,
  applyReadyDms,
  handleDmChannelClose,
  handleDmChannelOpen,
} from "./wsHandlers";
import { dmStore, dmChannelFromPayload } from "../../stores/dm.store";
import { channelsStore, resetChannelsStore } from "../../stores/channels.store";
import type { Channel } from "../../stores/channels.store";
import { blocksStore, resetBlocksStore, setUserBlockedByThem } from "../../stores/blocks.store";
import { resetVoiceStore, voiceStore } from "../../stores/voice.store";
import type { Payload } from "../connection/dispatchContext";
import { expectConsole } from "../../../tests/helpers/console";
import { captureLogs } from "../../../tests/helpers/log-capture";

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
  resetVoiceStore();
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

const groupPayload = (id: number, isGroup = true): Payload<"dm_channel_open"> => ({
  channel_id: id,
  recipient,
  recipients: [recipient],
  name: "Crew",
  is_group: isGroup,
  last_message_id: null,
  last_message: "",
  last_message_at: "",
  unread_count: 0,
});

const renamePayload = (name: string): Payload<"dm_channel_open"> => ({
  channel_id: 1,
  recipient: { ...recipient, username: name },
  last_message_id: null,
  last_message: "",
  last_message_at: "",
  unread_count: 0,
});

function seedRoster(channelId: number): void {
  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: new Map([...prev.voiceUsers, [channelId, new Map()]]),
  }));
}
const hasRoster = (channelId: number): boolean => voiceStore.getState().voiceUsers.has(channelId);

const dmOf = (channelId: number, isGroup: boolean) => ({
  channelId,
  recipient: { ...recipient, displayName: "" },
  participants: [{ ...recipient, displayName: "" }],
  name: "",
  isGroup,
  lastMessageId: null,
  lastMessage: "",
  lastMessageAt: "",
  unreadCount: 0,
  mentionCount: 0,
});

const textChannel = (id: number, position: number, type: Channel["type"] = "text"): Channel => ({
  ...dmRow(id, 0, 0),
  name: `c${String(id)}`,
  type,
  position,
});

const readyDmWith = (over: Record<string, unknown>) =>
  ready([
    {
      channel_id: 1,
      recipient,
      last_message_id: null,
      last_message: "",
      last_message_at: "",
      unread_count: 0,
      ...over,
    },
  ] as Payload<"ready">["dm_channels"]);

describe("handleDmChannelOpen without an icon", () => {
  it("leaves the icon key off the stored channel", () => {
    handleDmChannelOpen(groupPayload(6));

    expect("icon" in dmStore.getState().channels[0]!).toBe(false);
  });

  it("drops a known icon when a later open carries none", () => {
    handleDmChannelOpen({ ...groupPayload(6), icon: "/api/v1/files/3" });

    handleDmChannelOpen(groupPayload(6));

    expect("icon" in dmStore.getState().channels[0]!).toBe(false);
  });
});

describe("handleDmChannelOpen and the channels-store mirror row", () => {
  it("renames the mirror row when the DM's display name changes", () => {
    channelsStore.setState((prev) => ({ ...prev, channels: new Map([[1, dmRow(1, 0, 0)]]) }));

    handleDmChannelOpen(renamePayload("robert"));

    expect(channelsStore.getState().channels.get(1)?.name).toBe("robert");
  });

  it("leaves the channels state untouched when the name already matches", () => {
    channelsStore.setState((prev) => ({ ...prev, channels: new Map([[1, dmRow(1, 0, 0)]]) }));
    const before = channelsStore.getState();

    handleDmChannelOpen(renamePayload("bob"));

    expect(channelsStore.getState()).toBe(before);
  });

  it("creates no mirror row for a DM without one", () => {
    handleDmChannelOpen(renamePayload("bob"));

    expect(channelsStore.getState().channels.has(1)).toBe(false);
  });
});

describe("group call rosters on dm_channel_open", () => {
  it("drops a stale roster when a group is added that this client did not list", () => {
    handleDmChannelOpen(groupPayload(99));
    seedRoster(5);

    handleDmChannelOpen(groupPayload(5));

    expect(hasRoster(5)).toBe(false);
  });

  it("keeps the roster of a group this client already lists", () => {
    handleDmChannelOpen(groupPayload(5));
    seedRoster(5);

    handleDmChannelOpen(groupPayload(5));

    expect(hasRoster(5)).toBe(true);
  });

  it("keeps the roster of a one-to-one DM that is newly opened", () => {
    seedRoster(5);

    handleDmChannelOpen(groupPayload(5, false));

    expect(hasRoster(5)).toBe(true);
  });
});

describe("handleDmChannelClose", () => {
  it("drops the call roster of a closed group, whichever position it holds", () => {
    dmStore.setState(() => ({ channels: [dmOf(1, false), dmOf(2, true)] }));
    seedRoster(2);

    handleDmChannelClose({ channel_id: 2 });

    expect(hasRoster(2)).toBe(false);
    expect(dmStore.getState().channels.map((c) => c.channelId)).toEqual([1]);
  });

  it("keeps the call roster of a closed one-to-one even when another DM is a group", () => {
    dmStore.setState(() => ({ channels: [dmOf(1, true), dmOf(2, false)] }));
    seedRoster(2);

    handleDmChannelClose({ channel_id: 2 });

    expect(hasRoster(2)).toBe(true);
  });

  it("activates the first remaining DM when the active one is closed elsewhere", () => {
    dmStore.setState(() => ({ channels: [dmOf(1, false), dmOf(2, false)] }));
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));

    handleDmChannelClose({ channel_id: 2 });

    expect(channelsStore.getState().activeChannelId).toBe(1);
    expect(channelsStore.getState().channels.has(1)).toBe(true);
  });

  it("falls back to the first text channel by position, skipping other channel types", () => {
    dmStore.setState(() => ({ channels: [dmOf(2, false)] }));
    channelsStore.setState((prev) => ({
      ...prev,
      activeChannelId: 2,
      channels: new Map([
        [10, textChannel(10, 5)],
        [11, textChannel(11, 0, "voice")],
        [12, textChannel(12, 1)],
        [13, textChannel(13, 3)],
      ]),
    }));

    handleDmChannelClose({ channel_id: 2 });

    expect(channelsStore.getState().activeChannelId).toBe(12);
  });

  it("clears the active channel when nothing is left to show", () => {
    dmStore.setState(() => ({ channels: [dmOf(2, false)] }));
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));

    handleDmChannelClose({ channel_id: 2 });

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("leaves the active channel alone when another channel is closed", () => {
    dmStore.setState(() => ({ channels: [dmOf(1, false), dmOf(2, false)] }));
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));

    handleDmChannelClose({ channel_id: 2 });

    expect(channelsStore.getState().activeChannelId).toBe(7);
  });
});

describe("applyReadyDms counts", () => {
  it("updates a mirror row whose unread count alone differs", () => {
    channelsStore.setState((prev) => ({ ...prev, channels: new Map([[1, dmRow(1, 5, 0)]]) }));

    applyReadyDms(readyDmWith({ unread_count: 0 }));

    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
  });

  it("updates a mirror row whose mention count alone differs", () => {
    channelsStore.setState((prev) => ({ ...prev, channels: new Map([[1, dmRow(1, 0, 2)]]) }));

    applyReadyDms(readyDmWith({ mention_count: 0 }));

    expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(0);
  });

  it("updates a mirror row whose read pointer alone differs", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[1, { ...dmRow(1, 0, 0), lastReadMessageId: 3 }]]),
    }));

    applyReadyDms(readyDmWith({ last_read_message_id: 9 }));

    expect(channelsStore.getState().channels.get(1)?.lastReadMessageId).toBe(9);
  });
});

describe("applyReadyBlocks when the block list cannot be loaded", () => {
  it("logs the failure and keeps the existing block set", async () => {
    const listBlocks = vi.fn(async () => {
      throw new Error("offline");
    });

    applyReadyBlocks({ listBlocks });

    await vi.waitFor(() => expectConsole("warn", /Failed to load block list/));
    expect(blocksStore.getState().blockedByMe.size).toBe(0);
  });
});

describe("DM handler log lines", () => {
  it("names the cause when the block list cannot be loaded", async () => {
    const logs = captureLogs();
    applyReadyBlocks({
      listBlocks: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    await vi.waitFor(() => expect(logs.find("Failed to load block list")).toHaveLength(1));
    expectConsole("warn", /Failed to load block list/);
    expect(logs.find("Failed to load block list")[0]?.data).toEqual({
      error: "Error: offline",
    });
  });

  it("records the channel that was opened", () => {
    const logs = captureLogs();

    handleDmChannelOpen(groupPayload(6));

    expect(logs.find("DM channel opened")).toMatchObject([
      { level: "info", component: "dispatcher", data: { channelId: 6 } },
    ]);
  });

  it("records the channel that was closed", () => {
    const logs = captureLogs();

    handleDmChannelClose({ channel_id: 6 });

    expect(logs.find("DM channel closed")).toMatchObject([
      { level: "info", component: "dispatcher", data: { channelId: 6 } },
    ]);
  });
});
