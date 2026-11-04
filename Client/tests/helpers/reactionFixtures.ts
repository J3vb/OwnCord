import { vi } from "vitest";
import type { Message } from "../../src/stores/messages.store";
import type { MessageListOptions } from "../../src/components/MessageList";

/** A sent message from alice in channel 1 carrying one reaction of `emoji` with count 2. */
export function makeReactionMessage(emoji = "🔥"): Message {
  return {
    id: 1,
    channelId: 1,
    userId: 10,
    username: "alice",
    avatar: null,
    content: "hi",
    timestamp: "2026-01-01T00:00:00Z",
    editedAt: null,
    replyTo: null,
    attachments: [],
    reactions: [{ emoji, count: 2, me: false }],
    pending: false,
    failed: false,
    pinned: false,
  } as unknown as Message;
}

/** List options carrying only a fresh reaction-click spy. */
export function reactionOptions(): MessageListOptions {
  return { onReactionClick: vi.fn() } as unknown as MessageListOptions;
}
