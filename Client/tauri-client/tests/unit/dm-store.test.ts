import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  dmStore,
  setDmChannels,
  addDmChannel,
  removeDmChannel,
  closeDmLocally,
  updateDmLastMessage,
  updateDmLastMessagePreview,
  clearDmUnread,
  updateDmParticipant,
} from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { channelsStore } from "../../src/stores/channels.store";
import type { Channel } from "../../src/stores/channels.store";

function makeMirrorChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 5,
    name: "bob",
    type: "dm",
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
    channelId: 100,
    recipient: { id: 1, username: "alice", avatar: "", status: "online" },
    participants: [{ id: 1, username: "alice", avatar: "", status: "online" }],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...overrides,
  };
}

describe("dmStore", () => {
  beforeEach(() => {
    dmStore.setState(() => ({ channels: [] }));
  });

  // ── setDmChannels ──────────────────────────────────────

  describe("setDmChannels", () => {
    it("bulk-sets channels from an array", () => {
      const channels = [makeDm({ channelId: 1 }), makeDm({ channelId: 2 })];
      setDmChannels(channels);
      expect(dmStore.getState().channels).toHaveLength(2);
      expect(dmStore.getState().channels[0]!.channelId).toBe(1);
      expect(dmStore.getState().channels[1]!.channelId).toBe(2);
    });

    it("replaces existing channels entirely", () => {
      setDmChannels([makeDm({ channelId: 1 }), makeDm({ channelId: 2 })]);
      setDmChannels([makeDm({ channelId: 3 })]);
      expect(dmStore.getState().channels).toHaveLength(1);
      expect(dmStore.getState().channels[0]!.channelId).toBe(3);
    });

    it("accepts an empty array to clear all channels", () => {
      setDmChannels([makeDm({ channelId: 1 })]);
      setDmChannels([]);
      expect(dmStore.getState().channels).toHaveLength(0);
    });
  });

  // ── addDmChannel ───────────────────────────────────────

  describe("addDmChannel", () => {
    it("adds a new channel to the front of the list", () => {
      setDmChannels([makeDm({ channelId: 1 })]);
      addDmChannel(makeDm({ channelId: 2 }));
      const channels = dmStore.getState().channels;
      expect(channels).toHaveLength(2);
      expect(channels[0]!.channelId).toBe(2);
      expect(channels[1]!.channelId).toBe(1);
    });

    it("updates an existing channel without creating a duplicate", () => {
      setDmChannels([makeDm({ channelId: 1, lastMessage: "old" }), makeDm({ channelId: 2 })]);
      addDmChannel(makeDm({ channelId: 1, lastMessage: "new" }));
      const channels = dmStore.getState().channels;
      expect(channels).toHaveLength(2);
      // Updated channel moves to front
      expect(channels[0]!.channelId).toBe(1);
      expect(channels[0]!.lastMessage).toBe("new");
    });

    it("moves an updated existing channel to the front", () => {
      setDmChannels([makeDm({ channelId: 1 }), makeDm({ channelId: 2 }), makeDm({ channelId: 3 })]);
      addDmChannel(makeDm({ channelId: 3, lastMessage: "bumped" }));
      const channels = dmStore.getState().channels;
      expect(channels[0]!.channelId).toBe(3);
      expect(channels[0]!.lastMessage).toBe("bumped");
    });
  });

  // ── removeDmChannel ────────────────────────────────────

  describe("removeDmChannel", () => {
    it("removes a channel by ID", () => {
      setDmChannels([makeDm({ channelId: 1 }), makeDm({ channelId: 2 })]);
      removeDmChannel(1);
      const channels = dmStore.getState().channels;
      expect(channels).toHaveLength(1);
      expect(channels[0]!.channelId).toBe(2);
    });

    it("is a no-op for a non-existent channel ID", () => {
      setDmChannels([makeDm({ channelId: 1 })]);
      removeDmChannel(999);
      expect(dmStore.getState().channels).toHaveLength(1);
    });

    it("returns a new array reference (immutability)", () => {
      setDmChannels([makeDm({ channelId: 1 }), makeDm({ channelId: 2 })]);
      const before = dmStore.getState().channels;
      removeDmChannel(1);
      const after = dmStore.getState().channels;
      expect(after).not.toBe(before);
    });
  });

  // ── closeDmLocally ─────────────────────────────────────

  describe("closeDmLocally", () => {
    beforeEach(() => {
      channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
    });

    it("removes the channel and does not run the fallback when it was not active", () => {
      setDmChannels([makeDm({ channelId: 5 }), makeDm({ channelId: 6 })]);
      const fallback = vi.fn();

      closeDmLocally(5, fallback);

      expect(dmStore.getState().channels.map((c) => c.channelId)).toEqual([6]);
      expect(fallback).not.toHaveBeenCalled();
    });

    it("removes the channel and runs the fallback when it was the active channel", () => {
      setDmChannels([makeDm({ channelId: 5 })]);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 5 }));
      const fallback = vi.fn();

      closeDmLocally(5, fallback);

      expect(dmStore.getState().channels).toHaveLength(0);
      expect(fallback).toHaveBeenCalledOnce();
    });

    // Regression: addDmToChannelsStore synthesizes a `type: "dm"` mirror row
    // into channelsStore on selection, which setChannels re-carries across
    // every `ready`. closeDmLocally must remove that mirror too, or its
    // unread count survives the close and keeps "Mark All as Read" lit for a
    // DM that is no longer open anywhere.
    it("also removes the channelsStore mirror row for the closed DM", () => {
      setDmChannels([makeDm({ channelId: 5 })]);
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(5, makeMirrorChannel({ id: 5, unreadCount: 3 }));
        return { ...prev, channels: next };
      });

      closeDmLocally(5, vi.fn());

      expect(channelsStore.getState().channels.has(5)).toBe(false);
    });

    it("clears activeChannelId on the channelsStore mirror when it was active there too", () => {
      setDmChannels([makeDm({ channelId: 5 })]);
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(5, makeMirrorChannel({ id: 5 }));
        return { ...prev, channels: next, activeChannelId: 5 };
      });
      const fallback = vi.fn();

      closeDmLocally(5, fallback);

      expect(channelsStore.getState().activeChannelId).toBeNull();
      expect(fallback).toHaveBeenCalledOnce();
    });

    it("does not touch an unrelated channelsStore mirror row", () => {
      setDmChannels([makeDm({ channelId: 5 }), makeDm({ channelId: 6 })]);
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(5, makeMirrorChannel({ id: 5 }));
        next.set(6, makeMirrorChannel({ id: 6 }));
        return { ...prev, channels: next };
      });

      closeDmLocally(5, vi.fn());

      expect(channelsStore.getState().channels.has(6)).toBe(true);
    });
  });

  // ── updateDmParticipant ─────────────────────────────────

  describe("updateDmParticipant", () => {
    it("patches the recipient's status across matching DM channels", () => {
      setDmChannels([
        makeDm({
          channelId: 5,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 10, username: "bob", avatar: "", status: "online" }],
        }),
      ]);

      updateDmParticipant(10, { status: "dnd" });

      const ch = dmStore.getState().channels[0]!;
      expect(ch.recipient.status).toBe("dnd");
      expect(ch.participants[0]!.status).toBe("dnd");
    });

    it("patches username/avatar/displayName on a profile change", () => {
      setDmChannels([
        makeDm({
          channelId: 5,
          recipient: { id: 10, username: "bob", avatar: "old.png", status: "online" },
          participants: [{ id: 10, username: "bob", avatar: "old.png", status: "online" }],
        }),
      ]);

      updateDmParticipant(10, { username: "bobby", avatar: "new.png", displayName: "Bobby" });

      const ch = dmStore.getState().channels[0]!;
      expect(ch.recipient.username).toBe("bobby");
      expect(ch.recipient.avatar).toBe("new.png");
      expect(ch.recipient.displayName).toBe("Bobby");
    });

    it("updates a non-recipient participant of a group DM", () => {
      setDmChannels([
        makeDm({
          channelId: 5,
          isGroup: true,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          participants: [
            { id: 10, username: "bob", avatar: "", status: "online" },
            { id: 11, username: "carol", avatar: "", status: "online" },
          ],
        }),
      ]);

      updateDmParticipant(11, { status: "idle" });

      const ch = dmStore.getState().channels[0]!;
      expect(ch.recipient.status).toBe("online");
      expect(ch.participants.find((p) => p.id === 11)?.status).toBe("idle");
    });

    it("is a no-op when the user id matches no participant anywhere", () => {
      setDmChannels([makeDm({ channelId: 5 })]);
      const before = dmStore.getState();

      updateDmParticipant(999, { status: "dnd" });

      expect(dmStore.getState()).toBe(before);
    });

    it("does not modify channels the user is not part of", () => {
      setDmChannels([
        makeDm({
          channelId: 5,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 10, username: "bob", avatar: "", status: "online" }],
        }),
        makeDm({
          channelId: 6,
          recipient: { id: 20, username: "carol", avatar: "", status: "online" },
          participants: [{ id: 20, username: "carol", avatar: "", status: "online" }],
        }),
      ]);

      updateDmParticipant(10, { status: "dnd" });

      const other = dmStore.getState().channels.find((c) => c.channelId === 6)!;
      expect(other.recipient.status).toBe("online");
    });
  });

  // ── updateDmLastMessage ────────────────────────────────

  describe("updateDmLastMessage", () => {
    it("updates lastMessageId, lastMessage, lastMessageAt, and increments unreadCount", () => {
      setDmChannels([makeDm({ channelId: 5, unreadCount: 0 })]);
      updateDmLastMessage(5, 42, "hello", "2026-03-28T12:00:00Z");
      const ch = dmStore.getState().channels[0]!;
      expect(ch.lastMessageId).toBe(42);
      expect(ch.lastMessage).toBe("hello");
      expect(ch.lastMessageAt).toBe("2026-03-28T12:00:00Z");
      expect(ch.unreadCount).toBe(1);
    });

    it("increments unread count cumulatively", () => {
      setDmChannels([makeDm({ channelId: 5, unreadCount: 3 })]);
      updateDmLastMessage(5, 50, "msg", "2026-03-28T12:01:00Z");
      expect(dmStore.getState().channels[0]!.unreadCount).toBe(4);
    });

    it("is a no-op for a non-matching channelId", () => {
      setDmChannels([makeDm({ channelId: 5, unreadCount: 0 })]);
      updateDmLastMessage(999, 42, "nope", "2026-03-28T12:00:00Z");
      const ch = dmStore.getState().channels[0]!;
      expect(ch.unreadCount).toBe(0);
      expect(ch.lastMessageId).toBeNull();
    });

    it("does not modify other channels", () => {
      setDmChannels([
        makeDm({ channelId: 5, unreadCount: 0 }),
        makeDm({ channelId: 6, unreadCount: 2 }),
      ]);
      updateDmLastMessage(5, 42, "hello", "2026-03-28T12:00:00Z");
      expect(dmStore.getState().channels[1]!.unreadCount).toBe(2);
      expect(dmStore.getState().channels[1]!.lastMessageId).toBeNull();
    });
  });

  // ── updateDmLastMessagePreview ──────────────────────────

  describe("updateDmLastMessagePreview", () => {
    it("updates lastMessageId, lastMessage, lastMessageAt without incrementing unread", () => {
      setDmChannels([makeDm({ channelId: 5, unreadCount: 3 })]);
      updateDmLastMessagePreview(5, 99, "my own message", "2026-03-28T13:00:00Z");
      const ch = dmStore.getState().channels[0]!;
      expect(ch.lastMessageId).toBe(99);
      expect(ch.lastMessage).toBe("my own message");
      expect(ch.lastMessageAt).toBe("2026-03-28T13:00:00Z");
      expect(ch.unreadCount).toBe(3); // unchanged
    });

    it("moves the updated channel to the front of the list", () => {
      setDmChannels([makeDm({ channelId: 1 }), makeDm({ channelId: 2 }), makeDm({ channelId: 3 })]);
      updateDmLastMessagePreview(3, 50, "latest", "2026-03-28T14:00:00Z");
      const channels = dmStore.getState().channels;
      expect(channels[0]!.channelId).toBe(3);
      expect(channels[0]!.lastMessage).toBe("latest");
      expect(channels).toHaveLength(3);
    });

    it("is a no-op for a non-matching channelId", () => {
      setDmChannels([makeDm({ channelId: 5, unreadCount: 1 })]);
      updateDmLastMessagePreview(999, 42, "nope", "2026-03-28T12:00:00Z");
      const ch = dmStore.getState().channels[0]!;
      expect(ch.unreadCount).toBe(1);
      expect(ch.lastMessageId).toBeNull();
    });

    it("does not modify other channels", () => {
      setDmChannels([
        makeDm({ channelId: 5, unreadCount: 2 }),
        makeDm({ channelId: 6, unreadCount: 4, lastMessage: "old" }),
      ]);
      updateDmLastMessagePreview(5, 10, "hello", "2026-03-28T15:00:00Z");
      // Channel 6 should be untouched (now at index 1 because 5 moved to front)
      const ch6 = dmStore.getState().channels.find((c) => c.channelId === 6)!;
      expect(ch6.unreadCount).toBe(4);
      expect(ch6.lastMessage).toBe("old");
    });

    it("returns prev state reference when channel not found (immutability)", () => {
      setDmChannels([makeDm({ channelId: 5 })]);
      const before = dmStore.getState();
      updateDmLastMessagePreview(999, 1, "x", "2026-03-28T12:00:00Z");
      const after = dmStore.getState();
      expect(after).toBe(before);
    });
  });

  // ── updateDmLastMessage — channel reordering ──────────

  describe("updateDmLastMessage — reordering", () => {
    it("moves the updated channel to the front of the list", () => {
      setDmChannels([makeDm({ channelId: 1 }), makeDm({ channelId: 2 }), makeDm({ channelId: 3 })]);
      updateDmLastMessage(3, 50, "new", "2026-03-28T14:00:00Z");
      const channels = dmStore.getState().channels;
      expect(channels[0]!.channelId).toBe(3);
      expect(channels).toHaveLength(3);
    });
  });

  // ── clearDmUnread ──────────────────────────────────────

  describe("clearDmUnread", () => {
    it("sets unread count to 0 for the specified channel", () => {
      setDmChannels([makeDm({ channelId: 5, unreadCount: 7 })]);
      clearDmUnread(5);
      expect(dmStore.getState().channels[0]!.unreadCount).toBe(0);
    });

    it("does not modify other channels", () => {
      setDmChannels([
        makeDm({ channelId: 5, unreadCount: 3 }),
        makeDm({ channelId: 6, unreadCount: 5 }),
      ]);
      clearDmUnread(5);
      expect(dmStore.getState().channels[0]!.unreadCount).toBe(0);
      expect(dmStore.getState().channels[1]!.unreadCount).toBe(5);
    });

    it("is a no-op for a non-existent channel", () => {
      setDmChannels([makeDm({ channelId: 5, unreadCount: 3 })]);
      clearDmUnread(999);
      expect(dmStore.getState().channels[0]!.unreadCount).toBe(3);
    });
  });
});
