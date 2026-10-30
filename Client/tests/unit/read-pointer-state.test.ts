/**
 * The client half of the read pointer (WP 3D-5d), at the read-state level:
 * with the server's `read_pointer` capability, leaving a channel marks only
 * what the reader saw (`mark_read` with a message id), never everything, and
 * Mark Unread moves the pointer back and holds it there. Without the
 * capability every path is the old one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  forgetPendingMarkUnread,
  leaveChannel,
  markActiveChannelReadOnUnload,
  markChannelRead,
  markChannelReadSeen,
  noteLiveMessageSeen,
  noteMessageSeen,
  noteVisibleMessageSeen,
  onMarkUnreadFailed,
  resetReadPointerState,
  failMarkUnread,
  setLiveTailInView,
  noteAwayUnread,
  setMarkReadSender,
  writeReadPointer,
} from "@lib/read-state";
import {
  markMessageUnread,
  setMarkUnreadSender,
} from "../../src/components/message-list/mark-unread";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { markReadyActiveChannelRead } from "../../src/features/channels/wsHandlers";
import { channelsStore, setActiveChannel, setChannels } from "@stores/channels.store";
import { dmStore, setDmChannels } from "@stores/dm.store";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import type { ReadyChannel } from "@lib/types";
import type { DmChannel } from "@stores/dm.store";

function channel(id: number, unread: number, pointer: number | undefined): ReadyChannel {
  return {
    id,
    name: `chan-${id}`,
    type: "text",
    category: null,
    position: id,
    unread_count: unread,
    mention_count: 0,
    ...(pointer !== undefined ? { last_read_message_id: pointer } : {}),
  };
}

function msg(id: number): Message {
  return {
    id,
    channelId: 1,
    user: { id: 2, username: "alice", avatar: null },
    content: `m${id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2024-01-15T12:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

/** Seed a channel's loaded messages directly (setMessages takes server payloads). */
function setMessages(channelId: number, messages: readonly Message[], _hasMore: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(channelId, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
}

const pointer = (id: number): number | undefined =>
  channelsStore.getState().channels.get(id)?.lastReadMessageId;

let reads: Array<[number, number | undefined]>;
let unreads: Array<[number, number]>;
let hasFocus: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reads = [];
  unreads = [];
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  setMarkReadSender((id, messageId) => reads.push([id, messageId]));
  setMarkUnreadSender((id, messageId) => {
    unreads.push([id, messageId]);
    return `u-${unreads.length}`;
  });
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
  dmStore.setState(() => ({ channels: [] }));
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
  applyReadyCapabilities({ read_pointer: true });
  // Module state: a test that scrolled away must not leave the next one away.
  setLiveTailInView(1, true);
  setLiveTailInView(50, true);
});

afterEach(() => {
  hasFocus.mockRestore();
  setMarkReadSender(null);
  setMarkUnreadSender(null);
  resetServerCapabilities();
  resetReadPointerState();
  vi.useRealTimers();
});

describe("capability off: today's behaviour", () => {
  beforeEach(() => applyReadyCapabilities({}));

  it("leaving a channel marks it read at latest, without a message id", () => {
    setChannels([channel(1, 0, 5)]);
    noteMessageSeen(1, 9);
    leaveChannel(1);
    expect(reads).toEqual([[1, undefined]]);
  });

  it("an absent capability field reads as false", () => {
    applyReadyCapabilities({ read_pointer: true });
    applyReadyCapabilities(undefined);
    setChannels([channel(1, 0, 5)]);
    leaveChannel(1);
    expect(reads).toEqual([[1, undefined]]);
  });

  it("markChannelReadSeen is markChannelRead", () => {
    setChannels([channel(1, 3, undefined)]);
    markChannelReadSeen(1);
    expect(reads).toEqual([[1, undefined]]);
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
  });

  it("Mark Unread does nothing and sends nothing", () => {
    setChannels([channel(1, 0, 5)]);
    setMessages(1, [msg(6), msg(7)], false);
    expect(markMessageUnread(1, 7)).toBeNull();
    expect(unreads).toEqual([]);
  });
});

