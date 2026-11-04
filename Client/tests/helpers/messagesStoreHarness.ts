import { expect } from "vitest";
import {
  messagesStore,
  confirmSend,
  addOptimisticMessage,
  markSendFailed,
  updateReaction,
  getChannelMessages,
} from "../../src/stores/messages.store";
import type {
  ChatMessagePayload,
  MessageResponse,
  MessageUser,
  Attachment,
} from "../../src/lib/types";

// addPendingSend and clearChannelMessages were removed from the store (dead
// exports, zero src callers); tests keep using the identical observable-state
// writes via setState.
export function addPendingSend(correlationId: string, channelId: number): void {
  messagesStore.setState((prev) => ({
    ...prev,
    pendingSends: new Map(prev.pendingSends).set(correlationId, channelId),
  }));
}

export function clearChannelMessages(channelId: number): void {
  messagesStore.setState((prev) => {
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.delete(channelId);
    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.delete(channelId);
    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.delete(channelId);
    const updatedLoadState = new Map(prev.historyLoadState);
    updatedLoadState.delete(channelId);
    const updatedDetached = new Set(prev.detachedChannels);
    updatedDetached.delete(channelId);
    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
      historyLoadState: updatedLoadState,
      detachedChannels: updatedDetached,
    };
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

export const TEST_USER: MessageUser = {
  id: 1,
  username: "alice",
  avatar: "alice.png",
};

export const TEST_USER_2: MessageUser = {
  id: 2,
  username: "bob",
  avatar: null,
};

export const ATTACHMENT: Attachment = {
  id: "att-1",
  filename: "screenshot.png",
  size: 1024,
  mime: "image/png",
  url: "/uploads/screenshot.png",
};

export function makeChatPayload(overrides?: Partial<ChatMessagePayload>): ChatMessagePayload {
  return {
    id: 100,
    channel_id: 1,
    user: TEST_USER,
    content: "Hello world",
    reply_to: null,
    attachments: [],
    timestamp: "2026-03-15T10:00:00Z",
    ...overrides,
  };
}

export function makeMessageResponse(overrides?: Partial<MessageResponse>): MessageResponse {
  return {
    id: 200,
    channel_id: 1,
    user: TEST_USER,
    content: "REST message",
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

// ---------------------------------------------------------------------------
// Reset helper — clears all channels we might have touched
// ---------------------------------------------------------------------------

export function resetStore(): void {
  clearChannelMessages(1);
  clearChannelMessages(2);
  clearChannelMessages(99);
  // Clear any leftover pending sends by confirming them
  const pending = messagesStore.getState().pendingSends;
  for (const [corrId] of pending) {
    confirmSend(corrId, 0, "");
  }
}

/** Adds one in-flight row ("c1") and one refused row ("c2") to channel 1. */
export function addPendingAndFailedRows(failureCode: string): void {
  addOptimisticMessage({
    correlationId: "c1",
    channelId: 1,
    user: TEST_USER,
    content: "in flight",
    replyTo: null,
    timestamp: "2026-03-15T10:00:00Z",
  });
  addOptimisticMessage({
    correlationId: "c2",
    channelId: 1,
    user: TEST_USER,
    content: "refused",
    replyTo: null,
    timestamp: "2026-03-15T10:00:01Z",
  });
  markSendFailed("c2", failureCode);
}

/** updateReaction with the payload spelled out positionally. */
export function react(
  messageId: number,
  channelId: number,
  emoji: string,
  userId: number,
  action: "add" | "remove",
  currentUserId: number,
): void {
  updateReaction(
    { message_id: messageId, channel_id: channelId, emoji, user_id: userId, action },
    currentUserId,
  );
}

/** Newest-first page of ids [from, to], as the REST API returns it. */
export function newestFirstPage(from: number, to: number): MessageResponse[] {
  const out: MessageResponse[] = [];
  for (let id = to; id >= from; id--) out.push(makeMessageResponse({ id, content: `m${id}` }));
  return out;
}

/** Channel 1 holds exactly one message: the sent one with `id`. */
export function expectOnlySentMessage(id: number): void {
  const msgs = getChannelMessages(1);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.id).toBe(id);
  expect(msgs[0]!.status).toBe("sent");
}

/** Channel 1 holds the loaded row, then "c1" pending and "c2" failed. */
export function expectLoadedPendingFailed(): void {
  const msgs = getChannelMessages(1);
  expect(msgs.map((m) => m.correlationId)).toEqual([null, "c1", "c2"]);
  expect(msgs[1]!.status).toBe("pending");
  expect(msgs[2]!.status).toBe("failed");
}
