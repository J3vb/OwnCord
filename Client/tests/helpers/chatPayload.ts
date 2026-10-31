import type { ChatMessagePayload } from "../../src/lib/types";

/** A chat_message payload from TestUser in channel 1; `overrides` win. */
export function makePayload(overrides: Partial<ChatMessagePayload> = {}): ChatMessagePayload {
  return {
    id: 1,
    channel_id: 1,
    user: { id: 2, username: "TestUser", avatar: null },
    content: "Hello world",
    reply_to: null,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  } as ChatMessagePayload;
}
