import { describe, it, expect, beforeEach } from "vitest";
import {
  messagesStore,
  addMessage,
  setMessages,
  prependMessages,
  editMessage,
  confirmSend,
  addOptimisticMessage,
  markSendFailed,
  removeOptimistic,
  getChannelMessages,
  isChannelLoaded,
  hasMoreMessages,
  isWindowDetached,
  setChannelLoading,
  setChannelLoadError,
  getHistoryLoadState,
  invalidateLoadedMessageWindows,
  invalidateChannelMessageWindow,
  setAroundMessages,
} from "../../../src/stores/messages.store";
import type {
  ChatMessagePayload,
  ChatEditedPayload,
  MessageResponse,
  MessageUser,
} from "../../../src/lib/types";
import {
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
      expect(msgs[0]!.pinned).toBe(false);
      expect(msgs[0]!.deleted).toBe(false);
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

    it("markSendFailed relabels a row that already failed", () => {
      // The offline branch marks a row failed at once, then relabels it when
      // the deferred persistence of that same text also fails. The first call
      // dropped the row from pendingSends, so the second must still find it —
      // otherwise the more specific reason never reaches the UI.
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "OFFLINE");

      markSendFailed("c1", "OFFLINE_NO_RECOVERY");

      expect(getChannelMessages(1)[0]!.errorCode).toBe("OFFLINE_NO_RECOVERY");
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

    it("removeOptimistic drops an already-failed row, whose channel is no longer in pendingSends", () => {
      // markSendFailed deletes the correlationId from pendingSends when it
      // flips the row to "failed" — the Retry/Delete buttons only render for
      // failed rows, so this is the path every UI-driven removeOptimistic call
      // actually takes.
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "SLOW_MODE");
      expect(messagesStore.getState().pendingSends.has("c1")).toBe(false);

      removeOptimistic("c1");
      expect(getChannelMessages(1)).toHaveLength(0);
    });

    it("removeOptimistic drops only the targeted row when multiple sends are still in flight", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "first",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      addOptimisticMessage({
        correlationId: "c2",
        channelId: 1,
        user: TEST_USER,
        content: "second",
        replyTo: null,
        timestamp: "2026-03-15T10:00:01Z",
      });

      // Both are still tracked in pendingSends (neither failed), so this
      // exercises the direct channelId-lookup branch, not the fallback scan.
      removeOptimistic("c1");

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.correlationId).toBe("c2");
    });

    it("removeOptimistic's fallback scan finds an already-failed row in a later channel, leaving an earlier unrelated channel untouched", () => {
      // Channel 1 is inserted first and holds only an unrelated sent message,
      // so it is visited first by the fallback scan's Map iteration order.
      addMessage(makeChatPayload({ id: 60, channel_id: 1, content: "unrelated" }));

      // Channel 2 (inserted second) holds a sent row plus the failed
      // optimistic row we're targeting -- a mixed list, so `.some` and
      // `.every` disagree on whether it contains the correlation id.
      addMessage(makeChatPayload({ id: 61, channel_id: 2, content: "seed" }));
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 2,
        user: TEST_USER,
        content: "refused",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "SLOW_MODE");
      // markSendFailed already dropped "c1" from pendingSends, so
      // removeOptimistic must use the fallback scan below.
      expect(messagesStore.getState().pendingSends.has("c1")).toBe(false);

      removeOptimistic("c1");

      expect(getChannelMessages(1)).toHaveLength(1);
      expect(getChannelMessages(1)[0]!.id).toBe(60);
      expect(getChannelMessages(2).map((m) => m.correlationId)).toEqual([null]);
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

    it("reconciles an OFFLINE-failed row when its echo arrives — no duplicate, no dead Retry", () => {
      // The dispatcher's offline sweep flips every pending send to
      // failed/OFFLINE on the first reconnecting/disconnected transition —
      // it cannot know whether the frame actually reached the server first.
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "OFFLINE");

      // It did reach the server after all — its broadcast (or a reconnect
      // replay) arrives with the real id.
      addMessage(makeChatPayload({ id: 900, user: TEST_USER, content: "hi" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(900);
      expect(msgs[0]!.status).toBe("sent");
    });

    it("reconciles an OFFLINE-failed row whose echo comes back sanitized — stripped tags don't defeat the match", () => {
      // sanitizeToFixpoint (Server/service/message.go) strips HTML tags
      // before the content is stored and broadcast, so the echo need not be
      // byte-identical to the raw text the user typed.
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "<b>hello</b>",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "OFFLINE");

      addMessage(makeChatPayload({ id: 900, user: TEST_USER, content: "hello" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe(900);
      expect(msgs[0]!.status).toBe("sent");
    });

    it("does not reconcile a server-rejected (non-OFFLINE) failed row into an unrelated broadcast", () => {
      // SLOW_MODE/FORBIDDEN etc. are never broadcast by the server, so no echo
      // can legitimately arrive for them — widening the reconcile must stay
      // scoped to OFFLINE, or a same-author/same-content coincidence would
      // silently eat a row the user still needs to retry.
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "SLOW_MODE");

      addMessage(makeChatPayload({ id: 900, user: TEST_USER, content: "hi" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs.find((m) => m.correlationId === "c1")!.status).toBe("failed");
    });

    it("does not reconcile a pending row against a different author's identical-content broadcast", () => {
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });

      // Different author, identical content -- must not be treated as this
      // pending row's echo (isUnreconciledEcho requires the same user id).
      addMessage(makeChatPayload({ id: 900, user: TEST_USER_2, content: "hi" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs.find((m) => m.correlationId === "c1")!.status).toBe("pending");
      expect(msgs.find((m) => m.id === 900)!.user.id).toBe(TEST_USER_2.id);
    });

    it("does not re-run step-2 reconciliation against an already-confirmed row that still carries its correlationId", () => {
      // confirmSend flips status to "sent" but deliberately leaves
      // correlationId set (it is cleared only once the id-matched broadcast
      // lands) -- a same-author/same-content broadcast under a DIFFERENT id
      // must not treat this already-confirmed row as an unreconciled echo.
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "hi",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      confirmSend("c1", 555, "2026-03-15T10:00:01Z");

      addMessage(makeChatPayload({ id: 999, user: TEST_USER, content: "hi" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs.find((m) => m.id === 555)!.correlationId).toBe("c1");
      expect(msgs.find((m) => m.id === 999)).toBeDefined();
    });

    it("replaces only the reconciled row, leaving a sibling message in the channel untouched", () => {
      addMessage(
        makeChatPayload({ id: 50, channel_id: 1, user: TEST_USER_2, content: "unrelated" }),
      );
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "race",
        replyTo: null,
        timestamp: "2026-03-15T10:00:01Z",
      });

      // Broadcast races ahead of the ack; reconciles the pending row by
      // author+content (step 2) at its own index, not the unrelated sibling
      // that precedes it.
      addMessage(makeChatPayload({ id: 800, user: TEST_USER, content: "race" }));

      const msgs = getChannelMessages(1);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.id).toBe(50);
      expect(msgs[0]!.content).toBe("unrelated");
      expect(msgs[1]!.id).toBe(800);
    });

    it("keeps id/time order when another user's message commits while our send is still in flight", () => {
      // Channel loaded with [id 100].
      addMessage(makeChatPayload({ id: 100, user: TEST_USER_2, content: "seed" }));

      // A types and sends -> optimistic pending row appended at the tail.
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "mine",
        replyTo: null,
        timestamp: "2026-03-15T10:00:01Z",
      });

      // Before A's send commits server-side, B's message commits as id 101
      // and is broadcast. Different author/content, so this cannot reconcile
      // against the pending row — it must land as a genuine append, and it
      // must land *before* the still-pending row, not after it, or the
      // pending row (which will shortly outrank it in id/time) ends up
      // sitting ahead of an older message.
      addMessage(
        makeChatPayload({
          id: 101,
          user: TEST_USER_2,
          content: "bob's message",
          timestamp: "2026-03-15T10:00:02Z",
        }),
      );

      // A's chat_send_ok arrives with the real id, stamped in place.
      confirmSend("c1", 102, "2026-03-15T10:00:03Z");

      // A's own echo of the broadcast arrives and reconciles by real id.
      addMessage(
        makeChatPayload({
          id: 102,
          user: TEST_USER,
          content: "mine",
          timestamp: "2026-03-15T10:00:03Z",
        }),
      );

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.id)).toEqual([100, 101, 102]);
    });
  });

  describe("invalidateLoadedMessageWindows", () => {
    it("clears loaded for every loaded channel and keeps their rows, hasMore and detached flag", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], true);
      setAroundMessages(2, [makeMessageResponse({ id: 20, channel_id: 2 })], true, true);
      expect(isChannelLoaded(1)).toBe(true);
      expect(isChannelLoaded(2)).toBe(true);

      invalidateLoadedMessageWindows();

      expect(getChannelMessages(1).map((m) => m.id)).toEqual([10]);
      expect(getChannelMessages(2).map((m) => m.id)).toEqual([20]);
      expect(isChannelLoaded(1)).toBe(false);
      expect(isChannelLoaded(2)).toBe(false);
      expect(hasMoreMessages(1)).toBe(true);
      // A detached window keeps refusing live appends until its refetch lands (OC-0204).
      expect(isWindowDetached(2)).toBe(true);
    });

    it("carries pending and failed optimistic rows instead of destroying them", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "still sending",
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

      invalidateLoadedMessageWindows();

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.correlationId)).toEqual([null, "c1", "c2"]);
      expect(msgs[1]!.status).toBe("pending");
      expect(msgs[2]!.status).toBe("failed");
    });

    it("is a no-op when no channel is loaded", () => {
      const before = messagesStore.getState();
      invalidateLoadedMessageWindows();
      expect(messagesStore.getState()).toBe(before);
    });
  });

  describe("invalidateChannelMessageWindow", () => {
    it("drops only that channel's loaded flag and keeps its rows for instant re-render", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      setMessages(2, [makeMessageResponse({ id: 20, channel_id: 2 })], false);

      invalidateChannelMessageWindow(1);

      expect(isChannelLoaded(1)).toBe(false);
      expect(isChannelLoaded(2)).toBe(true);
      // The old rows stay rendered until the refetched tail lands and merges.
      expect(getChannelMessages(1).map((m) => m.id)).toEqual([10]);
    });

    it("lets the next tail fetch land: setMessages refreshes the window and re-marks it loaded", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      invalidateChannelMessageWindow(1);

      // Wire order is newest-first; the refetched tail carries a message
      // posted while the channel was not focused.
      setMessages(1, [makeMessageResponse({ id: 11 }), makeMessageResponse({ id: 10 })], false);

      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1).map((m) => m.id)).toEqual([10, 11]);
    });

    it("keeps a failed optimistic row across the invalidate-then-refetch cycle", () => {
      setMessages(1, [makeMessageResponse({ id: 10 })], false);
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: TEST_USER,
        content: "refused",
        replyTo: null,
        timestamp: "2026-03-15T10:00:01Z",
      });
      markSendFailed("c1", "SLOW_MODE");

      invalidateChannelMessageWindow(1);
      setMessages(1, [makeMessageResponse({ id: 11 }), makeMessageResponse({ id: 10 })], false);

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.id)).toEqual([10, 11, 0]);
      expect(msgs[2]!.status).toBe("failed");
    });

    it("leaves the detached flag alone (setMessages clears it once the tail lands)", () => {
      setAroundMessages(1, [makeMessageResponse({ id: 10 })], true, true);
      expect(isWindowDetached(1)).toBe(true);

      invalidateChannelMessageWindow(1);

      expect(isChannelLoaded(1)).toBe(false);
      expect(isWindowDetached(1)).toBe(true);
    });

    it("is a no-op for a channel that is not loaded", () => {
      const before = messagesStore.getState();
      invalidateChannelMessageWindow(1);
      expect(messagesStore.getState()).toBe(before);
    });
  });

  // DP-10: a revisit refetches the latest page and reconciles it into the
  // cached window instead of replacing it.
  describe("revisit reconcile", () => {
    /** Newest-first page of ids [from, to], as the REST API returns it. */
    function page(from: number, to: number): MessageResponse[] {
      const out: MessageResponse[] = [];
      for (let id = to; id >= from; id--) out.push(makeMessageResponse({ id, content: `m${id}` }));
      return out;
    }
    /** Leave the channel and come back: the invalidate + fetch start the app runs. */
    function revisit(): void {
      invalidateChannelMessageWindow(1);
      setChannelLoading(1);
    }

    it("returns the cached array itself when the refetched page matches the cached tail", () => {
      setMessages(1, page(1, 50), true);
      const cached = getChannelMessages(1);

      revisit();
      setMessages(1, page(1, 50), true);

      expect(getChannelMessages(1)).toBe(cached);
      expect(isChannelLoaded(1)).toBe(true);
      expect(getHistoryLoadState(1)).toBeNull();
    });

    it("returns a new array without the rows older than the page once the window grew past it", () => {
      setMessages(1, page(1, 50), true);
      addMessage(makeChatPayload({ id: 51, content: "m51", timestamp: "2026-03-15T09:00:00Z" }));
      const cached = getChannelMessages(1);

      revisit();
      setMessages(1, page(2, 51), true);

      const msgs = getChannelMessages(1);
      expect(msgs).not.toBe(cached);
      expect(msgs.map((m) => m.id)).toEqual(cached.slice(1).map((m) => m.id));
      msgs.forEach((m, i) => expect(m).toBe(cached[i + 1]));
    });

    it("drops older cached rows beyond the page and keeps unchanged row objects inside it", () => {
      setMessages(1, page(51, 100), true);
      prependMessages(1, page(1, 50), true);
      const cached = getChannelMessages(1);

      revisit();
      // While away: 101 was posted, 80 edited and 90 deleted.
      const fresh = page(52, 101)
        .filter((m) => m.id !== 90)
        .map((m) =>
          m.id === 80 ? { ...m, content: "edited", edited_at: "2026-03-15T10:00:00Z" } : m,
        );
      setMessages(1, fresh, true);

      const msgs = getChannelMessages(1);
      const ids = msgs.map((m) => m.id);
      expect(ids[0]).toBe(52);
      expect(ids).toHaveLength(49);
      expect(ids).not.toContain(90);
      expect(ids.at(-1)).toBe(101);
      expect(msgs.find((m) => m.id === 80)!.content).toBe("edited");
      // Rows nothing changed keep their object, so the list can tell them apart.
      expect(msgs[0]).toBe(cached.find((m) => m.id === 52));
      expect(msgs.find((m) => m.id === 70)).toBe(cached.find((m) => m.id === 70));
      expect(hasMoreMessages(1)).toBe(true);
    });

    it("does not show a message deleted while away that is older than the refetched page", () => {
      setMessages(1, page(51, 100), true);
      prependMessages(1, page(1, 50), true);
      expect(getChannelMessages(1).map((m) => m.id)).toContain(20);

      revisit();
      // While away: 20 was deleted and 101-110 were posted.
      setMessages(1, page(61, 110), true);

      expect(getChannelMessages(1).map((m) => m.id)).not.toContain(20);
    });

    it("keeps a row that arrived live when the page carries its REST twin in the server's wire shapes", () => {
      // The whole channel fits in one page, so the refetch is the cached window.
      setMessages(1, page(1, 49), false);
      // chat_message's user carries the role, the nickname and an explicit
      // null avatar, and the broadcast echoes client_message_id. History's
      // user has none of them and omits a null avatar.
      addMessage(
        makeChatPayload({
          id: 50,
          client_message_id: "1773568800000:live",
          user: {
            id: 2,
            username: "bob",
            avatar: null,
            display_name: "Bobby",
            role: "member",
          } as MessageUser,
          content: "m50",
          timestamp: "2026-03-15T09:00:00Z",
          mentions: [],
          mentions_everyone: false,
        }),
      );
      const cached = getChannelMessages(1);
      expect(cached.at(-1)?.clientMessageId).toBe("1773568800000:live");

      revisit();
      const restTwin = makeMessageResponse({
        id: 50,
        user: { id: 2, username: "bob" } as MessageUser,
        content: "m50",
        timestamp: "2026-03-15T09:00:00Z",
        mentions: [],
        mentions_everyone: false,
      });
      setMessages(1, [restTwin, ...page(1, 49)], false);

      expect(getChannelMessages(1)).toBe(cached);
    });

    it("replaces a live row whose avatar changed while away", () => {
      setMessages(1, page(1, 49), false);
      addMessage(
        makeChatPayload({
          id: 50,
          user: { id: 2, username: "bob", avatar: null, role: "member" } as MessageUser,
          content: "m50",
          timestamp: "2026-03-15T09:00:00Z",
        }),
      );
      const live = getChannelMessages(1).at(-1);

      revisit();
      setMessages(
        1,
        [
          makeMessageResponse({
            id: 50,
            user: { id: 2, username: "bob", avatar: "bob.png" },
            content: "m50",
            timestamp: "2026-03-15T09:00:00Z",
          }),
          ...page(1, 49),
        ],
        false,
      );

      expect(getChannelMessages(1).at(-1)).not.toBe(live);
      expect(getChannelMessages(1).at(-1)?.user.avatar).toBe("bob.png");
    });

    it("replaces the window when the page leaves a gap after the cached rows", () => {
      setMessages(1, page(1, 50), true);

      revisit();
      setMessages(1, page(151, 200), true);

      expect(getChannelMessages(1).map((m) => m.id)).toEqual(
        page(151, 200)
          .map((m) => m.id)
          .reverse(),
      );
    });

    it("drops older cached rows when the page is the whole channel", () => {
      setMessages(1, page(51, 100), true);
      prependMessages(1, page(1, 50), false);

      revisit();
      // No more history above the page: rows 1-59 were deleted while away.
      setMessages(1, page(60, 100), false);

      expect(getChannelMessages(1).map((m) => m.id)[0]).toBe(60);
      expect(hasMoreMessages(1)).toBe(false);
    });

    it("still clears a stale window when the refetch comes back empty", () => {
      setMessages(1, page(1, 50), true);

      revisit();
      setMessages(1, [], false);

      expect(getChannelMessages(1)).toEqual([]);
    });

    it("keeps a live message that landed mid-fetch and does not bridge a gap with it", () => {
      setMessages(1, page(1, 50), true);

      revisit();
      addMessage(makeChatPayload({ id: 200, channel_id: 1, content: "live" }));
      // The page was read before 200 existed and does not reach the cache.
      setMessages(1, page(150, 199), true);

      const ids = getChannelMessages(1).map((m) => m.id);
      expect(ids[0]).toBe(150);
      expect(ids.at(-1)).toBe(200);
      expect(ids).toHaveLength(51);
    });

    it("carries pending and failed rows across the reconcile, after the tail", () => {
      setMessages(1, page(1, 50), true);
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
      const cached = getChannelMessages(1);

      revisit();
      setMessages(1, page(1, 50), true);

      expect(getChannelMessages(1)).toBe(cached);
      revisit();
      setMessages(1, page(2, 51), true);
      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.id).slice(-3)).toEqual([51, 0, 0]);
      expect(msgs.map((m) => m.status).slice(-2)).toEqual(["pending", "failed"]);
    });

    it("reattaches a detached window only through the refetched tail", () => {
      setAroundMessages(1, page(40, 60).reverse(), true, true);
      expect(isWindowDetached(1)).toBe(true);

      revisit();
      // Still detached while the tail is in flight: live appends stay refused.
      addMessage(makeChatPayload({ id: 500, channel_id: 1 }));
      expect(getChannelMessages(1).map((m) => m.id)).not.toContain(500);

      setMessages(1, page(451, 500), true);
      expect(isWindowDetached(1)).toBe(false);
      expect(getChannelMessages(1).map((m) => m.id)[0]).toBe(451);
    });
  });

  // P2-T4: a full `ready` keeps every loaded row, and the active channel's
  // refetch splices into its window instead of replacing it.
  describe("full-ready resync splice", () => {
    /** Newest-first page of ids [from, to], as the REST API returns it. */
    function page(from: number, to: number): MessageResponse[] {
      const out: MessageResponse[] = [];
      for (let id = to; id >= from; id--) out.push(makeMessageResponse({ id, content: `m${id}` }));
      return out;
    }
    /** Oldest-first around-window of ids [from, to]. */
    function around(from: number, to: number): MessageResponse[] {
      return page(from, to).reverse();
    }
    /** The live tail plus three older pages: ids 1-200, the whole channel. */
    function load200(): void {
      setMessages(1, page(151, 200), true);
      prependMessages(1, page(101, 150), true);
      prependMessages(1, page(51, 100), true);
      prependMessages(1, page(1, 50), false);
    }
    /** What the dispatcher runs on a second `ready` for the active channel. */
    function resync(): void {
      setChannelLoading(1);
      invalidateLoadedMessageWindows();
    }
    const ids = (from: number, to: number): number[] =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i);

    it("keeps every loaded row on screen while the refetch is in flight", () => {
      load200();
      const cached = getChannelMessages(1);

      resync();

      expect(getChannelMessages(1)).toBe(cached);
      expect(isChannelLoaded(1)).toBe(false);
      expect(getHistoryLoadState(1)).toBe("loading");
    });

    it("an overlapping tail keeps rows 1-150 and replaces 151-200", () => {
      load200();
      const cached = getChannelMessages(1);

      resync();
      const fresh = page(151, 200).map((m) =>
        m.id === 180 ? { ...m, content: "edited", edited_at: "2026-03-15T10:00:00Z" } : m,
      );
      setMessages(1, fresh, true, true);

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.id)).toEqual(ids(1, 200));
      for (let i = 0; i < 150; i++) expect(msgs[i]).toBe(cached[i]);
      expect(msgs.find((m) => m.id === 180)!.content).toBe("edited");
      expect(isChannelLoaded(1)).toBe(true);
      expect(getHistoryLoadState(1)).toBeNull();
      // The rows above the page are still the whole channel's start.
      expect(hasMoreMessages(1)).toBe(false);
    });

    it("keeps the older rows when messages were posted during the outage", () => {
      load200();

      resync();
      setMessages(1, page(171, 220), true, true);

      expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(1, 220));
    });

    it("a disjoint tail replaces the window", () => {
      load200();

      resync();
      setMessages(1, page(301, 350), true, true);

      expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(301, 350));
      expect(hasMoreMessages(1)).toBe(true);
    });

    it("a tail that is the whole channel drops the older rows", () => {
      load200();

      resync();
      // No more history above the page: rows 1-150 were deleted during the outage.
      setMessages(1, page(151, 200), false, true);

      expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(151, 200));
    });

    it("carries pending and failed rows through the splice", () => {
      load200();
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
      markSendFailed("c2", "OFFLINE");

      resync();
      expect(getChannelMessages(1)).toHaveLength(202);
      setMessages(1, page(151, 200), true, true);

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.id)).toEqual([...ids(1, 200), 0, 0]);
      expect(msgs.slice(-2).map((m) => m.status)).toEqual(["pending", "failed"]);
    });

    it("an around-window splice keeps the loaded rows on both sides of a detached window", () => {
      setAroundMessages(1, around(100, 160), true, true);
      prependMessages(1, page(50, 99), true);
      const cached = getChannelMessages(1);

      resync();
      // Still detached while the refetch is in flight: live appends stay refused.
      addMessage(makeChatPayload({ id: 900, channel_id: 1 }));
      expect(getChannelMessages(1)).toBe(cached);

      const fresh = around(110, 150).map((m) => (m.id === 130 ? { ...m, content: "edited" } : m));
      setAroundMessages(1, fresh, true, true, true);

      const msgs = getChannelMessages(1);
      expect(msgs.map((m) => m.id)).toEqual(ids(50, 160));
      expect(msgs.find((m) => m.id === 130)!.content).toBe("edited");
      expect(msgs[0]).toBe(cached[0]);
      expect(isWindowDetached(1)).toBe(true);
      expect(hasMoreMessages(1)).toBe(true);
    });

    it("an around-window that reaches the live tail drops nothing below it and reattaches", () => {
      setAroundMessages(1, around(100, 160), true, true);

      resync();
      setAroundMessages(1, around(120, 170), true, false, true);

      expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(100, 170));
      expect(isWindowDetached(1)).toBe(false);
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
