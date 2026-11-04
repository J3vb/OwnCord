import type { Message } from "@stores/messages.store";
import type { ChatMessagePayload, MessageResponse } from "@lib/types";

/**
 * A sent text message with every field filled in. `defaults` replaces the
 * base values a suite wants as its own norm (its channel, author or clock);
 * `overrides` is what one test changes and always wins.
 */
export function buildMessage(
  overrides: Partial<Message> & { id: number },
  defaults: Partial<Message> = {},
): Message {
  return {
    channelId: 1,
    user: { id: 1, username: "Alice", avatar: null },
    content: `Message ${overrides.id}`,
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
    ...defaults,
    ...overrides,
  };
}

/** A history-endpoint message from alice in channel 1 whose content is `msg <id>`. */
export function buildResponse(
  id: number,
  overrides: Partial<MessageResponse> = {},
): MessageResponse {
  return {
    id,
    channel_id: 1,
    user: { id: 1, username: "alice", avatar: null },
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

/** A live chat broadcast from alice in channel 1 whose content is `live <id>`. */
export function buildBroadcast(id: number): ChatMessagePayload {
  return {
    id,
    channel_id: 1,
    user: { id: 1, username: "alice", avatar: null },
    content: `live ${id}`,
    reply_to: null,
    attachments: [],
    timestamp: "2026-03-15T12:00:00Z",
  } as ChatMessagePayload;
}

/** Ten minutes apart on one UTC day, past the 7-minute group window, so rows never group. */
export function spacedTimestamp(id: number): string {
  return new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString();
}

/** buildMessage with a spacedTimestamp for its id, so rows never group; `defaults` still wins over it. */
export function spacedMessage(
  overrides: Partial<Message> & { id: number },
  defaults: Partial<Message> = {},
): Message {
  return buildMessage(overrides, { timestamp: spacedTimestamp(overrides.id), ...defaults });
}

/** buildMessage whose timestamp is `id` minutes past 12:00 on 2024-01-15, so ids order rows in time. */
export function buildMinuteMessage(overrides: Partial<Message> & { id: number }): Message {
  return buildMessage(overrides, {
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, overrides.id)).toISOString(),
  });
}
