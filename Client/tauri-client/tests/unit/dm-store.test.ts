import { describe, it, expect, beforeEach } from "vitest";
import {
  dmStore,
  setDmChannels,
  addDmChannel,
  removeDmChannel,
  updateDmLastMessage,
  updateDmLastMessagePreview,
  clearDmUnread,
} from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";

function makeDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 100,
    recipient: { id: 1, username: "alice", avatar: "", status: "online" },
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
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
      setDmChannels([
        makeDm({ channelId: 1, lastMessage: "old" }),
        makeDm({ channelId: 2 }),
      ]);
      addDmChannel(makeDm({ channelId: 1, lastMessage: "new" }));
      const channels = dmStore.getState().channels;
      expect(channels).toHaveLength(2);
      // Updated channel moves to front
      expect(channels[0]!.channelId).toBe(1);
      expect(channels[0]!.lastMessage).toBe("new");
    });

    it("moves an updated existing channel to the front", () => {
      setDmChannels([
        makeDm({ channelId: 1 }),
        makeDm({ channelId: 2 }),
        makeDm({ channelId: 3 }),
      ]);
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
      setDmChannels([
        makeDm({ channelId: 1 }),
        makeDm({ channelId: 2 }),
        makeDm({ channelId: 3 }),
      ]);
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
      setDmChannels([
        makeDm({ channelId: 1 }),
        makeDm({ channelId: 2 }),
        makeDm({ channelId: 3 }),
      ]);
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
