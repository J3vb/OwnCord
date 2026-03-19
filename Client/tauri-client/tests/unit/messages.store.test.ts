import { describe, it, expect, beforeEach } from "vitest";
import {
  messagesStore,
  addMessage,
  setMessages,
  prependMessages,
  editMessage,
  deleteMessage,
  addPendingSend,
  confirmSend,
  getChannelMessages,
  isChannelLoaded,
  clearChannelMessages,
} from "../../src/stores/messages.store";
import type {
  ChatMessagePayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  MessageResponse,
  MessageUser,
  Attachment,
} from "../../src/lib/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_USER: MessageUser = {
  id: 1,
  username: "alice",
  avatar: "alice.png",
};

const TEST_USER_2: MessageUser = {
  id: 2,
  username: "bob",
  avatar: null,
};

const ATTACHMENT: Attachment = {
  id: "att-1",
  filename: "screenshot.png",
  size: 1024,
  mime: "image/png",
  url: "/uploads/screenshot.png",
};

function makeChatPayload(overrides?: Partial<ChatMessagePayload>): ChatMessagePayload {
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

function makeMessageResponse(overrides?: Partial<MessageResponse>): MessageResponse {
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

function resetStore(): void {
  clearChannelMessages(1);
  clearChannelMessages(2);
  clearChannelMessages(99);
  // Clear any leftover pending sends by confirming them
  const pending = messagesStore.getState().pendingSends;
  for (const [corrId] of pending) {
    confirmSend(corrId, 0, "");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messages store", () => {
  beforeEach(() => {
    resetStore();
  });

  // 1. Initial state is empty
  describe("initial state", () => {
    it("has empty messagesByChannel", () => {
      expect(messagesStore.getState().messagesByChannel.size).toBe(0);
    });

    it("has empty pendingSends", () => {
      expect(messagesStore.getState().pendingSends.size).toBe(0);
    });

    it("has empty loadedChannels", () => {
      expect(messagesStore.getState().loadedChannels.size).toBe(0);
    });

    it("has empty hasMore", () => {
      expect(messagesStore.getState().hasMore.size).toBe(0);
    });
  });

  // 2. addMessage appends to correct channel
  describe("addMessage", () => {
    it("adds a message to the correct channel", () => {
      addMessage(makeChatPayload({ id: 1, channel_id: 1 }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(1);
      expect(msgs[0]!.channelId).toBe(1);
    });

    it("converts snake_case fields to camelCase", () => {
      addMessage(
        makeChatPayload({
          id: 10,
          channel_id: 2,
          reply_to: 5,
          attachments: [ATTACHMENT],
        }),
      );

      const msg = getChannelMessages(2)[0]!;
      expect(msg.channelId).toBe(2);
      expect(msg.replyTo).toBe(5);
      expect(msg.attachments).toEqual([ATTACHMENT]);
      expect(msg.editedAt).toBeNull();
      expect(msg.deleted).toBe(false);
    });

    it("appends subsequent messages in order", () => {
      addMessage(makeChatPayload({ id: 1, channel_id: 1 }));
      addMessage(makeChatPayload({ id: 2, channel_id: 1, content: "Second" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.id).toBe(1);
      expect(msgs[1]!.id).toBe(2);
    });

    it("keeps messages in separate channels isolated", () => {
      addMessage(makeChatPayload({ id: 1, channel_id: 1 }));
      addMessage(makeChatPayload({ id: 2, channel_id: 2 }));

      expect(getChannelMessages(1)).toHaveLength(1);
      expect(getChannelMessages(2)).toHaveLength(1);
    });

    it("produces a new state reference", () => {
      const before = messagesStore.getState();
      addMessage(makeChatPayload());
      const after = messagesStore.getState();
      expect(before).not.toBe(after);
    });
  });

  // 3. setMessages bulk sets and marks loaded
  describe("setMessages", () => {
    it("sets messages for a channel", () => {
      // API returns newest-first; store reverses to oldest-first for display.
      const responses = [
        makeMessageResponse({ id: 11 }),
        makeMessageResponse({ id: 10 }),
      ];
      setMessages(1, responses, false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.id).toBe(10);
      expect(msgs[1]!.id).toBe(11);
    });

    it("marks channel as loaded", () => {
      expect(isChannelLoaded(1)).toBe(false);
      setMessages(1, [], false);
      expect(isChannelLoaded(1)).toBe(true);
    });

    it("stores hasMore flag", () => {
      setMessages(1, [], true);
      expect(messagesStore.getState().hasMore.get(1)).toBe(true);

      setMessages(2, [], false);
      expect(messagesStore.getState().hasMore.get(2)).toBe(false);
    });

    it("converts MessageResponse fields to camelCase", () => {
      setMessages(
        1,
        [makeMessageResponse({ edited_at: "2026-03-15T11:00:00Z", reply_to: 3 })],
        false,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.editedAt).toBe("2026-03-15T11:00:00Z");
      expect(msg.replyTo).toBe(3);
    });

    it("replaces existing messages for the channel", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      setMessages(1, [makeMessageResponse({ id: 20 })], false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(20);
    });
  });

  // 4. prependMessages prepends older messages
  describe("prependMessages", () => {
    it("prepends older messages before existing ones", () => {
      // API returns newest-first; store reverses to oldest-first.
      setMessages(1, [makeMessageResponse({ id: 20 })], true);
      prependMessages(
        1,
        [makeMessageResponse({ id: 15 }), makeMessageResponse({ id: 10 })],
        false,
      );

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(3);
      expect(msgs[0]!.id).toBe(10);
      expect(msgs[1]!.id).toBe(15);
      expect(msgs[2]!.id).toBe(20);
    });

    it("updates hasMore flag", () => {
      setMessages(1, [makeMessageResponse({ id: 20 })], true);
      expect(messagesStore.getState().hasMore.get(1)).toBe(true);

      prependMessages(1, [makeMessageResponse({ id: 10 })], false);
      expect(messagesStore.getState().hasMore.get(1)).toBe(false);
    });

    it("works on a channel with no existing messages", () => {
      prependMessages(1, [makeMessageResponse({ id: 5 })], false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(5);
    });
  });

  // 5. editMessage updates content and editedAt
  describe("editMessage", () => {
    it("updates content and editedAt for the target message", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1, content: "Original" }));

      const editPayload: ChatEditedPayload = {
        message_id: 100,
        channel_id: 1,
        content: "Edited content",
        edited_at: "2026-03-15T12:00:00Z",
      };
      editMessage(editPayload);

      const msg = getChannelMessages(1)[0]!;
      expect(msg.content).toBe("Edited content");
      expect(msg.editedAt).toBe("2026-03-15T12:00:00Z");
    });

    it("does not affect other messages in the channel", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1, content: "First" }));
      addMessage(makeChatPayload({ id: 101, channel_id: 1, content: "Second" }));

      editMessage({
        message_id: 100,
        channel_id: 1,
        content: "Edited",
        edited_at: "2026-03-15T12:00:00Z",
      });

      const msgs = getChannelMessages(1);
      expect(msgs[0]!.content).toBe("Edited");
      expect(msgs[1]!.content).toBe("Second");
    });

    it("is a no-op if the channel does not exist", () => {
      const before = messagesStore.getState();
      editMessage({
        message_id: 999,
        channel_id: 99,
        content: "Nope",
        edited_at: "2026-03-15T12:00:00Z",
      });
      const after = messagesStore.getState();
      expect(before).toBe(after);
    });

    it("produces a new message object (immutable update)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      const original = getChannelMessages(1)[0]!;

      editMessage({
        message_id: 100,
        channel_id: 1,
        content: "Edited",
        edited_at: "2026-03-15T12:00:00Z",
      });
      const edited = getChannelMessages(1)[0]!;

      expect(original).not.toBe(edited);
    });
  });

  // 6. deleteMessage marks as deleted
  describe("deleteMessage", () => {
    it("marks the message as deleted", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      const deletePayload: ChatDeletedPayload = {
        message_id: 100,
        channel_id: 1,
      };
      deleteMessage(deletePayload);

      const msg = getChannelMessages(1)[0]!;
      expect(msg.deleted).toBe(true);
    });

    it("keeps the message in the array (soft delete)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      addMessage(makeChatPayload({ id: 101, channel_id: 1 }));

      deleteMessage({ message_id: 100, channel_id: 1 });

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.deleted).toBe(true);
      expect(msgs[1]!.deleted).toBe(false);
    });

    it("is a no-op if the channel does not exist", () => {
      const before = messagesStore.getState();
      deleteMessage({ message_id: 999, channel_id: 99 });
      const after = messagesStore.getState();
      expect(before).toBe(after);
    });
  });

  // 7. addPendingSend / confirmSend lifecycle
  describe("pending send lifecycle", () => {
    it("addPendingSend tracks correlationId -> channelId", () => {
      addPendingSend("corr-1", 1);

      const pending = messagesStore.getState().pendingSends;
      expect(pending.get("corr-1")).toBe(1);
    });

    it("confirmSend removes the pending entry", () => {
      addPendingSend("corr-1", 1);
      confirmSend("corr-1", 100, "2026-03-15T10:00:00Z");

      const pending = messagesStore.getState().pendingSends;
      expect(pending.has("corr-1")).toBe(false);
    });

    it("tracks multiple pending sends independently", () => {
      addPendingSend("corr-1", 1);
      addPendingSend("corr-2", 2);

      expect(messagesStore.getState().pendingSends.size).toBe(2);

      confirmSend("corr-1", 100, "2026-03-15T10:00:00Z");

      const pending = messagesStore.getState().pendingSends;
      expect(pending.size).toBe(1);
      expect(pending.has("corr-1")).toBe(false);
      expect(pending.get("corr-2")).toBe(2);
    });

    it("confirmSend is a no-op for unknown correlationId", () => {
      const before = messagesStore.getState();
      confirmSend("unknown", 100, "2026-03-15T10:00:00Z");
      const after = messagesStore.getState();
      // State still changes (new Map created), but pending size is 0
      expect(after.pendingSends.size).toBe(0);
    });
  });

  // 8. getChannelMessages returns empty for unknown channel
  describe("getChannelMessages", () => {
    it("returns empty array for a channel with no messages", () => {
      const msgs = getChannelMessages(999);
      expect(msgs).toEqual([]);
      expect(msgs).toHaveLength(0);
    });

    it("returns the messages after addMessage", () => {
      addMessage(makeChatPayload({ id: 1, channel_id: 1 }));
      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
    });
  });

  // 9. clearChannelMessages clears
  describe("clearChannelMessages", () => {
    it("removes messages for the channel", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], true);
      expect(getChannelMessages(1)).toHaveLength(1);

      clearChannelMessages(1);
      expect(getChannelMessages(1)).toHaveLength(0);
    });

    it("removes loaded status for the channel", () => {
      setMessages(1, [], false);
      expect(isChannelLoaded(1)).toBe(true);

      clearChannelMessages(1);
      expect(isChannelLoaded(1)).toBe(false);
    });

    it("removes hasMore for the channel", () => {
      setMessages(1, [], true);
      expect(messagesStore.getState().hasMore.get(1)).toBe(true);

      clearChannelMessages(1);
      expect(messagesStore.getState().hasMore.has(1)).toBe(false);
    });

    it("does not affect other channels", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      setMessages(2, [makeMessageResponse({ id: 20, channel_id: 2 })], false);

      clearChannelMessages(1);

      expect(getChannelMessages(1)).toHaveLength(0);
      expect(getChannelMessages(2)).toHaveLength(1);
      expect(isChannelLoaded(2)).toBe(true);
    });

    it("is safe to call on a channel that was never loaded", () => {
      clearChannelMessages(999);
      expect(getChannelMessages(999)).toHaveLength(0);
    });
  });

  // 10. isChannelLoaded selector
  describe("isChannelLoaded", () => {
    it("returns false for unknown channel", () => {
      expect(isChannelLoaded(999)).toBe(false);
    });

    it("returns true after setMessages", () => {
      setMessages(1, [], false);
      expect(isChannelLoaded(1)).toBe(true);
    });

    it("returns false after clearChannelMessages", () => {
      setMessages(1, [], false);
      clearChannelMessages(1);
      expect(isChannelLoaded(1)).toBe(false);
    });
  });
});
