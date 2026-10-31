import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeChannel } from "../helpers/channelFactory";
import { seedChannelList as seed } from "../helpers/channelListSeed";
import {
  navigateToChannel,
  onChannelReselect,
  findChannelById,
  findChannelByName,
  stepChannel,
} from "../../src/lib/nav/channelNavigation";
import { channelsStore } from "../../src/stores/channels.store";
import type { Channel } from "../../src/stores/channels.store";
import { dmStore, setDmChannels } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { muteChannel, invalidateMuteCache } from "../../src/lib/prefs/channelMutes";
import { setHideMutedChannels } from "../../src/lib/prefs/hideMutedChannels";
import { resetChannelsState } from "../helpers/storeSeeds";

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
    resetChannelsState();
    dmStore.setState(() => ({ channels: [] }));
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels", activeDmUserId: null }));
  });

  describe("navigateToChannel", () => {
    it("tells reselect listeners when the channel is already open, and only then", () => {
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([
          [1, makeChannel()],
          [2, makeChannel({ id: 2, name: "random" })],
        ]),
        activeChannelId: 1,
      }));
      const seen = vi.fn();
      const off = onChannelReselect(seen);

      navigateToChannel(2);
      expect(seen).not.toHaveBeenCalled();
      navigateToChannel(2);
      expect(seen).toHaveBeenCalledWith(2);

      off();
      navigateToChannel(2);
      expect(seen).toHaveBeenCalledTimes(1);
    });

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

    it("the unread step reaches into a collapsed category; the plain step does not", () => {
      seed([
        makeChannel({ id: 1, name: "a", position: 0, category: "Open" }),
        makeChannel({ id: 2, name: "b", position: 0, category: "Shut", unreadCount: 2 }),
        makeChannel({ id: 3, name: "c", position: 1, category: "Shut" }),
      ]);
      uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(["Shut"]) }));

      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);
      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBe(2);
    });

    describe("muted channels", () => {
      beforeEach(() => {
        localStorage.clear();
        invalidateMuteCache();
      });

      it("the unread step skips a muted channel without a mention", () => {
        seed([
          makeChannel({ id: 1, name: "a", position: 0, unreadCount: 3 }),
          makeChannel({ id: 2, name: "b", position: 1, unreadCount: 1 }),
        ]);
        muteChannel(1);
        stepChannel(1, true);
        expect(channelsStore.getState().activeChannelId).toBe(2);
        // Nothing else is a stop: the muted one is passed over, not revisited.
        stepChannel(1, true);
        expect(channelsStore.getState().activeChannelId).toBe(2);
      });

      it("the unread step starts from a muted active channel", () => {
        seed([
          makeChannel({ id: 1, name: "a", position: 0, unreadCount: 1 }),
          makeChannel({ id: 2, name: "m", position: 1, unreadCount: 2 }),
          makeChannel({ id: 3, name: "b", position: 2, unreadCount: 1 }),
        ]);
        muteChannel(2);
        channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
        stepChannel(1, true);
        expect(channelsStore.getState().activeChannelId).toBe(3);
      });

      it("a muted channel with a mention still counts", () => {
        seed([
          makeChannel({ id: 1, name: "a", position: 0, unreadCount: 3, mentionCount: 1 }),
          makeChannel({ id: 2, name: "b", position: 1 }),
        ]);
        muteChannel(1);
        stepChannel(1, true);
        expect(channelsStore.getState().activeChannelId).toBe(1);
      });
    });

    it("is a no-op when nothing is unread", () => {
      seed([
        makeChannel({ id: 1, name: "a", position: 0 }),
        makeChannel({ id: 2, name: "b", position: 1 }),
      ]);
      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it("skips voice channels, which only open by joining the call", () => {
      seed(
        [
          makeChannel({ id: 1, name: "a", position: 0 }),
          makeChannel({ id: 2, name: "lounge", position: 1, type: "voice", unreadCount: 1 }),
          makeChannel({ id: 3, name: "c", position: 2 }),
        ],
        1,
      );

      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(3);
      stepChannel(-1);
      expect(channelsStore.getState().activeChannelId).toBe(1);
      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBe(1);
    });

    describe("Hide Muted Channels", () => {
      const three = (): Channel[] => [
        makeChannel({ id: 1, name: "a", position: 0 }),
        makeChannel({ id: 2, name: "b", position: 1 }),
        makeChannel({ id: 3, name: "c", position: 2 }),
      ];
      const active = (): number | null => channelsStore.getState().activeChannelId;

      beforeEach(() => {
        localStorage.clear();
        invalidateMuteCache();
        voiceStore.setState((prev) => ({ ...prev, currentChannelId: null, voiceUsers: new Map() }));
      });

      afterEach(() => {
        localStorage.clear();
        invalidateMuteCache();
      });

      it("Alt+Arrow skips a muted channel while the preference is on, both ways", () => {
        seed(three(), 1);
        muteChannel(2);
        setHideMutedChannels(true);

        stepChannel(1);
        expect(active()).toBe(3);
        stepChannel(-1);
        expect(active()).toBe(1);
      });

      it("steps through a muted channel while the preference is off", () => {
        seed(three(), 1);
        muteChannel(2);

        stepChannel(1);
        expect(active()).toBe(2);
      });

      it("the unread step skips a muted unread channel but reaches a muted mention", () => {
        seed(
          [
            makeChannel({ id: 1, name: "a", position: 0 }),
            makeChannel({ id: 2, name: "b", position: 1, unreadCount: 4 }),
            makeChannel({ id: 3, name: "c", position: 2, unreadCount: 2, mentionCount: 1 }),
          ],
          1,
        );
        muteChannel(2);
        muteChannel(3);
        setHideMutedChannels(true);

        stepChannel(1, true);
        expect(active()).toBe(3);
      });

      it("a muted active channel still steps onward from where it is", () => {
        seed(three(), 2);
        muteChannel(2);
        setHideMutedChannels(true);

        stepChannel(1);
        expect(active()).toBe(3);
        stepChannel(-1);
        expect(active()).toBe(1);
      });

      it("is a no-op when every channel is hidden and none is active", () => {
        seed(three());
        for (const id of [1, 2, 3]) muteChannel(id);
        setHideMutedChannels(true);

        stepChannel(1);
        expect(active()).toBeNull();
      });
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

      // getChannelsByCategory orders categories by their first channel's position.
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(2);
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);
    });

    it("steps through the DM list in recency order while the DM view is open", () => {
      seed([makeChannel({ id: 1, name: "general", position: 0 })]);
      setDmChannels([
        makeDm({ channelId: 60, unreadCount: 0, mentionCount: 0 }),
        makeDm({
          channelId: 61,
          isGroup: true,
          unreadCount: 2,
          mentionCount: 0,
          recipient: { id: 11, username: "cat", avatar: "", status: "online" },
        }),
        makeDm({
          channelId: 62,
          unreadCount: 0,
          mentionCount: 0,
          recipient: { id: 12, username: "dan", avatar: "", status: "online" },
        }),
      ]);
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      // Only the unread group is a stop for the unread step; opening it reads it.
      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBe(61);
      expect(dmStore.getState().channels.find((c) => c.channelId === 61)?.unreadCount).toBe(0);

      stepChannel(-1);
      expect(channelsStore.getState().activeChannelId).toBe(60);
      expect(uiStore.getState().activeDmUserId).toBe(10);
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(61);
      expect(uiStore.getState().activeDmUserId).toBeNull();
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(62);
      // Wraps within the DM list; never lands on the server channel.
      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(60);
      stepChannel(-1);
      expect(channelsStore.getState().activeChannelId).toBe(62);

      expect(uiStore.getState().sidebarMode).toBe("dms");
    });

    it("steps server channels, not DMs, in channels mode", () => {
      seed([
        makeChannel({ id: 1, name: "a", position: 0 }),
        makeChannel({ id: 2, name: "b", position: 1 }),
      ]);
      setDmChannels([makeDm({ channelId: 60 })]);

      stepChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);
      stepChannel(1, true);
      expect(channelsStore.getState().activeChannelId).toBe(1);
    });
  });
});
