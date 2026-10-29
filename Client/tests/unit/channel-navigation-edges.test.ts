import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findChannelById,
  navigateToChannel,
  onChannelReselect,
  stepChannel,
} from "../../src/lib/channel-navigation";
import { channelsStore } from "../../src/stores/channels.store";
import type { Channel } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    name: "general",
    type: "text",
    category: null,
    position: 0,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    topic: "",
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...overrides,
  };
}

function makeDm(channelId: number, name: string): DmChannel {
  return {
    channelId,
    recipient: { id: channelId, username: name, avatar: "", status: "online" },
    participants: [{ id: channelId, username: name, avatar: "", status: "online" }],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

function seed(channels: Channel[], active: number | null = null): void {
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(channels.map((c) => [c.id, c])),
    activeChannelId: active,
    roles: [],
  }));
}

const three = () =>
  seed(
    [
      makeChannel({ id: 1, name: "a", position: 0 }),
      makeChannel({ id: 2, name: "b", position: 1 }),
      makeChannel({ id: 3, name: "c", position: 2 }),
      makeChannel({ id: 4, name: "call", position: 3, type: "voice" }),
    ],
    2,
  );

const active = (): number | null => channelsStore.getState().activeChannelId;

beforeEach(() => {
  seed([]);
  dmStore.setState(() => ({ channels: [] }));
  uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels", activeDmUserId: null }));
});

describe("navigateToChannel and findChannelById with several DMs", () => {
  it("opens the DM with the id asked for, not the first one", () => {
    dmStore.setState(() => ({ channels: [makeDm(50, "bob"), makeDm(51, "cy")] }));
    navigateToChannel(51);
    expect(active()).toBe(51);
    expect(channelsStore.getState().channels.has(51)).toBe(true);
    expect(channelsStore.getState().channels.has(50)).toBe(false);
  });

  it("describes a server channel as such, and a mirrored DM as a DM", () => {
    seed([
      makeChannel({ id: 1, name: "general" }),
      makeChannel({ id: 2, name: "bob", type: "dm" }),
    ]);
    dmStore.setState(() => ({ channels: [makeDm(50, "cy")] }));
    expect(findChannelById(1)).toEqual({ id: 1, name: "general", isDm: false });
    expect(findChannelById(2)).toEqual({ id: 2, name: "bob", isDm: true });
    expect(findChannelById(50)).toMatchObject({ id: 50, isDm: true });
    expect(findChannelById(3)).toBeNull();
  });
});

describe("stepChannel from where you are", () => {
  it("steps from the active channel in the middle of the list, both ways", () => {
    three();
    stepChannel(1);
    expect(active()).toBe(3);
    three();
    stepChannel(-1);
    expect(active()).toBe(1);
  });

  it("steps from the edge when the active channel is not in the list", () => {
    three();
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 4 }));
    stepChannel(-1);
    expect(active()).toBe(3);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 4 }));
    stepChannel(1);
    expect(active()).toBe(1);
  });

  it("does not move to the channel you are on when it is the only unread one", () => {
    seed(
      [
        makeChannel({ id: 1, name: "a", position: 0 }),
        makeChannel({ id: 2, name: "b", position: 1, unreadCount: 4 }),
        makeChannel({ id: 3, name: "c", position: 2 }),
      ],
      2,
    );
    const reselect = vi.fn();
    const off = onChannelReselect(reselect);
    stepChannel(1, true);
    stepChannel(-1, true);
    off();
    expect(active()).toBe(2);
    expect(reselect).not.toHaveBeenCalled();
    expect(channelsStore.getState().channels.get(2)?.unreadCount).toBe(4);
  });
});