describe("capability on: marks only what was seen", () => {
  it("leaving sends mark_read with the highest seen id and moves the pointer forward", () => {
    setChannels([channel(1, 0, 5)]);
    setActiveChannel(1);
    noteMessageSeen(1, 8);
    noteMessageSeen(1, 12);
    noteMessageSeen(1, 10);
    leaveChannel(1);
    expect(reads).toEqual([[1, 12]]);
    expect(pointer(1)).toBe(12);
  });

  it("leaving with nothing seen sends nothing and keeps the unread badge", () => {
    setChannels([channel(1, 4, 5)]);
    leaveChannel(1);
    expect(reads).toEqual([]);
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(4);
  });

  it("sends nothing when what was seen is not above the pointer", () => {
    setChannels([channel(1, 0, 20)]);
    noteMessageSeen(1, 20);
    leaveChannel(1);
    expect(reads).toEqual([]);
  });

  it("does not record a message seen while the reader is away", () => {
    setChannels([channel(1, 0, 5)]);
    hasFocus.mockReturnValue(false);
    noteMessageSeen(1, 9);
    hasFocus.mockReturnValue(true);
    setLiveTailInView(1, false);
    noteMessageSeen(1, 9);
    leaveChannel(1);
    expect(reads).toEqual([]);
  });

  it("forgets what was seen once the channel is left", () => {
    setChannels([channel(1, 0, 5)]);
    noteMessageSeen(1, 9);
    leaveChannel(1);
    leaveChannel(1);
    expect(reads).toEqual([[1, 9]]);
  });

  it("reaching the live tail sends the seen id and clears the badge", () => {
    setChannels([channel(1, 3, 5)]);
    noteMessageSeen(1, 9);
    markChannelReadSeen(1);
    expect(reads).toEqual([[1, 9]]);
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
  });

  it("Mark as Read keeps marking at latest, without a message id", () => {
    setChannels([channel(1, 3, 5)]);
    noteMessageSeen(1, 9);
    markChannelRead(1);
    expect(reads).toEqual([[1, undefined]]);
  });

  it("the live-seen path sends the seen id, not everything", () => {
    vi.useFakeTimers();
    setChannels([channel(1, 0, 5)]);
    noteMessageSeen(1, 9, true);
    noteLiveMessageSeen(1, new AbortController().signal);
    vi.advanceTimersByTime(1100);
    expect(reads).toEqual([[1, 9]]);
  });

  it("unload sends the seen id, with no unread-badge gate", () => {
    setChannels([channel(1, 2, 5)]);
    setActiveChannel(1, { clearUnread: false });
    noteMessageSeen(1, 9);
    markActiveChannelReadOnUnload();
    expect(reads).toEqual([[1, 9]]);
  });

  it("a ready-time mark sends what was seen, never the latest", () => {
    setChannels([channel(1, 6, 5)]);
    setActiveChannel(1, { clearUnread: false });
    noteMessageSeen(1, 9);
    markReadyActiveChannelRead(1);
    expect(reads).toEqual([[1, 9]]);
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
  });

  it("a ready-time mark with nothing seen sends nothing", () => {
    setChannels([channel(1, 6, 5)]);
    setActiveChannel(1, { clearUnread: false });
    markReadyActiveChannelRead(1);
    expect(reads).toEqual([]);
  });

  it("never moves a pointer back on its own: a seen id behind it is not written", () => {
    setChannels([channel(1, 0, 20)]);
    writeReadPointer(1, 4, undefined, true);
    expect(pointer(1)).toBe(20);
    writeReadPointer(1, 25, undefined, true);
    expect(pointer(1)).toBe(25);
    writeReadPointer(1, 3);
    expect(pointer(1)).toBe(3);
  });

  it("marks a DM pointer in both stores", () => {
    const dm: DmChannel = {
      channelId: 50,
      recipient: { id: 7, username: "bob", avatar: "", status: "online" },
      participants: [],
      name: "",
      isGroup: false,
      lastMessageId: 30,
      lastReadMessageId: 10,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };
    setDmChannels([dm]);
    noteMessageSeen(50, 30);
    leaveChannel(50);
    expect(reads).toEqual([[50, 30]]);
    expect(dmStore.getState().channels[0]?.lastReadMessageId).toBe(30);
  });
});

