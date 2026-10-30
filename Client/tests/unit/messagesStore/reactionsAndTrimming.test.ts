import { describe, it, expect, beforeEach } from "vitest";
import {
  messagesStore,
  addMessage,
  setMessages,
  prependMessages,
  editMessage,
  deleteMessage,
  updateReaction,
  addOptimisticReaction,
  rollbackReaction,
  confirmSend,
  addOptimisticMessage,
  markSendFailed,
  getChannelMessages,
  hasMoreMessages,
  isWindowDetached,
} from "../../../src/stores/messages.store";
import type { ReactionUpdatePayload, MessageResponse } from "../../../src/lib/types";
import {
  TEST_USER,
  makeChatPayload,
  makeMessageResponse,
  resetStore,
} from "../../helpers/messagesStoreHarness";

describe("stable logical send reconciliation", () => {
  beforeEach(() => resetStore());
  const logicalId = "1773568800000:85c9cd7e-3f19-4dce-9ee1-2a3d49e2fca0";
  function optimistic(correlationId = "first-attempt") {
    addOptimisticMessage({
      correlationId,
      clientMessageId: logicalId,
      channelId: 1,
      user: TEST_USER,
      content: "same text",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });
  }

  it("does not mistake identical text from another device for this send", () => {
    optimistic();
    addMessage(makeChatPayload({ content: "same text", client_message_id: `${logicalId}other` }));
    expect(getChannelMessages(1)).toHaveLength(2);
    expect(getChannelMessages(1).filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("reconciles the exact echo even after timeout, with sanitized content", () => {
    optimistic();
    markSendFailed("first-attempt", "UNCONFIRMED");
    addMessage(makeChatPayload({ content: "sanitized text", client_message_id: logicalId }));
    expect(getChannelMessages(1)).toHaveLength(1);
    expect(getChannelMessages(1)[0]).toMatchObject({
      id: 100,
      status: "sent",
      content: "sanitized text",
    });
    expect(messagesStore.getState().pendingSends.size).toBe(0);
  });

  it("a late ACK reconciles the newer retry by logical identity", () => {
    optimistic("second-attempt");
    confirmSend("first-attempt", 100, "2026-03-15T10:00:00Z", logicalId);
    expect(getChannelMessages(1)).toHaveLength(1);
    expect(getChannelMessages(1)[0]).toMatchObject({ id: 100, status: "sent" });
    expect(messagesStore.getState().pendingSends.size).toBe(0);
  });

  it("one logical send stays one row even if Retry was clicked twice before repaint", () => {
    optimistic("second-attempt");
    optimistic("third-attempt");
    confirmSend("third-attempt", 100, "2026-03-15T10:00:00Z", logicalId);
    expect(getChannelMessages(1)).toHaveLength(1);
    expect(messagesStore.getState().pendingSends.size).toBe(0);
  });

  it("retry ACK removes the recovered row when history already has the committed message", () => {
    optimistic("recovered-attempt");
    markSendFailed("recovered-attempt", "RECOVERED");
    setMessages(1, [makeMessageResponse({ id: 100, content: "edited on another device" })], false);
    expect(getChannelMessages(1)).toHaveLength(2);
    confirmSend("recovered-attempt", 100, "2026-03-15T10:00:00Z", logicalId);
    expect(getChannelMessages(1)).toHaveLength(1);
    expect(getChannelMessages(1)[0]).toMatchObject({
      id: 100,
      content: "edited on another device",
      status: "sent",
    });
  });

  it("the live echo also consumes the pending twin when history won the race", () => {
    optimistic();
    setMessages(1, [makeMessageResponse({ id: 100, content: "same text" })], false);
    expect(getChannelMessages(1)).toHaveLength(2);
    addMessage(makeChatPayload({ id: 100, content: "same text", client_message_id: logicalId }));
    expect(getChannelMessages(1)).toHaveLength(1);
    expect(getChannelMessages(1)[0]).toMatchObject({ id: 100, status: "sent" });
    expect(messagesStore.getState().pendingSends.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messages store", () => {
  beforeEach(() => {
    resetStore();
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

    it("does not duplicate a carried optimistic row that already fell within the kept head on overflow", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "p1",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      addOptimisticMessage({
        correlationId: "c2",
        channelId: 1,
        user: TEST_USER,
        content: "p2",
        replyTo: null,
        timestamp: "2026-03-15T10:00:01Z",
      });
      addOptimisticMessage({
        correlationId: "c3",
        channelId: 1,
        user: TEST_USER,
        content: "p3",
        replyTo: null,
        timestamp: "2026-03-15T10:00:02Z",
      });

      // 498 fresh + 3 already-pending rows = 501: the overflow (1) is smaller
      // than the trailing pending run (3), so the split falls INSIDE that
      // run -- two of the three pending rows land in the kept head and only
      // the third is pushed into the carried tail.
      const older: MessageResponse[] = [];
      for (let i = 498; i >= 1; i--) {
        older.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      prependMessages(1, older, false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(501);
      expect(msgs.map((m) => m.correlationId).filter((c) => c !== null)).toEqual([
        "c1",
        "c2",
        "c3",
      ]);
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
});
