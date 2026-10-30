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
  confirmSend,
  addOptimisticMessage,
  markSendFailed,
  getChannelMessages,
  isChannelLoaded,
  hasMoreMessages,
  isWindowDetached,
  setChannelLoading,
  invalidateLoadedMessageWindows,
  channelIdForSend,
  applyServerMessage,
} from "../../../src/stores/messages.store";
import type {
  ChatEditedPayload,
  ChatDeletedPayload,
  MessageResponse,
} from "../../../src/lib/types";
import {
  addPendingSend,
  clearChannelMessages,
  TEST_USER,
  TEST_USER_2,
  ATTACHMENT,
  makeChatPayload,
  makeMessageResponse,
  resetStore,
} from "../../helpers/messagesStoreHarness";

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

    it("dedupes an optimistic row against its own real message after a lost ack + resync", () => {
      // The chat_send_ok ack never arrives (dropped by the same disconnect
      // that forces a resync), so the row is still "pending" when
      // invalidateLoadedMessageWindows carries it through.
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "ok",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      invalidateLoadedMessageWindows();
      expect(getChannelMessages(1)).toHaveLength(2);
      expect(getChannelMessages(1)[1]!.status).toBe("pending");

      // The resync's history fetch reveals the server DID persist the send —
      // id 500 is the real echo of the lost ack.
      setMessages(1, [makeMessageResponse({ id: 500, content: "ok", user: TEST_USER })], false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(500);
      expect(msgs[0]!.status).toBe("sent");
    });

    it("dedupes an optimistic row against its own real message when the server sanitized the content", () => {
      // The server runs every send through sanitizeToFixpoint before storing
      // and broadcasting it, so the echo's content need not be byte-identical
      // to what the client typed — a double-escaped entity unescapes down to
      // its plain character.
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "&amp;lt;",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      invalidateLoadedMessageWindows();
      expect(getChannelMessages(1)).toHaveLength(2);
      expect(getChannelMessages(1)[1]!.status).toBe("pending");

      setMessages(1, [makeMessageResponse({ id: 500, content: "<", user: TEST_USER })], false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(500);
      expect(msgs[0]!.status).toBe("sent");
    });

    it("keeps two genuinely distinct same-author, same-text sends distinct across the same resync", () => {
      setMessages(1, [], false);
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "ok",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      addOptimisticMessage({
        correlationId: "c2",
        channelId: 1,
        user: TEST_USER,
        content: "ok",
        replyTo: null,
        timestamp: "2026-03-15T10:00:01Z",
      });
      invalidateLoadedMessageWindows();
      expect(getChannelMessages(1)).toHaveLength(2);

      // Both sends actually landed server-side; the resync's fetch returns
      // both real rows — neither optimistic row may collapse onto the other's.
      setMessages(
        1,
        [
          makeMessageResponse({ id: 501, content: "ok", user: TEST_USER }),
          makeMessageResponse({ id: 500, content: "ok", user: TEST_USER }),
        ],
        false,
      );

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs.map((m) => m.id)).toEqual([500, 501]);
      expect(msgs.every((m) => m.status === "sent")).toBe(true);
    });

    it("keeps a still-pending local row when its would-be echo sits in the head that overflow-trimming drops", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "echo-in-head",
        replyTo: null,
        timestamp: "2026-03-15T09:59:59Z",
      });

      // Server returns newest-first; id 1 becomes the OLDEST entry once
      // reversed -- exactly the entry the initial overflow trim drops before
      // the pending row's echo-match ever gets to see it. It carries the
      // same author+content as the still-pending row above and must NOT be
      // treated as its echo (the trim has to run before the match, not after).
      const responses: MessageResponse[] = [];
      for (let i = 501; i >= 1; i--) {
        responses.push(
          makeMessageResponse({
            id: i,
            content: i === 1 ? "echo-in-head" : `msg-${i}`,
            user: i === 1 ? TEST_USER : TEST_USER_2,
          }),
        );
      }
      setMessages(1, responses, false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(500);
      expect(msgs.some((m) => m.correlationId === "c1" && m.status === "pending")).toBe(true);
    });

    it("does not report hasMore at exactly the cap with no trimming and no carried overflow", () => {
      const responses: MessageResponse[] = [];
      for (let i = 1; i <= 500; i++) {
        responses.push(makeMessageResponse({ id: i, channel_id: 1 }));
      }
      setMessages(1, responses, false);

      expect(getChannelMessages(1)).toHaveLength(500);
      expect(hasMoreMessages(1)).toBe(false);
    });

    it("clears a stale window when a purge empties the channel between mount and refetch", () => {
      // Channel loaded with two rows, then the user navigates away (rows are
      // kept, only the loaded flag drops) and every message in the channel is
      // purged server-side while it isn't focused, so no broadcast tells this
      // client about it.
      setMessages(1, [makeMessageResponse({ id: 10 }), makeMessageResponse({ id: 9 })], false);

      // The user navigates back: MessageController calls setChannelLoading
      // synchronously before issuing the GET, recording a watermark of the
      // highest id present at that moment (10).
      setChannelLoading(1);

      // The server now reports the channel as empty (every row deleted).
      // Without a watermark, maxSnapshotId defaults to 0 and the stale "sent"
      // rows (id > 0) would be kept forever.
      setMessages(1, [], false);

      expect(getChannelMessages(1)).toEqual([]);
    });

    it("still keeps a live row that arrived during the fetch of a channel with no prior history", () => {
      // A brand-new channel: no rows before the fetch starts, so the watermark
      // is 0 — indistinguishable from "no watermark recorded" on its own, but
      // a live broadcast that lands mid-fetch must still survive.
      setChannelLoading(1);
      addMessage(makeChatPayload({ id: 50, channel_id: 1, content: "live" }));

      setMessages(1, [], false);

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(50);
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

    it("does not mark the channel detached when the prepend has no actual overflow to trim", () => {
      setMessages(1, [makeMessageResponse({ id: 20 })], true);

      prependMessages(1, [makeMessageResponse({ id: 10 })], false);

      expect(isWindowDetached(1)).toBe(false);
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
      confirmSend("unknown", 100, "2026-03-15T10:00:00Z");
      const after = messagesStore.getState();
      // State still changes (new Map created), but pending size is 0
      expect(after.pendingSends.size).toBe(0);
    });

    it("channelIdForSend resolves from the registry, then from an unsent row", () => {
      const logicalId = "scan-logical";
      addOptimisticMessage({
        correlationId: "scan-attempt",
        clientMessageId: logicalId,
        channelId: 1,
        user: TEST_USER,
        content: "local draft text",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("scan-attempt", "UNCONFIRMED");
      expect(channelIdForSend("scan-attempt", logicalId)).toBe(1);

      // The sweep that expires pendingSends leaves the row behind; the logical
      // identity is then the only route back to the channel.
      messagesStore.setState((prev) => {
        const pending = new Map(prev.pendingSends);
        pending.delete("scan-attempt");
        return { ...prev, pendingSends: pending };
      });
      expect(channelIdForSend("scan-attempt", logicalId)).toBe(1);
      expect(channelIdForSend("scan-attempt")).toBe(1);
      expect(channelIdForSend("nobody", "no-such-client-id")).toBeUndefined();
    });

    it("reconciles a locally-stamped row with the server row after a deduplicated ack", () => {
      const logicalId = "dedup-logical";
      addOptimisticMessage({
        correlationId: "retry-attempt",
        clientMessageId: logicalId,
        channelId: 1,
        user: TEST_USER,
        content: "local draft text",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("retry-attempt", "UNCONFIRMED");
      confirmSend("retry-attempt", 100, "2026-03-15T10:00:00Z", logicalId);
      expect(getChannelMessages(1)).toHaveLength(1);
      expect(getChannelMessages(1)[0]).toMatchObject({ id: 100, status: "sent" });
      // No broadcast follows a deduplicated ack, so the row still holds the
      // text this device sent -- stale if the message was edited elsewhere.
      expect(getChannelMessages(1)[0]).toMatchObject({ content: "local draft text" });

      applyServerMessage(
        makeMessageResponse({
          id: 100,
          content: "edited on the server",
          edited_at: "2026-03-15T10:05:00Z",
        }),
      );

      expect(getChannelMessages(1)).toHaveLength(1);
      expect(getChannelMessages(1)[0]).toMatchObject({
        id: 100,
        status: "sent",
        content: "edited on the server",
        editedAt: "2026-03-15T10:05:00Z",
      });
    });

    it("applyServerMessage never appends a row the window does not hold", () => {
      applyServerMessage(makeMessageResponse({ id: 4242, channel_id: 1 }));
      expect(getChannelMessages(1)).toHaveLength(0);
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

    it("changes no message list if the channel does not exist, but still counts the pin change", () => {
      const before = messagesStore.getState();
      setMessagePinned(99, 100, true);
      const after = messagesStore.getState();
      expect(after.messagesByChannel).toBe(before.messagesByChannel);
      expect(after.pinRevision?.get(99)).toBe(1);
    });

    it("produces a new message object (immutable update)", () => {
      addMessage(makeChatPayload({ id: 100, channel_id: 1 }));
      const original = getChannelMessages(1)[0]!;

      setMessagePinned(1, 100, true);
      const updated = getChannelMessages(1)[0]!;

      expect(original).not.toBe(updated);
    });
  });
});
