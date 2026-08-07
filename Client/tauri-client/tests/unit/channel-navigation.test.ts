import { describe, it, expect, beforeEach } from "vitest";
import {
  navigateToChannel,
  findChannelById,
  findChannelByName,
} from "../../src/lib/channel-navigation";
import { channelsStore } from "../../src/stores/channels.store";
import type { Channel } from "../../src/stores/channels.store";
import { dmStore, setDmChannels } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";

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
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...overrides,
  };
}

function makeDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 50,
    recipient: { id: 10, username: "bob", avatar: "", status: "online" },
    participants: [{ id: 10, username: "bob", avatar: "", status: "online" }],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 3,
    mentionCount: 1,
    ...overrides,
  };
}

describe("channel-navigation", () => {
  beforeEach(() => {
    channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
    dmStore.setState(() => ({ channels: [] }));
  });

  describe("navigateToChannel", () => {
    it("activates the channel and clears its channelsStore unread badge", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, makeChannel({ id: 1, unreadCount: 5, mentionCount: 2 }));
        return { ...prev, channels: next };
      });

      navigateToChannel(1);

      expect(channelsStore.getState().activeChannelId).toBe(1);
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
      expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(0);
    });

    it("is a no-op for a channel id the store does not know", () => {
      navigateToChannel(999);
      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    // Regression: a jump (permalink, search, pinned, reply) can land on a
    // `type: "dm"` mirror row synthesized into channelsStore — findChannelById
    // does not filter those out. The DM's real unread badge lives in dmStore,
    // not channelsStore, so clearing only the mirror leaves the DM sidebar
    // row lit while the user is actively reading it.
    it("also clears the dmStore unread/mention badge for a DM channel id", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(50, makeChannel({ id: 50, name: "bob", type: "dm", unreadCount: 3 }));
        return { ...prev, channels: next };
      });
      setDmChannels([makeDm({ channelId: 50, unreadCount: 3, mentionCount: 1 })]);

      navigateToChannel(50);

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.unreadCount).toBe(0);
      expect(dm?.mentionCount).toBe(0);
    });

    it("does not touch dmStore for a non-DM channel id", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, makeChannel({ id: 1 }));
        return { ...prev, channels: next };
      });
      setDmChannels([makeDm({ channelId: 50, unreadCount: 3 })]);

      navigateToChannel(1);

      expect(dmStore.getState().channels.find((c) => c.channelId === 50)?.unreadCount).toBe(3);
    });
  });

  describe("findChannelById", () => {
    it("returns the channel when known", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, makeChannel({ id: 1, name: "general" }));
        return { ...prev, channels: next };
      });
      expect(findChannelById(1)).toEqual({ id: 1, name: "general" });
    });

    it("returns null for an unknown id", () => {
      expect(findChannelById(999)).toBeNull();
    });
  });

  describe("findChannelByName", () => {
    it("resolves case-insensitively", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, makeChannel({ id: 1, name: "General" }));
        return { ...prev, channels: next };
      });
      expect(findChannelByName("general")).toEqual({ id: 1, name: "General" });
    });

    it("excludes DM channels", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(50, makeChannel({ id: 50, name: "bob", type: "dm" }));
        return { ...prev, channels: next };
      });
      expect(findChannelByName("bob")).toBeNull();
    });
  });
});
