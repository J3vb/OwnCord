import { describe, it, expect } from "vitest";
import {
  chatPayloadToMessage,
  messageResponseToMessage,
  INITIAL_STATE,
  MAX_MESSAGES_PER_CHANNEL,
} from "./messageModel";
import type { ChatMessagePayload, MessageResponse } from "../../lib/types";

const user = { id: 2, username: "bob", avatar: null };

describe("chatPayloadToMessage", () => {
  it("maps a live broadcast to a sent row with no reactions, pin, edit or delete", () => {
    const payload: ChatMessagePayload = {
      id: 7,
      channel_id: 3,
      user,
      content: "hi",
      reply_to: 5,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
      client_message_id: "c-1",
      mentions: [9],
      mentions_everyone: true,
    };
    expect(chatPayloadToMessage(payload)).toStrictEqual({
      id: 7,
      channelId: 3,
      user,
      content: "hi",
      replyTo: 5,
      attachments: [],
      reactions: [],
      pinned: false,
      editedAt: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
      status: "sent",
      correlationId: null,
      clientMessageId: "c-1",
      errorCode: null,
      mentions: [9],
      mentionsEveryone: true,
    });
  });
});

describe("messageResponseToMessage", () => {
  it("keeps the history row's reactions, pin, edit and delete state", () => {
    const reactions = [{ emoji: "👍", count: 2, me: true }];
    const response: MessageResponse = {
      id: 8,
      channel_id: 4,
      user,
      content: "edited",
      reply_to: null,
      attachments: [],
      reactions,
      pinned: true,
      edited_at: "2026-03-15T11:00:00Z",
      deleted: true,
      timestamp: "2026-03-15T10:00:00Z",
      mentions: [1],
      mentions_everyone: false,
    };
    expect(messageResponseToMessage(response)).toStrictEqual({
      id: 8,
      channelId: 4,
      user,
      content: "edited",
      replyTo: null,
      attachments: [],
      reactions,
      pinned: true,
      editedAt: "2026-03-15T11:00:00Z",
      deleted: true,
      timestamp: "2026-03-15T10:00:00Z",
      status: "sent",
      correlationId: null,
      errorCode: null,
      mentions: [1],
      mentionsEveryone: false,
    });
  });
});

describe("INITIAL_STATE", () => {
  it("starts every collection empty", () => {
    for (const value of Object.values(INITIAL_STATE)) {
      expect(value.size).toBe(0);
    }
    expect(Object.keys(INITIAL_STATE).toSorted()).toEqual([
      "detachedChannels",
      "hasMore",
      "historyLoadState",
      "loadWatermark",
      "loadedChannels",
      "messagesByChannel",
      "pendingReactions",
      "pendingSends",
    ]);
  });

  it("caps a channel at 500 rows", () => {
    expect(MAX_MESSAGES_PER_CHANNEL).toBe(500);
  });
});
