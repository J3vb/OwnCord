/**
 * Explicit mark-as-read. The property that matters is that it uses `mark_read`
 * rather than `channel_focus` — the local badge clearing is the easy half; not
 * moving the connection's focused channel is the reason this exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  markActiveChannelReadOnUnload,
  markAllRead,
  markChannelRead,
  markChannelsRead,
  hasUnread,
  showsUnreadBadge,
  noteLiveMessageSeen,
  setMarkReadSender,
  unreadChannelIds,
} from "@lib/readState";
import {
  channelsStore,
  setChannels,
  setActiveChannel,
  incrementUnread,
} from "@stores/channels.store";
import { dmStore, setDmChannels } from "@stores/dm.store";
import { closeSettings, openSettings, setActiveView } from "@stores/ui.store";
import type { ReadyChannel } from "@lib/types";
import type { DmChannel } from "@stores/dm.store";
import { resetChannelsState } from "../helpers/storeSeeds";

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
  resetChannelsState();
  dmStore.setState(() => ({ channels: [] }));
});

const sixUnread = () => [1, 2, 3, 4, 5, 6].map((id) => channel(id, 1));

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

  it("a voice channel's badge counts only its mentions", () => {
    setChannels([
      { ...channel(1, 4), type: "voice" },
      { ...channel(2, 4, 1), type: "voice" },
    ]);
    expect(showsUnreadBadge(1)).toBe(false);
    expect(showsUnreadBadge(2)).toBe(true);
    expect(hasUnread(1)).toBe(true);
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

  it("voice unread without a mention is not unread; a voice mention is", () => {
    setChannels([
      channel(1, 0),
      { ...channel(2, 6), type: "voice" },
      { ...channel(3, 6, 2), type: "voice" },
    ]);
    expect(unreadChannelIds({ includeDms: false })).toEqual([3]);
    setChannels([channel(1, 0), { ...channel(2, 6), type: "voice" }]);
    expect(unreadChannelIds()).toEqual([]);
    expect(showsUnreadBadge(2)).toBe(false);
    // Still unread for the mark-read paths, so viewing the chat clears it.
    expect(hasUnread(2)).toBe(true);
    setChannels([{ ...channel(3, 6, 2), type: "voice" }]);
    expect(showsUnreadBadge(3)).toBe(true);
  });

  it("marks everything read and reports how many", () => {
    setChannels([channel(1, 3), channel(2, 0), channel(3, 0, 1)]);
    setDmChannels([dm(50, 2)]);

    expect(markAllRead()).toBe(3);
    expect([...sent].sort((a, b) => a - b)).toEqual([1, 3, 50]);
    expect(unreadChannelIds()).toEqual([]);
  });

  it("includeDms: false lists and marks only server channels, leaving DMs and their mirror rows unread", () => {
    setChannels([channel(1, 3), { ...channel(60, 4), type: "dm" }]);
    setDmChannels([dm(60, 4), dm(50, 2, 1)]);

    expect(unreadChannelIds({ includeDms: false })).toEqual([1]);
    expect(markAllRead({ includeDms: false })).toBe(1);
    expect(sent).toEqual([1]);
    expect(hasUnread(1)).toBe(false);
    expect(hasUnread(50)).toBe(true);
    expect(hasUnread(60)).toBe(true);
    expect(dmStore.getState().channels.find((c) => c.channelId === 50)?.unreadCount).toBe(2);
    expect(dmStore.getState().channels.find((c) => c.channelId === 50)?.mentionCount).toBe(1);
  });

  it("the default and includeDms: true still clear DMs (every other caller)", () => {
    setChannels([channel(1, 3)]);
    setDmChannels([dm(50, 2)]);
    expect(markAllRead({ includeDms: true })).toBe(2);
    expect([...sent].sort((a, b) => a - b)).toEqual([1, 50]);
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
      setChannels(sixUnread());

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

  it("merges an overlapping markChannelsRead into the pacing queue without dropping or bursting", () => {
    vi.useFakeTimers();
    try {
      const at: number[] = [];
      setMarkReadSender((id) => {
        sent.push(id);
        at.push(Date.now());
      });
      const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      setChannels(all.map((id) => channel(id, 1)));

      markAllRead();
      expect(sent).toHaveLength(4);
      // Mid-burst: a subset, some already sent, some still queued.
      vi.advanceTimersByTime(300);
      markChannelsRead([2, 8, 9]);
      expect(sent).toHaveLength(4);
      vi.advanceTimersByTime(10_000);

      expect(sent.toSorted((a, b) => a - b)).toEqual(all);
      for (const t of at) {
        expect(at.filter((u) => u >= t && u < t + 1100).length).toBeLessThanOrEqual(4);
      }
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

  // OC-0123: a message that arrives in a channel while its own send is still
  // sitting in the paced tail must not be wiped out by that stale click. The
  // click predates the message; marking it read would silently swallow a
  // genuinely-new unread the user has not seen.
  it("does not mark read a channel that got a new message during the pacing window", () => {
    vi.useFakeTimers();
    try {
      setChannels(sixUnread());

      expect(markAllRead()).toBe(6);
      const firstBurst = new Set(sent);
      const deferredId = [1, 2, 3, 4, 5, 6].find((id) => !firstBurst.has(id))!;

      // A new message lands in the deferred channel before its paced send fires
      // — exactly what the dispatcher's chat_message handler does.
      incrementUnread(deferredId);
      expect(channelsStore.getState().channels.get(deferredId)?.unreadCount).toBe(2);

      vi.advanceTimersByTime(2000);

      // The paced send must skip this channel: the message postdates the click,
      // so neither the local badge nor the server's read state should advance
      // past it.
      expect(sent).not.toContain(deferredId);
      expect(hasUnread(deferredId)).toBe(true);
      expect(channelsStore.getState().channels.get(deferredId)?.unreadCount).toBe(2);
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

/** Fake timers plus a fresh AbortController per test, torn down after it. */
function useLiveSeenController(bind: (controller: AbortController) => void): void {
  let controller: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new AbortController();
    bind(controller);
  });

  afterEach(() => {
    controller.abort();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}

describe("noteLiveMessageSeen", () => {
  let controller: AbortController;
  useLiveSeenController((created) => {
    controller = created;
  });

  it("sends one trailing mark_read, not one per arrival", () => {
    setChannels([channel(1, 0)]);

    noteLiveMessageSeen(1, controller.signal);
    vi.advanceTimersByTime(300);
    noteLiveMessageSeen(1, controller.signal);
    vi.advanceTimersByTime(300);
    noteLiveMessageSeen(1, controller.signal);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([1]);

    // Nothing is left armed once it has fired.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing when Settings opened after the timer was armed", () => {
    setChannels([channel(1, 0)]);
    setActiveChannel(1);

    noteLiveMessageSeen(1, controller.signal);
    openSettings();
    try {
      vi.advanceTimersByTime(1000);

      expect(sent).toEqual([]);
    } finally {
      closeSettings();
    }
  });

  it("keeps sends for one channel at least a second apart and channels independent", () => {
    setChannels([channel(1, 0), channel(2, 0)]);

    noteLiveMessageSeen(1, controller.signal);
    noteLiveMessageSeen(2, controller.signal);
    vi.advanceTimersByTime(1000);
    expect([...sent].sort()).toEqual([1, 2]);

    noteLiveMessageSeen(1, controller.signal);
    vi.advanceTimersByTime(999);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(3);
  });

  it("clears its timer when the owning signal aborts", () => {
    setChannels([channel(1, 0)]);

    noteLiveMessageSeen(1, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([]);

    // The channel is free to arm again for the next list.
    const next = new AbortController();
    noteLiveMessageSeen(1, next.signal);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([1]);
    next.abort();
  });

  it("arms nothing for a signal that has already aborted", () => {
    setChannels([channel(1, 0)]);
    controller.abort();

    noteLiveMessageSeen(1, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips the send when an unseen message was counted meanwhile", () => {
    setChannels([channel(1, 0)]);

    noteLiveMessageSeen(1, controller.signal);
    incrementUnread(1);
    vi.advanceTimersByTime(1000);

    expect(sent).toEqual([]);
    expect(hasUnread(1)).toBe(true);
  });

  it("drops a pending send when a new connection registers its sender", () => {
    setChannels([channel(1, 0)]);

    noteLiveMessageSeen(1, controller.signal);
    const next: number[] = [];
    setMarkReadSender((id) => next.push(id));
    vi.advanceTimersByTime(2000);

    expect(sent).toEqual([]);
    expect(next).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("markActiveChannelReadOnUnload", () => {
  let hasFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    hasFocus.mockRestore();
  });

  it("marks the active channel read", () => {
    setChannels([channel(1, 0), channel(2, 0)]);
    setActiveChannel(2);

    markActiveChannelReadOnUnload();

    expect(sent).toEqual([2]);
  });

  it("sends nothing with no active channel", () => {
    setChannels([channel(1, 0)]);

    markActiveChannelReadOnUnload();

    expect(sent).toEqual([]);
  });

  it("sends nothing while the reader is away from the channel", () => {
    setChannels([channel(1, 0)]);
    setActiveChannel(1);
    hasFocus.mockReturnValue(false);

    markActiveChannelReadOnUnload();

    expect(sent).toEqual([]);
  });

  it("sends nothing while the Settings overlay covers the chat", () => {
    setChannels([channel(1, 0)]);
    setActiveChannel(1);
    openSettings();

    try {
      markActiveChannelReadOnUnload();

      expect(sent).toEqual([]);
    } finally {
      closeSettings();
    }
  });

  it("sends nothing while a modal dialog covers the chat", () => {
    setChannels([channel(1, 0)]);
    setActiveChannel(1);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    document.body.appendChild(modal);

    try {
      markActiveChannelReadOnUnload();

      expect(sent).toEqual([]);
    } finally {
      modal.remove();
    }
  });

  it("sends nothing while a content view replaces the chat", () => {
    setChannels([channel(1, 0)]);
    setActiveChannel(1);
    setActiveView("moderation");

    try {
      markActiveChannelReadOnUnload();

      expect(sent).toEqual([]);
    } finally {
      setActiveView(null);
    }
  });

  it("leaves an unseen unread alone", () => {
    setChannels([channel(1, 2)]);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

    markActiveChannelReadOnUnload();

    expect(sent).toEqual([]);
    expect(hasUnread(1)).toBe(true);
  });

  it("supersedes a pending live-seen send instead of sending twice", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      setChannels([channel(1, 0)]);
      setActiveChannel(1);
      noteLiveMessageSeen(1, controller.signal);

      markActiveChannelReadOnUnload();
      vi.advanceTimersByTime(2000);

      expect(sent).toEqual([1]);
    } finally {
      controller.abort();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("DM badges in the lookups", () => {
  it("counts a DM that has only a mention as unread", () => {
    setDmChannels([dm(7, 0, 2), dm(8, 0, 0)]);
    expect(hasUnread(7)).toBe(true);
    expect(hasUnread(8)).toBe(false);
  });

  it("shows a badge for a DM with unread messages, mentions, or both, and not for the others", () => {
    setDmChannels([dm(5, 0, 0), dm(6, 3, 0), dm(7, 0, 2), dm(8, 1, 1)]);
    expect(showsUnreadBadge(5)).toBe(false);
    expect(showsUnreadBadge(6)).toBe(true);
    expect(showsUnreadBadge(7)).toBe(true);
    expect(showsUnreadBadge(8)).toBe(true);
    expect(showsUnreadBadge(99)).toBe(false);
  });

  it("looks a DM up by its own id, not the first one in the list", () => {
    setDmChannels([dm(5, 4, 0), dm(6, 0, 0)]);
    expect(showsUnreadBadge(6)).toBe(false);
    expect(hasUnread(6)).toBe(false);
    expect(showsUnreadBadge(5)).toBe(true);
  });

  it("lists a DM that has only a mention, next to a channel and a quiet DM", () => {
    setChannels([channel(1, 2)]);
    setDmChannels([dm(7, 0, 1), dm(8, 0, 0)]);
    expect([...unreadChannelIds()].toSorted((a, b) => a - b)).toEqual([1, 7]);
  });
});

describe("markChannelsRead counts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends a channel whose unread and mention counts are both set", () => {
    setChannels([channel(1, 1, 1)]);
    expect(markChannelsRead([1])).toBe(1);
    expect(sent).toEqual([1]);
  });

  it("sends a DM whose unread and mention counts are both set", () => {
    setDmChannels([dm(6, 0, 0), dm(7, 1, 1)]);
    expect(markChannelsRead([7])).toBe(1);
    expect(sent).toEqual([7]);
  });

  it("sends a channel id given twice once, and reports how many ids it was given", () => {
    setChannels([channel(1, 2), channel(2, 1)]);
    expect(markChannelsRead([1, 1, 2])).toBe(3);
    expect(sent).toEqual([1, 2]);
  });
});

describe("a new connection and live-seen sends", () => {
  let controller: AbortController;
  useLiveSeenController((created) => {
    controller = created;
  });

  it("lets the same channel arm a fresh send on the new connection", () => {
    setChannels([channel(1, 0)]);
    noteLiveMessageSeen(1, controller.signal);
    const next: number[] = [];
    setMarkReadSender((id) => next.push(id));
    noteLiveMessageSeen(1, controller.signal);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(next).toEqual([1]);
  });
});

describe("an aborted signal after a new connection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("leaves the send the new connection armed for the same channel in place", () => {
    setChannels([channel(1, 0)]);
    const first = new AbortController();
    const second = new AbortController();
    noteLiveMessageSeen(1, first.signal);
    const next: number[] = [];
    setMarkReadSender((id) => next.push(id));
    noteLiveMessageSeen(1, second.signal);
    first.abort();
    // Still one pending send for the channel: a further arrival rides it.
    noteLiveMessageSeen(1, second.signal);
    vi.advanceTimersByTime(1000);
    expect(next).toEqual([1]);
    second.abort();
  });
});

describe("markChannelRead for a channel among DMs", () => {
  it("ignores an id that is in neither store while DMs exist", () => {
    setDmChannels([dm(7, 1)]);
    markChannelRead(99);
    expect(sent).toEqual([]);
    markChannelRead(7);
    expect(sent).toEqual([7]);
  });
});
