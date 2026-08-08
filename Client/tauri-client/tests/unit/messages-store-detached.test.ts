/**
 * Detached-window behaviour in the messages store.
 *
 * Jumping to a message outside the loaded page replaces the channel's window
 * with a server "around" window. That window is a *hole punched into history*:
 * the messages below it are not loaded, so the bottom of the list is no longer
 * "now". Everything here pins the consequences of that — the ordering the
 * around payload arrives in, the detached flag, what happens to live
 * broadcasts while detached, and how a channel gets back to the present.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  messagesStore,
  addMessage,
  setMessages,
  prependMessages,
  setAroundMessages,
  reattachToPresent,
  clearChannelMessages,
  getChannelMessages,
  isChannelLoaded,
  hasMoreMessages,
  isWindowDetached,
  hasMessageLoaded,
  addOptimisticMessage,
  markSendFailed,
} from "../../src/stores/messages.store";
import type { ChatMessagePayload, MessageResponse, MessageUser } from "../../src/lib/types";

const USER: MessageUser = { id: 1, username: "alice", avatar: null };

function response(id: number, overrides?: Partial<MessageResponse>): MessageResponse {
  return {
    id,
    channel_id: 1,
    user: USER,
    content: `msg ${id}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2026-03-15T09:00:00Z",
    ...overrides,
  };
}

/** An around-window payload: oldest-first, unlike the history endpoint. */
function ascendingWindow(from: number, to: number): MessageResponse[] {
  const out: MessageResponse[] = [];
  for (let id = from; id <= to; id++) out.push(response(id));
  return out;
}

function broadcast(id: number): ChatMessagePayload {
  return {
    id,
    channel_id: 1,
    user: USER,
    content: `live ${id}`,
    reply_to: null,
    attachments: [],
    timestamp: "2026-03-15T12:00:00Z",
  } as ChatMessagePayload;
}

function ids(channelId: number): number[] {
  return getChannelMessages(channelId).map((m) => m.id);
}

beforeEach(() => {
  clearChannelMessages(1);
  clearChannelMessages(2);
});

describe("setAroundMessages", () => {
  it("keeps the payload order — an around window is already oldest-first", () => {
    setAroundMessages(1, ascendingWindow(10, 14), false, false);

    // setMessages reverses (the history endpoint is newest-first); this one
    // must not, or every jump would render the window upside down.
    expect(ids(1)).toEqual([10, 11, 12, 13, 14]);
  });

  it("replaces the loaded window rather than merging into it", () => {
    setMessages(1, [response(300), response(299)], false);
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    expect(ids(1)).toEqual([10, 11, 12]);
  });

  it("marks the channel loaded and maps has_more_before onto hasMore", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, false);

    expect(isChannelLoaded(1)).toBe(true);
    expect(hasMoreMessages(1)).toBe(true);

    setAroundMessages(1, ascendingWindow(1, 3), false, false);
    expect(hasMoreMessages(1)).toBe(false);
  });

  it("detaches only when the server reports newer messages below", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);
    expect(isWindowDetached(1)).toBe(true);

    // A window that reaches the live tail is not detached: the bottom is now.
    setAroundMessages(1, ascendingWindow(10, 12), true, false);
    expect(isWindowDetached(1)).toBe(false);
  });

  it("detaches when the window itself had to be trimmed to the cap", () => {
    // 600 > the 500-message cap: the newest 100 are dropped, which strands the
    // tail exactly as has_more_after would have.
    setAroundMessages(1, ascendingWindow(1, 600), false, false);

    const loaded = getChannelMessages(1);
    expect(loaded).toHaveLength(500);
    // The *centre-side* head is kept, so trimming drops from the end.
    expect(loaded[0]!.id).toBe(1);
    expect(loaded.at(-1)!.id).toBe(500);
    expect(isWindowDetached(1)).toBe(true);
  });

  it("is scoped to one channel", () => {
    setMessages(2, [response(500, { channel_id: 2 })], false);
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    expect(isWindowDetached(2)).toBe(false);
    expect(ids(2)).toEqual([500]);
  });

  it("carries pending and failed optimistic rows instead of wiping them", () => {
    // Unlike setMessages, setAroundMessages replaces the window wholesale —
    // without a carry, a jump elsewhere destroys the user's still-unsent
    // message and orphans its Retry draft.
    addOptimisticMessage({
      correlationId: "c1",
      channelId: 1,
      user: USER,
      content: "still sending",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });
    addOptimisticMessage({
      correlationId: "c2",
      channelId: 1,
      user: USER,
      content: "refused",
      replyTo: null,
      timestamp: "2026-03-15T10:00:01Z",
    });
    markSendFailed("c2", "SLOW_MODE");

    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    const msgs = getChannelMessages(1);
    expect(msgs.map((m) => m.correlationId)).toEqual([null, null, null, "c1", "c2"]);
    expect(msgs[3]!.status).toBe("pending");
    expect(msgs[4]!.status).toBe("failed");
  });
});

