import { messagesStore, confirmSend } from "../../src/stores/messages.store";
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
