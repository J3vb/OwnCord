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

describe("group_event (WP 3B-11a)", () => {
  it("carries a group row's kind and group_event from a live broadcast and from history", () => {
    const base: ChatMessagePayload = {
      id: 9,
      channel_id: 3,
      user,
      content: "bob added carol to the group",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
      kind: "group_add",
      group_event: { target_user_id: 5 },
    };
    expect(chatPayloadToMessage(base)).toMatchObject({
      kind: "group_add",
      groupEvent: { target_user_id: 5 },
    });
    expect(
      chatPayloadToMessage({ ...base, kind: "group_rename", group_event: { name: "" } }),
    ).toMatchObject({ kind: "group_rename", groupEvent: { name: "" } });
    const response: MessageResponse = {
      id: 9,
      channel_id: 3,
      user,
      content: "x",
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned: false,
      edited_at: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
      kind: "group_icon",
      group_event: { icon_removed: true },
    };
    expect(messageResponseToMessage(response)).toMatchObject({
      kind: "group_icon",
      groupEvent: { icon_removed: true },
    });
  });

  it("leaves an ordinary message without the field", () => {
    const m = chatPayloadToMessage({
      id: 1,
      channel_id: 3,
      user,
      content: "hi",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });
    expect("groupEvent" in m).toBe(false);
    expect("kind" in m).toBe(false);
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
      "messagePinRevision",
      "messagesByChannel",
      "olderLoadFailed",
      "pendingReactions",
      "pendingSends",
      "pinRevision",
    ]);
  });

  it("caps a channel at 500 rows", () => {
    expect(MAX_MESSAGES_PER_CHANNEL).toBe(500);
  });
});

describe("reply snippet (referenced_message)", () => {
  const ref = {
    id: 5,
    user: { id: 1, username: "al", avatar: null },
    content: "parent",
    deleted: false,
    has_attachments: false,
  };

  it("carries the snippet from a live frame and a history row", () => {
    const live: ChatMessagePayload = {
      id: 7,
      channel_id: 3,
      user,
      content: "hi",
      reply_to: 5,
      referenced_message: ref,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    };
    expect(chatPayloadToMessage(live).referencedMessage).toStrictEqual(ref);

    const history: MessageResponse = {
      id: 8,
      channel_id: 3,
      user,
      content: "hi",
      reply_to: 5,
      referenced_message: ref,
      attachments: [],
      reactions: [],
      pinned: false,
      edited_at: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
    };
    expect(messageResponseToMessage(history).referencedMessage).toStrictEqual(ref);
  });

  it("leaves the field off when an older server omits it", () => {
    const live: ChatMessagePayload = {
      id: 7,
      channel_id: 3,
      user,
      content: "hi",
      reply_to: 5,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    };
    expect("referencedMessage" in chatPayloadToMessage(live)).toBe(false);
  });
});

describe("call log rows (WP 3B-9c)", () => {
  const call = { started_at: "2026-03-15 10:00:00", ended_at: null, participants: [2] };

  it("carries kind and call from a live chat_message", () => {
    const row = chatPayloadToMessage({
      id: 7,
      channel_id: 3,
      user,
      content: "started a call.",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
      kind: "call",
      call,
    });
    expect(row).toMatchObject({ kind: "call", call });
  });

  it("carries kind and call from the history mapper, and omits both for an ordinary row", () => {
    const base: MessageResponse = {
      id: 8,
      channel_id: 4,
      user,
      content: "x",
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned: false,
      edited_at: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
    };
    expect(messageResponseToMessage({ ...base, kind: "call", call })).toMatchObject({
      kind: "call",
      call,
    });
    const plain = messageResponseToMessage(base);
    expect("kind" in plain).toBe(false);
    expect("call" in plain).toBe(false);
  });
});
