/**
 * Explicit mark-as-read. The property that matters is that it uses `mark_read`
 * rather than `channel_focus` — the local badge clearing is the easy half; not
 * moving the connection's focused channel is the reason this exists.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  markAllRead,
  markChannelRead,
  hasUnread,
  setMarkReadSender,
  unreadChannelIds,
} from "@lib/read-state";
import { channelsStore, setChannels } from "@stores/channels.store";
import { dmStore, setDmChannels } from "@stores/dm.store";
import type { ReadyChannel } from "@lib/types";
import type { DmChannel } from "@stores/dm.store";

function channel(id: number, unread: number, mentions = 0): ReadyChannel {
  return {
    id,
    name: `chan-${id}`,
    type: "text",
    category: null,
    position: id,
    unread_count: unread,
    mention_count: mentions,
  };
}

function dm(channelId: number, unread: number, mentions = 0): DmChannel {
  return {
    channelId,
    recipient: { id: channelId * 10, username: `u${channelId}`, avatar: "", status: "online" },
    participants: [],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: unread,
    mentionCount: mentions,
  };
}

let sent: number[];

beforeEach(() => {
  sent = [];
  setMarkReadSender((id) => sent.push(id));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  dmStore.setState(() => ({ channels: [] }));
});

describe("hasUnread", () => {
  it("is true for an unread channel and false once it is read", () => {
    setChannels([channel(1, 3), channel(2, 0)]);
    expect(hasUnread(1)).toBe(true);
    expect(hasUnread(2)).toBe(false);
  });

  it("counts a mention-only channel as unread", () => {
    setChannels([channel(1, 0, 2)]);
    expect(hasUnread(1)).toBe(true);
  });

  it("sees DM badges, which live in a different store", () => {
    setDmChannels([dm(50, 4)]);
    expect(hasUnread(50)).toBe(true);
  });

  it("is false for an unknown channel", () => {
    expect(hasUnread(999)).toBe(false);
  });
});

describe("markChannelRead", () => {
  it("sends mark_read and clears the local badges", () => {
    setChannels([channel(1, 3, 2)]);

    markChannelRead(1);

    expect(sent).toEqual([1]);
    const ch = channelsStore.getState().channels.get(1);
    expect(ch?.unreadCount).toBe(0);
    expect(ch?.mentionCount).toBe(0);
  });

  it("does not make the channel active — marking read is not visiting", () => {
    setChannels([channel(1, 3), channel(2, 1)]);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));

    markChannelRead(1);

    expect(channelsStore.getState().activeChannelId).toBe(2);
  });

  it("clears a DM's badges", () => {
    setDmChannels([dm(50, 4, 1)]);

    markChannelRead(50);

    expect(sent).toEqual([50]);
    const conv = dmStore.getState().channels[0];
    expect(conv?.unreadCount).toBe(0);
    expect(conv?.mentionCount).toBe(0);
  });

  it("ignores a channel this client does not know", () => {
    markChannelRead(999);
    expect(sent).toEqual([]);
  });

  // A dropped send still clears locally; the next ready re-asserts the server's
  // view, so the badge self-corrects rather than being stuck.
  it("still clears the badge with no sender registered", () => {
    setMarkReadSender(null);
    setChannels([channel(1, 3)]);

    markChannelRead(1);

    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
  });
});

describe("unreadChannelIds / markAllRead", () => {
  it("lists every badged channel and DM, and nothing else", () => {
    setChannels([channel(1, 3), channel(2, 0), channel(3, 0, 1)]);
    setDmChannels([dm(50, 2), dm(51, 0)]);

    expect([...unreadChannelIds()].sort((a, b) => a - b)).toEqual([1, 3, 50]);
  });

  it("marks everything read and reports how many", () => {
    setChannels([channel(1, 3), channel(2, 0), channel(3, 0, 1)]);
    setDmChannels([dm(50, 2)]);

    expect(markAllRead()).toBe(3);
    expect([...sent].sort((a, b) => a - b)).toEqual([1, 3, 50]);
    expect(unreadChannelIds()).toEqual([]);
  });

  it("is a no-op when nothing is unread", () => {
    setChannels([channel(1, 0)]);

    expect(markAllRead()).toBe(0);
    expect(sent).toEqual([]);
  });

  // Regression for v056: the server's mark_read handler shares a 5/s budget
  // with channel_focus and silently drops frames over it. Marking more
  // channels than the budget synchronously used to clear every local badge
  // up front while the server dropped the excess — the dropped channels'
  // badges then resurrected on the next `ready`. Bursts must stay paced.
  it("paces a burst larger than the server's per-second mark_read budget", () => {
    vi.useFakeTimers();
    try {
      setChannels([
        channel(1, 1),
        channel(2, 1),
        channel(3, 1),
        channel(4, 1),
        channel(5, 1),
        channel(6, 1),
      ]);

      expect(markAllRead()).toBe(6);

      // Only the first burst goes out synchronously.
      expect(sent.length).toBeLessThanOrEqual(4);
      const firstBurst = new Set(sent);
      const deferredId = [1, 2, 3, 4, 5, 6].find((id) => !firstBurst.has(id))!;

      // A channel whose send hasn't fired yet must not have had its local
      // badge cleared early — clearing must track the send, not precede it.
      expect(hasUnread(deferredId)).toBe(true);

      // The rest lands only after the pacing interval, one budget-window later.
      vi.advanceTimersByTime(2000);
      expect(sent.length).toBe(6);
      expect(new Set(sent)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
      expect(hasUnread(deferredId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The pacing above defers sends past the point where the connection can be
  // replaced. Channel ids are only unique per server, so a queued send that
  // survives a server switch would mark the NEW server's same-numbered channel
  // read. Registering a sender is the one signal read-state gets that the
  // connection changed (MainPage does it once per session).
  it("drops queued sends when a new connection registers its sender", () => {
    vi.useFakeTimers();
    try {
      setChannels([channel(1, 1), channel(2, 1), channel(3, 1), channel(4, 1), channel(5, 1)]);
      markAllRead();
      expect(sent.length).toBeLessThanOrEqual(4);

      // New session: new sender, new (unrelated) channel list reusing the ids.
      const next: number[] = [];
      setMarkReadSender((id) => next.push(id));
      setChannels([channel(1, 1), channel(2, 1), channel(3, 1), channel(4, 1), channel(5, 1)]);

      vi.advanceTimersByTime(5000);
      expect(next).toEqual([]);
      expect(unreadChannelIds()).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supersedes an in-flight burst rather than double-sending it", () => {
    vi.useFakeTimers();
    try {
      setChannels([channel(1, 1), channel(2, 1), channel(3, 1), channel(4, 1), channel(5, 1)]);
      markAllRead();
      markAllRead();

      vi.advanceTimersByTime(5000);
      expect(sent.length).toBe(5);
      expect(new Set(sent)).toEqual(new Set([1, 2, 3, 4, 5]));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mark_read wiring", () => {
  it("hands the sender only the channel id", () => {
    const sender = vi.fn();
    setMarkReadSender(sender);
    setChannels([channel(7, 1)]);

    markChannelRead(7);

    expect(sender).toHaveBeenCalledExactlyOnceWith(7);
  });
});
