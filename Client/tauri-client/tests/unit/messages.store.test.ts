import { describe, it, expect, beforeEach } from "vitest";
import {
  messagesStore,
  addMessage,
  setMessages,
  prependMessages,
  editMessage,
  deleteMessage,
  bulkDeleteMessages,
  setMessagePinned,
  updateReaction,
  addOptimisticReaction,
  rollbackReaction,
  addPendingSend,
  confirmSend,
  addOptimisticMessage,
  markSendFailed,
  removeOptimistic,
  getChannelMessages,
  isChannelLoaded,
  hasMoreMessages,
  isWindowDetached,
  clearChannelMessages,
  setChannelLoading,
  setChannelLoadError,
  getHistoryLoadState,
} from "../../src/stores/messages.store";
import type {
  ChatMessagePayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  ReactionUpdatePayload,
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
      const responses = [makeMessageResponse({ id: 11 }), makeMessageResponse({ id: 10 })];
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

    it("keeps a newer live broadcast that landed while the history fetch was in flight", () => {
      // The broadcast arrives over the open WS after the server ran the GET
      // query but before the response reaches the client.
      addMessage(makeChatPayload({ id: 300, channel_id: 1, content: "live" }));

      setMessages(1, [makeMessageResponse({ id: 201 }), makeMessageResponse({ id: 200 })], false);

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.id)).toEqual([200, 201, 300]);
      expect(msgs[2]!.content).toBe("live");
    });

    it("keeps pending and failed optimistic rows across setMessages", () => {
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
      markSendFailed("c2", "SLOW_MODE");

      setMessages(1, [makeMessageResponse({ id: 200 })], false);

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.correlationId)).toEqual([null, "c1", "c2"]);
      expect(msgs[1]!.status).toBe("pending");
      expect(msgs[2]!.status).toBe("failed");
    });
  });

  // 4. prependMessages prepends older messages
  describe("prependMessages", () => {
    it("prepends older messages before existing ones", () => {
      // API returns newest-first; store reverses to oldest-first.
      setMessages(1, [makeMessageResponse({ id: 20 })], true);
      prependMessages(1, [makeMessageResponse({ id: 15 }), makeMessageResponse({ id: 10 })], false);

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

  // 6b. bulkDeleteMessages (channel purge)
  describe("bulkDeleteMessages", () => {
    it("marks every id as deleted while keeping the rows", () => {
      for (const id of [100, 101, 102]) {
        addMessage(makeChatPayload({ id, channel_id: 1 }));
      }

      bulkDeleteMessages({ channel_id: 1, ids: [102, 101] });

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(3);
      expect(msgs.find((m) => m.id === 102)!.deleted).toBe(true);
      expect(msgs.find((m) => m.id === 101)!.deleted).toBe(true);
      expect(msgs.find((m) => m.id === 100)!.deleted).toBe(false);
    });

    it("ignores ids that are not loaded", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      bulkDeleteMessages({ channel_id: 1, ids: [100, 999] });

      expect(getChannelMessages(1)).toHaveLength(1);
      expect(getChannelMessages(1)[0]!.deleted).toBe(true);
    });

    it("is a no-op for an unknown channel, an empty id list, and a repeat purge", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      bulkDeleteMessages({ channel_id: 1, ids: [100] });

      const before = messagesStore.getState();
      bulkDeleteMessages({ channel_id: 99, ids: [1] });
      bulkDeleteMessages({ channel_id: 1, ids: [] });
      bulkDeleteMessages({ channel_id: 1, ids: [100] });
      expect(messagesStore.getState()).toBe(before);
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

  // 11. hasMoreMessages selector
  describe("hasMoreMessages", () => {
    it("returns false for unknown channel", () => {
      expect(hasMoreMessages(999)).toBe(false);
    });

    it("returns true when hasMore is set", () => {
      setMessages(1, [], true);
      expect(hasMoreMessages(1)).toBe(true);
    });

    it("returns false when hasMore is false", () => {
      setMessages(1, [], false);
      expect(hasMoreMessages(1)).toBe(false);
    });
  });

  // 12. setMessagePinned
  describe("setMessagePinned", () => {
    it("sets a message as pinned", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      expect(getChannelMessages(1)[0]!.pinned).toBe(false);

      setMessagePinned(1, 100, true);

      expect(getChannelMessages(1)[0]!.pinned).toBe(true);
    });

    it("sets a message as unpinned", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      setMessagePinned(1, 100, true);
      expect(getChannelMessages(1)[0]!.pinned).toBe(true);

      setMessagePinned(1, 100, false);

      expect(getChannelMessages(1)[0]!.pinned).toBe(false);
    });

    it("does not affect other messages", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      addMessage(makeChatPayload({ id: 101, channel_id: 1 }));

      setMessagePinned(1, 100, true);

      expect(getChannelMessages(1)[0]!.pinned).toBe(true);
      expect(getChannelMessages(1)[1]!.pinned).toBe(false);
    });

    it("is a no-op if the channel does not exist", () => {
      const before = messagesStore.getState();
      setMessagePinned(99, 100, true);
      const after = messagesStore.getState();
      expect(before).toBe(after);
    });

    it("produces a new message object (immutable update)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      const original = getChannelMessages(1)[0]!;

      setMessagePinned(1, 100, true);
      const updated = getChannelMessages(1)[0]!;

      expect(original).not.toBe(updated);
    });
  });

  // 13. updateReaction
  describe("updateReaction", () => {
    it("adds a new reaction to a message", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      const payload: ReactionUpdatePayload = {
        message_id: 100,
        channel_id: 1,
        emoji: "👍",
        user_id: 2,
        action: "add",
      };
      updateReaction(payload, 1);

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toHaveLength(1);
      expect(msg.reactions[0]).toEqual({ emoji: "👍", count: 1, me: false });
    });

    it("marks reaction as 'me' when current user reacts", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      updateReaction(
        {
          message_id: 100,
          channel_id: 1,
          emoji: "❤️",
          user_id: 1,
          action: "add",
        },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions[0]).toEqual({ emoji: "❤️", count: 1, me: true });
    });

    it("increments count on existing reaction", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      updateReaction(
        {
          message_id: 100,
          channel_id: 1,
          emoji: "👍",
          user_id: 2,
          action: "add",
        },
        1,
      );

      updateReaction(
        {
          message_id: 100,
          channel_id: 1,
          emoji: "👍",
          user_id: 3,
          action: "add",
        },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toHaveLength(1);
      expect(msg.reactions[0]!.count).toBe(2);
    });

    it("sets me=true when incrementing existing reaction by current user", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      updateReaction(
        {
          message_id: 100,
          channel_id: 1,
          emoji: "👍",
          user_id: 2,
          action: "add",
        },
        1,
      );

      updateReaction(
        {
          message_id: 100,
          channel_id: 1,
          emoji: "👍",
          user_id: 1,
          action: "add",
        },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions[0]!.me).toBe(true);
    });

    it("removes a reaction (decrements count)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      // Add 2 reactions
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 3, action: "add" }, 1);

      // Remove one
      updateReaction(
        { message_id: 100, channel_id: 1, emoji: "👍", user_id: 3, action: "remove" },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toHaveLength(1);
      expect(msg.reactions[0]!.count).toBe(1);
    });

    it("removes reaction entirely when count reaches 0", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);
      updateReaction(
        { message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "remove" },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toHaveLength(0);
    });

    it("clears 'me' flag when current user removes their reaction", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 1, action: "add" }, 1);
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);
      expect(getChannelMessages(1)[0]!.reactions[0]!.me).toBe(true);

      updateReaction(
        { message_id: 100, channel_id: 1, emoji: "👍", user_id: 1, action: "remove" },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions[0]!.me).toBe(false);
      expect(msg.reactions[0]!.count).toBe(1);
    });

    it("is a no-op if the channel does not exist", () => {
      const before = messagesStore.getState();
      updateReaction(
        { message_id: 999, channel_id: 99, emoji: "👍", user_id: 1, action: "add" },
        1,
      );
      const after = messagesStore.getState();
      expect(before).toBe(after);
    });

    it("does not affect other messages in the channel", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      addMessage(makeChatPayload({ id: 101, channel_id: 1 }));

      updateReaction({ message_id: 100, channel_id: 1, emoji: "🎉", user_id: 2, action: "add" }, 1);

      const msgs = getChannelMessages(1);
      expect(msgs[0]!.reactions).toHaveLength(1);
      expect(msgs[1]!.reactions).toHaveLength(0);
    });

    it("preserves 'me' when another user removes (not current user)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 1, action: "add" }, 1);
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);
      updateReaction(
        { message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "remove" },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions[0]!.me).toBe(true);
      expect(msg.reactions[0]!.count).toBe(1);
    });

    it("preserves other emoji reactions when incrementing one (non-matching branch)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      // Add two different emoji reactions
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);
      updateReaction({ message_id: 100, channel_id: 1, emoji: "❤️", user_id: 3, action: "add" }, 1);

      // Increment only 👍 — the ❤️ reaction should remain unchanged
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 4, action: "add" }, 1);

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toHaveLength(2);
      const thumbs = msg.reactions.find((r) => r.emoji === "👍");
      const heart = msg.reactions.find((r) => r.emoji === "❤️");
      expect(thumbs!.count).toBe(2);
      expect(heart!.count).toBe(1);
    });

    it("preserves other emoji reactions when removing one (non-matching branch)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      // Add two different reactions
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);
      updateReaction({ message_id: 100, channel_id: 1, emoji: "❤️", user_id: 3, action: "add" }, 1);

      // Remove 👍 — ❤️ should remain unchanged
      updateReaction(
        { message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "remove" },
        1,
      );

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toHaveLength(1);
      expect(msg.reactions[0]!.emoji).toBe("❤️");
      expect(msg.reactions[0]!.count).toBe(1);
    });
  });

  // 13b. optimistic reactions (ux/messaging §5)
  describe("optimistic reactions", () => {
    const toggle = (action: "add" | "remove") => ({
      channelId: 1,
      messageId: 100,
      emoji: "👍",
      action,
    });

    it("applies an optimistic add immediately as the current user's pill", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      addOptimisticReaction("corr-1", toggle("add"));

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toEqual([{ emoji: "👍", count: 1, me: true }]);
    });

    it("consumes the self-echo instead of double-counting it", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      addOptimisticReaction("corr-1", toggle("add"));

      // The server broadcasts the toggle back to its sender too.
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 1, action: "add" }, 1);

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toEqual([{ emoji: "👍", count: 1, me: true }]);
      expect(messagesStore.getState().pendingReactions?.size).toBe(0);
    });

    it("still applies another user's identical reaction while one is pending", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      addOptimisticReaction("corr-1", toggle("add"));

      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toEqual([{ emoji: "👍", count: 2, me: true }]);
      // The pending toggle is NOT consumed by someone else's echo.
      expect(messagesStore.getState().pendingReactions?.size).toBe(1);
    });

    it("rolls back a failed optimistic add (pill disappears)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      addOptimisticReaction("corr-1", toggle("add"));

      expect(rollbackReaction("corr-1")).toBe(true);

      const msg = getChannelMessages(1)[0]!;
      expect(msg.reactions).toHaveLength(0);
      expect(messagesStore.getState().pendingReactions?.size).toBe(0);
    });

    it("rolls back a failed optimistic remove (pill restored)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      // Someone else's reaction plus mine.
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 2, action: "add" }, 1);
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 1, action: "add" }, 1);

      addOptimisticReaction("corr-1", toggle("remove"));
      expect(getChannelMessages(1)[0]!.reactions).toEqual([{ emoji: "👍", count: 1, me: false }]);

      expect(rollbackReaction("corr-1")).toBe(true);

      expect(getChannelMessages(1)[0]!.reactions).toEqual([{ emoji: "👍", count: 2, me: true }]);
    });

    it("rollback of an unknown correlation id reports false and changes nothing", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      const before = messagesStore.getState();

      expect(rollbackReaction("nope")).toBe(false);

      expect(messagesStore.getState()).toBe(before);
    });

    it("a late error after the echo was consumed cannot roll back (no ghost revert)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      addOptimisticReaction("corr-1", toggle("add"));
      updateReaction({ message_id: 100, channel_id: 1, emoji: "👍", user_id: 1, action: "add" }, 1);

      expect(rollbackReaction("corr-1")).toBe(false);

      expect(getChannelMessages(1)[0]!.reactions).toEqual([{ emoji: "👍", count: 1, me: true }]);
    });

    it("does not register a pending toggle for an unloaded channel", () => {
      addOptimisticReaction("corr-1", { channelId: 99, messageId: 1, emoji: "👍", action: "add" });

      expect(messagesStore.getState().pendingReactions?.size).toBe(0);
    });
  });

  // 14. addMessage eviction beyond MAX_MESSAGES_PER_CHANNEL
  describe("addMessage eviction", () => {
    it("evicts oldest messages when exceeding cap (500)", () => {
      // Pre-load 500 messages using addMessage (since setMessages reverses)
      for (let i = 1; i <= 500; i++) {
        addMessage(makeChatPayload({ id: i, channel_id: 1 }));
      }
      expect(getChannelMessages(1)).toHaveLength(500);

      // Adding one more should evict the oldest
      addMessage(makeChatPayload({ id: 501, channel_id: 1 }));
      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(500);
      expect(msgs[0]!.id).toBe(2); // oldest (id=1) evicted
      expect(msgs[msgs.length - 1]!.id).toBe(501);
    });

    it("sets hasMore to true when eviction occurs", () => {
      for (let i = 1; i <= 500; i++) {
        addMessage(makeChatPayload({ id: i, channel_id: 1 }));
      }

      addMessage(makeChatPayload({ id: 501, channel_id: 1 }));
      expect(hasMoreMessages(1)).toBe(true);
    });
  });

  // 15. setMessages trimming
  describe("setMessages trimming", () => {
    it("trims to MAX_MESSAGES_PER_CHANNEL when receiving more", () => {
      const responses: MessageResponse[] = [];
      for (let i = 1; i <= 510; i++) {
        responses.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      setMessages(1, responses, false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(500);
    });

    it("sets hasMore to true when trimming occurs", () => {
      const responses: MessageResponse[] = [];
      for (let i = 1; i <= 510; i++) {
        responses.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      setMessages(1, responses, false);
      expect(hasMoreMessages(1)).toBe(true);
    });
  });

  // 16. prependMessages trimming
  describe("prependMessages trimming", () => {
    it("trims combined messages to MAX_MESSAGES_PER_CHANNEL", () => {
      // Load 400 messages
      const initial: MessageResponse[] = [];
      for (let i = 101; i <= 500; i++) {
        initial.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      setMessages(1, initial, true);

      // Prepend 200 more
      const older: MessageResponse[] = [];
      for (let i = 1; i <= 200; i++) {
        older.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      prependMessages(1, older, false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(500);
    });

    it("keeps the server's hasMore and detaches when trimming on prepend", () => {
      // Trimming on prepend drops the live tail (rows BELOW the window), not
      // older history, so "more above" stays whatever the server said and the
      // channel becomes a detached window instead.
      const initial: MessageResponse[] = [];
      for (let i = 301; i <= 500; i++) {
        initial.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      setMessages(1, initial, false);

      const older: MessageResponse[] = [];
      for (let i = 1; i <= 400; i++) {
        older.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      prependMessages(1, older, false);

      expect(hasMoreMessages(1)).toBe(false);
      expect(isWindowDetached(1)).toBe(true);
    });
  });

  // 17. editMessage when message ID doesn't match
  describe("editMessage edge cases", () => {
    it("does not modify messages when message ID not found in channel", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1, content: "Original" }));

      editMessage({
        message_id: 999,
        channel_id: 1,
        content: "Should not appear",
        edited_at: "2026-03-15T12:00:00Z",
      });

      const msg = getChannelMessages(1)[0]!;
      expect(msg.content).toBe("Original");
      expect(msg.editedAt).toBeNull();
    });
  });

  // 18. deleteMessage when message ID doesn't match
  describe("deleteMessage edge cases", () => {
    it("does not modify messages when message ID not found in channel", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));

      deleteMessage({ message_id: 999, channel_id: 1 });

      const msg = getChannelMessages(1)[0]!;
      expect(msg.deleted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Optimistic send lifecycle
  // -------------------------------------------------------------------------

  describe("optimistic send", () => {
    it("addOptimisticMessage inserts a pending row and tracks the correlation id", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.status).toBe("pending");
      expect(msgs[0]!.correlationId).toBe("c1");
      expect(msgs[0]!.id).toBe(0);
      expect(messagesStore.getState().pendingSends.get("c1")).toBe(1);
    });

    it("confirmSend then the broadcast reconciles into a single sent message", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      // Ack arrives first (server sends chat_send_ok before the broadcast).
      confirmSend("c1", 555, "2026-03-15T10:00:01Z");
      let msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.status).toBe("sent");
      expect(msgs[0]!.id).toBe(555);
      expect(messagesStore.getState().pendingSends.has("c1")).toBe(false);

      // The broadcast for our own message arrives with the real id → replace,
      // not duplicate, upgrading to the full server row.
      addMessage(makeChatPayload({ id: 555, content: "hi", attachments: [ATTACHMENT] }));
      msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(555);
      expect(msgs[0]!.status).toBe("sent");
      expect(msgs[0]!.correlationId).toBeNull();
      expect(msgs[0]!.attachments).toHaveLength(1);
    });

    it("markSendFailed flips the row to failed with the error code", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "SLOW_MODE");
      const msg = getChannelMessages(1)[0]!;
      expect(msg.status).toBe("failed");
      expect(msg.errorCode).toBe("SLOW_MODE");
      expect(messagesStore.getState().pendingSends.has("c1")).toBe(false);
    });

    it("removeOptimistic drops the row (retry / dismiss)", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      removeOptimistic("c1");
      expect(getChannelMessages(1)).toHaveLength(0);
      expect(messagesStore.getState().pendingSends.has("c1")).toBe(false);
    });

    it("addMessage is idempotent by real id (replay-safe)", () => {
      addMessage(makeChatPayload({ id: 700, content: "once" }));
      addMessage(makeChatPayload({ id: 700, content: "once" }));
      expect(getChannelMessages(1)).toHaveLength(1);
    });

    it("does not consume a pending row for a same-author broadcast with different content", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "mine, still sending",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      // Same author, different content: a replayed message from another
      // session of this account, not the echo of the pending send.
      addMessage(makeChatPayload({ id: 800, user: TEST_USER, content: "from my other device" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs.find((m) => m.correlationId === "c1")!.status).toBe("pending");
      expect(msgs.find((m) => m.id === 800)!.content).toBe("from my other device");
    });

    it("defensively reconciles a broadcast that raced ahead of its ack", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "race",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      // Broadcast arrives before confirmSend; matched by author against the
      // oldest pending row → replaced, not duplicated.
      addMessage(makeChatPayload({ id: 800, user: TEST_USER, content: "race" }));
      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(800);
      expect(msgs[0]!.status).toBe("sent");
    });
  });

  // 10. First-page history load state
  describe("history load state", () => {
    it("is idle (null) by default", () => {
      expect(getHistoryLoadState(1)).toBeNull();
    });

    it("setChannelLoading and setChannelLoadError set the per-channel state", () => {
      setChannelLoading(1);
      expect(getHistoryLoadState(1)).toBe("loading");
      expect(getHistoryLoadState(2)).toBeNull();

      setChannelLoadError(1);
      expect(getHistoryLoadState(1)).toBe("error");
    });

    it("setMessages clears the channel's load state", () => {
      setChannelLoading(1);
      setMessages(1, [makeMessageResponse({ id: 1 })], false);
      expect(getHistoryLoadState(1)).toBeNull();
    });

    it("clearChannelMessages clears the channel's load state", () => {
      setChannelLoadError(1);
      clearChannelMessages(1);
      expect(getHistoryLoadState(1)).toBeNull();
    });
  });
});