describe("live messages while detached", () => {
  it("does not append a broadcast onto a detached window", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    addMessage(broadcast(900));

    // Appending would splice a message from "now" directly onto history from
    // an hour ago with no gap shown — a lie about ordering.
    expect(ids(1)).toEqual([10, 11, 12]);
  });

  it("still reconciles an edit-shaped rebroadcast of a loaded row", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    addMessage({ ...broadcast(11), content: "reconciled" });

    expect(ids(1)).toEqual([10, 11, 12]);
    expect(getChannelMessages(1)[1]!.content).toBe("reconciled");
  });

  it("appends normally again once reattached", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);
    reattachToPresent(1);
    setMessages(1, [response(12), response(11), response(10)], false);

    addMessage(broadcast(900));

    expect(ids(1)).toEqual([10, 11, 12, 900]);
  });
});

describe("reattachToPresent", () => {
  it("clears the detached flag and the loaded flag so the tail is refetched", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);
    expect(isChannelLoaded(1)).toBe(true);

    reattachToPresent(1);

    expect(isWindowDetached(1)).toBe(false);
    // Without clearing "loaded", MessageController short-circuits and the
    // stale window stays on screen forever.
    expect(isChannelLoaded(1)).toBe(false);
  });

  it("is a no-op for a channel that was never detached", () => {
    setMessages(1, [response(10)], false);
    const before = messagesStore.getState();

    reattachToPresent(1);

    expect(messagesStore.getState()).toBe(before);
    expect(isChannelLoaded(1)).toBe(true);
  });
});

describe("reattaching via a fresh tail fetch", () => {
  it("setMessages clears the detached flag", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    setMessages(1, [response(902), response(901)], true);

    expect(isWindowDetached(1)).toBe(false);
    expect(ids(1)).toEqual([901, 902]);
  });

  it("clearChannelMessages clears the detached flag", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    clearChannelMessages(1);

    expect(isWindowDetached(1)).toBe(false);
  });

  it("scrolling further up a detached window keeps it detached", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    // prependMessages is the infinite-scroll path; it touches history above
    // the window and says nothing about the tail below it.
    prependMessages(1, [response(9), response(8)], true);

    expect(ids(1)).toEqual([8, 9, 10, 11, 12]);
    expect(isWindowDetached(1)).toBe(true);
  });
});

describe("prependMessages at the message cap", () => {
  it("keeps the fetched older page and detaches instead of discarding it", () => {
    // Fill to the 500-row cap: ids 101..600 (history endpoint is newest-first).
    const initial: MessageResponse[] = [];
    for (let id = 600; id >= 101; id--) initial.push(response(id));
    setMessages(1, initial, true);
    expect(getChannelMessages(1)).toHaveLength(500);

    prependMessages(1, [response(100), response(99)], false);

    const loaded = getChannelMessages(1);
    expect(loaded).toHaveLength(500);
    // The fetched page must survive at the head — trimming it away would make
    // every scroll-up fetch at the cap a silent no-op that refetches forever.
    expect(loaded[0]!.id).toBe(99);
    expect(loaded[1]!.id).toBe(100);
    // The live tail was dropped instead, so the window is detached and the
    // "Jump to Present" pill restores it.
    expect(isWindowDetached(1)).toBe(true);
    // Nothing above was dropped, so "more above" is what the server said.
    expect(hasMoreMessages(1)).toBe(false);
  });
});

describe("hasMessageLoaded", () => {
  it("reports membership of the loaded window", () => {
    setAroundMessages(1, ascendingWindow(10, 12), true, true);

    expect(hasMessageLoaded(1, 11)).toBe(true);
    expect(hasMessageLoaded(1, 900)).toBe(false);
    expect(hasMessageLoaded(2, 11)).toBe(false);
  });
});
