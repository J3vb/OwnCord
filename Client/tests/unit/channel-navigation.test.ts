import { describe, it, expect, beforeEach } from "vitest";
import {
  navigateToChannel,
  findChannelById,
  findChannelByName,
  stepChannel,
} from "../../src/lib/channel-navigation";
import { channelsStore } from "../../src/stores/channels.store";
import type { Channel } from "../../src/stores/channels.store";
import { dmStore, setDmChannels } from "../../src/stores/dm.store";
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

    // OC-0121: a DM present in dmStore from `ready` but never opened this
    // session (so never selected via selectDmConversation) has no mirror row
    // in channelsStore yet. A jump affordance (permalink, search hit, pinned,
    // reply) must still be able to activate it instead of silently no-op'ing.
    it("activates a DM known only to dmStore by synthesizing its channelsStore mirror", () => {
      setDmChannels([
        makeDm({
          channelId: 50,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          unreadCount: 3,
          mentionCount: 1,
        }),
      ]);

      navigateToChannel(50);

      expect(channelsStore.getState().activeChannelId).toBe(50);
      expect(channelsStore.getState().channels.get(50)?.name).toBe("bob");
      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.unreadCount).toBe(0);
      expect(dm?.mentionCount).toBe(0);
    });
  });

  describe("findChannelById", () => {
    it("returns the channel when known", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, makeChannel({ id: 1, name: "general" }));
        return { ...prev, channels: next };
      });
      expect(findChannelById(1)).toEqual({ id: 1, name: "general", isDm: false });
    });

    it("returns null for an unknown id", () => {
      expect(findChannelById(999)).toBeNull();
    });

    // OC-0121: findChannelById gated on channelsStore alone, so a DM whose
    // mirror row has not been synthesized yet (never opened this session)
    // read as "not visible" even though the user is a member — the first
    // check in MessageJump.jumpTo rejects it before getMessagesAround is
    // ever called.
    it("resolves a DM known only to dmStore, not yet mirrored into channelsStore", () => {
      setDmChannels([
        makeDm({
          channelId: 50,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        }),
      ]);
      expect(findChannelById(50)).toEqual({ id: 50, name: "bob", isDm: true });
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

  describe("stepChannel", () => {
    function seed(channels: Channel[], active: number | null = null): void {
      channelsStore.setState(() => ({
        channels: new Map(channels.map((c) => [c.id, c])),
        activeChannelId: active,
        roles: [],
      }));
    }

    it("steps to the next and previous channel, wrapping at the ends", () => {
      seed([
        makeChannel({ id: 1, name: "a", position: 0 }),
        makeChannel({ id: 2, name: "b", position: 1 }),
        makeChannel({ id: 3, name: "c", position: 2 }),
      ]);

      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(2);
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(3);
      // Down past the last wraps to the first.
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);
      // Up from the first wraps to the last.
      stepChannel(-1);
      expect(channelsStore.getState().activeChannelId).toBe(3);
    });

    it("steps to unread channels only when asked", () => {
      seed([
        makeChannel({ id: 1, name: "a", position: 0, unreadCount: 0 }),
        makeChannel({ id: 2, name: "b", position: 1, unreadCount: 2 }),
        makeChannel({ id: 3, name: "c", position: 2, mentionCount: 1 }),
      ]);

      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBe(2);
      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBe(3);
    });

    it("is a no-op when nothing is unread", () => {
      seed([
        makeChannel({ id: 1, name: "a", position: 0 }),
        makeChannel({ id: 2, name: "b", position: 1 }),
      ]);
      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it("is a no-op with no channels", () => {
      seed([]);
      expect(() => stepChannel(1)).not.toThrow();
      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it("steps the plain order by category position, skipping no rows when expanded", () => {
      seed([
        makeChannel({ id: 1, name: "a", position: 1, category: "One" }),
        makeChannel({ id: 2, name: "b", position: 0, category: "Two" }),
      ]);

      // getChannelsByCategory groups by category insertion order, then position.
      stepChannel(1);
      expect([1, 2]).toContain(channelsStore.getState().activeChannelId);
    });
  });
});
