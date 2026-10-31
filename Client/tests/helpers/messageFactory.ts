import type { Message } from "@stores/messages.store";

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