describe("Mark Unread", () => {
  beforeEach(() => {
    setChannels([channel(1, 0, 10)]);
    setActiveChannel(1);
    setMessages(1, [msg(8), msg(9), msg(10), msg(11)], false);
  });

  it("sends mark_unread and moves the pointer to the previous loaded message", () => {
    expect(markMessageUnread(1, 10)).toBe(9);
    expect(unreads).toEqual([[1, 10]]);
    expect(pointer(1)).toBe(9);
  });

  it("uses 0 when no earlier message is loaded", () => {
    expect(markMessageUnread(1, 8)).toBe(0);
    expect(pointer(1)).toBe(0);
  });

  it("keeps its badge when the reader reaches the bottom: nothing was seen since", () => {
    markMessageUnread(1, 10);
    writeReadPointer(1, 9, { unread: 2, mention: 1 });
    markChannelReadSeen(1);
    expect(channelsStore.getState().channels.get(1)).toMatchObject({
      unreadCount: 2,
      mentionCount: 1,
    });
  });

  it("is not re-marked read by what is on screen", () => {
    noteMessageSeen(1, 11);
    markMessageUnread(1, 10);
    noteMessageSeen(1, 11);
    noteMessageSeen(1, 11, true);
    leaveChannel(1);
    expect(reads).toEqual([]);
    expect(pointer(1)).toBe(9);
  });

  it("is marked read again once the reader was away and a live message arrives", () => {
    markMessageUnread(1, 10);
    setLiveTailInView(1, false);
    setLiveTailInView(1, true);
    noteMessageSeen(1, 11);
    expect(reads).toEqual([]);
    noteMessageSeen(1, 12, true);
    leaveChannel(1);
    expect(reads).toEqual([[1, 12]]);
  });

  it("is marked read on the next visit: leaving drops the hold", () => {
    markMessageUnread(1, 10);
    leaveChannel(1);
    noteMessageSeen(1, 11);
    leaveChannel(1);
    expect(reads).toEqual([[1, 11]]);
  });

  it("puts the pointer back when the server refuses it", () => {
    markMessageUnread(1, 10);
    expect(failMarkUnread("u-1", "failed")).toBe(true);
    expect(pointer(1)).toBe(10);
    // And the hold is gone with it.
    noteMessageSeen(1, 11);
    leaveChannel(1);
    expect(reads).toEqual([[1, 11]]);
  });

  it("ignores a refusal for some other frame", () => {
    markMessageUnread(1, 10);
    expect(failMarkUnread("something-else", "failed")).toBe(false);
    expect(failMarkUnread(undefined, "failed")).toBe(false);
    expect(pointer(1)).toBe(9);
  });

  it("keeps two requests apart: the first one's refusal rolls back only its own", () => {
    setChannels([channel(1, 0, 10), channel(2, 0, 20)]);
    setMessages(2, [msg(18), msg(19), msg(20)], false);
    markMessageUnread(1, 10);
    markMessageUnread(2, 20);
    expect(pointer(1)).toBe(9);
    expect(pointer(2)).toBe(19);
    expect(failMarkUnread("u-1", "failed")).toBe(true);
    expect(pointer(1)).toBe(10);
    expect(pointer(2)).toBe(19);
    expect(failMarkUnread("u-2", "failed")).toBe(true);
    expect(pointer(2)).toBe(20);
  });

  it("is released by a live arrival once the reader was away at an unread arrival", () => {
    markMessageUnread(1, 10);
    noteAwayUnread(1);
    noteMessageSeen(1, 12, true);
    leaveChannel(1);
    expect(reads).toEqual([[1, 12]]);
  });

  it("stays held when no arrival found the reader away", () => {
    markMessageUnread(1, 10);
    noteMessageSeen(1, 12, true);
    leaveChannel(1);
    expect(reads).toEqual([]);
  });

  it("tells a mounted list when a refusal put the pointer back, and not after it unsubscribed", () => {
    const told: number[] = [];
    const off = onMarkUnreadFailed((id) => told.push(id));
    markMessageUnread(1, 10);
    failMarkUnread("u-1", "failed");
    expect(told).toEqual([1]);
    off();
    markMessageUnread(1, 10);
    failMarkUnread("u-2", "failed");
    expect(told).toEqual([1]);
  });

  it("a stranger frame tells nobody", () => {
    const told: number[] = [];
    const off = onMarkUnreadFailed((id) => told.push(id));
    markMessageUnread(1, 10);
    failMarkUnread("something-else", "failed");
    off();
    expect(told).toEqual([]);
  });

  it("records the visible message of a list scrolled off the tail, and only raises it", () => {
    setLiveTailInView(1, false);
    noteMessageSeen(1, 8);
    noteVisibleMessageSeen(1, 12);
    noteVisibleMessageSeen(1, 9);
    leaveChannel(1);
    expect(reads).toEqual([[1, 12]]);
  });

  it("a visible message is not recorded while blurred or held after Mark Unread", () => {
    hasFocus.mockReturnValue(false);
    noteVisibleMessageSeen(1, 12);
    hasFocus.mockReturnValue(true);
    markMessageUnread(1, 10);
    noteVisibleMessageSeen(1, 12);
    leaveChannel(1);
    expect(reads).toEqual([]);
  });

  it("a refusal is answered once", () => {
    markMessageUnread(1, 10);
    expect(failMarkUnread("u-1", "failed")).toBe(true);
    expect(failMarkUnread("u-1", "failed")).toBe(false);
  });

  it("forgets a request a new ready has replaced", () => {
    markMessageUnread(1, 10);
    forgetPendingMarkUnread();
    expect(failMarkUnread("u-1", "failed")).toBe(false);
    expect(pointer(1)).toBe(9);
  });
});