describe("mention plumbing", () => {
  it("carries mentions from a chat_message payload onto the store row", () => {
    addMessage({
      id: 1,
      channel_id: 1,
      user: TEST_USER,
      content: "hi @bob @everyone",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
      mentions: [2],
      mentions_everyone: true,
    } as ChatMessagePayload);

    const msg = messagesStore.getState().messagesByChannel.get(1)![0]!;
    expect(msg.mentions).toEqual([2]);
    expect(msg.mentionsEveryone).toBe(true);
  });

  it("leaves them undefined when an older server omits them", () => {
    addMessage({
      id: 1,
      channel_id: 1,
      user: TEST_USER,
      content: "hi",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    } as ChatMessagePayload);

    const msg = messagesStore.getState().messagesByChannel.get(1)![0]!;
    expect(msg.mentions).toBeUndefined();
    expect(msg.mentionsEveryone).toBeUndefined();
  });

  it("replaces mentions on edit — an edit re-resolves but never re-notifies", () => {
    addMessage({
      id: 1,
      channel_id: 1,
      user: TEST_USER,
      content: "hi @bob",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
      mentions: [2],
      mentions_everyone: false,
    } as ChatMessagePayload);

    editMessage({
      message_id: 1,
      channel_id: 1,
      content: "hi @carol",
      edited_at: "2026-03-15T10:01:00Z",
      mentions: [3],
      mentions_everyone: false,
    } as ChatEditedPayload);

    const msg = messagesStore.getState().messagesByChannel.get(1)![0]!;
    expect(msg.mentions).toEqual([3]);
  });
});
