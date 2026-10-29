import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addOptimisticMessage,
  appendNewerMessages,
  applyServerMessage,
  bulkDeleteMessages,
  clearChannelContent,
  hasOlderLoadFailed,
  mergeTailMessages,
  messagesStore,
  prependMessages,
  resetMessagesStore,
  rollbackReaction,
  setAroundMessages,
  setMessages,
  setOlderLoadFailed,
} from "@stores/messages.store";
import { threadsStore, resetThreadsStore } from "@stores/threads.store";
import { listSessionResets } from "@lib/sessionRegistry";
import type { MessageResponse, ThreadInfo } from "@lib/types";

const CHANNEL = 4;

function thread(id: number): ThreadInfo {
  return {
    id,
    parent_id: CHANNEL,
    name: `thread ${id}`,
    owner_id: 1,
    starter_message_id: id * 10,
    archived: false,
    locked: false,
    auto_archive_minutes: 1440,
    message_count: 2,
    last_message_at: "2026-03-15T10:05:00Z",
    created_at: "2026-03-15T10:00:00Z",
  };
}

function response(id: number, withThread?: ThreadInfo): MessageResponse {
  return {
    id,
    channel_id: CHANNEL,
    user: { id: 1, username: "alice", avatar: null },
    content: `m${id}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: new Date(Date.UTC(2026, 2, 15, 10, id)).toISOString(),
    ...(withThread === undefined ? {} : { thread: withThread }),
  };
}

function known(threadId: number): boolean {
  return threadsStore.getState().byId.has(threadId);
}

beforeEach(() => {
  resetMessagesStore();
  resetThreadsStore();
});

describe("thread snapshots on fetched rows", () => {
  it("hands a history page's thread rows to the threads store", async () => {
    setMessages(CHANNEL, [response(10, thread(1)), response(9)], false);
    await vi.waitFor(() => expect(known(1)).toBe(true));
  });

  it("hands an around-window's thread rows to the threads store", async () => {
    setAroundMessages(CHANNEL, [response(10, thread(2))], false, false);
    await vi.waitFor(() => expect(known(2)).toBe(true));
  });

  it("hands an older page's thread rows to the threads store", async () => {
    setMessages(CHANNEL, [response(20)], true);
    prependMessages(CHANNEL, [response(10, thread(3))], false);
    await vi.waitFor(() => expect(known(3)).toBe(true));
  });

  it("hands a newer page's thread rows to the threads store", async () => {
    setAroundMessages(CHANNEL, [response(10)], false, true);
    appendNewerMessages(CHANNEL, [response(11, thread(4))], false);
    await vi.waitFor(() => expect(known(4)).toBe(true));
  });

  it("hands a tail merge's thread rows to the threads store", async () => {
    setMessages(CHANNEL, [response(10)], false);
    mergeTailMessages(CHANNEL, [response(11, thread(5))]);
    await vi.waitFor(() => expect(known(5)).toBe(true));
  });

  it("hands a single reconciled row's thread to the threads store", async () => {
    setMessages(CHANNEL, [response(10)], false);
    applyServerMessage(response(10, thread(6)));
    await vi.waitFor(() => expect(known(6)).toBe(true));
  });
});

describe("older-page failure mark", () => {
  it("is cleared by replacing a window around a jump target", () => {
    setOlderLoadFailed(CHANNEL, true);
    expect(hasOlderLoadFailed(CHANNEL)).toBe(true);
    setAroundMessages(CHANNEL, [response(10)], false, false);
    expect(hasOlderLoadFailed(CHANNEL)).toBe(false);
  });

  it("is cleared by forgetting a channel's content", () => {
    setMessages(CHANNEL, [response(10)], true);
    setOlderLoadFailed(CHANNEL, true);
    clearChannelContent(CHANNEL);
    expect(hasOlderLoadFailed(CHANNEL)).toBe(false);
  });

  it("reads as not failed when the state never carried the mark", () => {
    messagesStore.setState((prev) => {
      const { olderLoadFailed: _dropped, ...rest } = prev;
      return rest;
    });
    expect(hasOlderLoadFailed(CHANNEL)).toBe(false);
  });
});

describe("other store writers", () => {
  it("leaves an optimistic row without a sticker key when none was sent", () => {
    addOptimisticMessage({
      correlationId: "c1",
      channelId: CHANNEL,
      user: { id: 1, username: "alice", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });
    const row = messagesStore.getState().messagesByChannel.get(CHANNEL)?.[0];
    expect(row).toBeDefined();
    expect("sticker" in (row ?? {})).toBe(false);
  });

  it("keeps the sticker on an optimistic sticker row", () => {
    addOptimisticMessage({
      correlationId: "c1",
      channelId: CHANNEL,
      user: { id: 1, username: "alice", avatar: null },
      content: ":wave:",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
      sticker: { id: 3, name: "wave", url: "/s/3" },
    });
    expect(messagesStore.getState().messagesByChannel.get(CHANNEL)?.[0]?.sticker).toEqual({
      id: 3,
      name: "wave",
      url: "/s/3",
    });
  });

  it("reports that a correlation id was not a reaction toggle", () => {
    expect(rollbackReaction("never-sent")).toBe(false);
  });

  it("leaves the state alone for a purge with no ids", () => {
    setMessages(CHANNEL, [response(10)], false);
    const before = messagesStore.getState();
    bulkDeleteMessages({ channel_id: CHANNEL, ids: [] });
    expect(messagesStore.getState()).toBe(before);
  });

  it("is registered to run on sign-out", () => {
    expect(listSessionResets()).toContain("messages:store");
  });
});
