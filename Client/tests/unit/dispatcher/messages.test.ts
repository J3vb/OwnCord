import { describe, it, expect, vi } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { wireDispatcher } from "../../../src/lib/dispatcher";
import { expectConsole } from "../../helpers/console";
import { authStore } from "../../../src/stores/auth.store";
import { channelsStore } from "../../../src/stores/channels.store";
import {
  messagesStore,
  addOptimisticMessage,
  addOptimisticReaction,
  getChannelMessages,
  markSendFailed,
} from "../../../src/stores/messages.store";
import { uiStore } from "../../../src/stores/ui.store";
import {
  clearReactionUsersCache,
  getCachedReactionUsers,
  loadReactionUsers,
  setReactionUsersFetcher,
} from "../../../src/features/messaging/reactionUsers";
import { useDispatcherHarness, type DispatcherMock } from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

describe("WS Dispatcher", () => {
  let cleanup: () => void;
  let mock: DispatcherMock;

  useDispatcherHarness({
    wired: (m, c) => {
      mock = m;
      cleanup = c;
    },
    currentCleanup: () => cleanup,
  });

  it("wires chat_message to messages store", () => {
    mock.dispatch("chat_message", {
      id: 100,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "Hello world",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs).toHaveLength(1);
    expect(msgs![0]!.content).toBe("Hello world");
  });

  it("wires chat_message to increment unread for non-active channel", () => {
    // Set up a channel first
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(5, {
        id: 5,
        name: "off-topic",
        type: "text" as const,
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels: ch, activeChannelId: 1 }; // active is channel 1
    });

    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 5, // different from active
      user: { id: 2, username: "bob", avatar: null },
      content: "ping",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    const ch = channelsStore.getState().channels.get(5);
    expect(ch?.unreadCount).toBe(1);
  });

  // OC-0328: mirrors the DM-side "does not double-count" test below. A
  // channel message delivered between the server's registerNow and
  // buildReady is both counted in `ready`'s snapshot (lastMessageId already
  // advanced to its id) AND redelivered as a queued chat_message once the
  // socket drains — the channel path had no replay guard at all.
  it("does not double-count a channel unread/mention whose id is already reflected in lastMessageId", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(5, {
        id: 5,
        name: "off-topic",
        type: "text" as const,
        category: null,
        position: 0,
        unreadCount: 1,
        mentionCount: 1,
        lastMessageId: 200, // already reflects message 200 via `ready`
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels: ch, activeChannelId: 1 }; // active is channel 1
    });

    // The same message redelivered as a queued chat_message.
    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 5,
      user: { id: 2, username: "bob", avatar: null },
      content: "hey @me",
      mentions: [5],
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    const ch = channelsStore.getState().channels.get(5);
    expect(ch?.unreadCount).toBe(1);
    expect(ch?.mentionCount).toBe(1);
  });

  // OC-0204: "active channel" normally means "the user is watching the live
  // tail", so skipping the unread bump there is correct — until a jump to an
  // old permalink/reply/search hit leaves the SAME active channel showing a
  // detached around-window (messages.store's detachedChannels). addMessage
  // already refuses to append a live broadcast onto a detached window, so
  // without also bumping the badge here, a message arriving while the user
  // reads back-history leaves no row AND no badge — nothing records it ever
  // arrived.
  it("wires chat_message to increment unread for the active channel when its window is detached", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(5, {
        id: 5,
        name: "general",
        type: "text" as const,
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels: ch, activeChannelId: 5 }; // channel 5 IS active...
    });
    // ...but its loaded window is detached from the live tail (viewing
    // back-history via a jump).
    messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([5]) }));

    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 5,
      user: { id: 2, username: "bob", avatar: null },
      content: "ping",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    const ch = channelsStore.getState().channels.get(5);
    expect(ch?.unreadCount).toBe(1);
  });

  it("wires chat_send_ok to confirmSend in messages store", () => {
    // Add a pending send (correlationId -> channelId)
    messagesStore.setState((prev) => {
      const pending = new Map(prev.pendingSends);
      pending.set("corr-123", 1);
      return { ...prev, pendingSends: pending };
    });

    expect(messagesStore.getState().pendingSends.has("corr-123")).toBe(true);

    mock.dispatch(
      "chat_send_ok",
      { message_id: 500, timestamp: "2026-03-15T10:00:00Z" },
      "corr-123",
    );

    expect(messagesStore.getState().pendingSends.has("corr-123")).toBe(false);
  });

  it("fetches the authoritative row after a deduplicated send ack", async () => {
    cleanup();
    const getMessagesAround = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 501,
          channel_id: 1,
          user: { id: 1, username: "alex", avatar: null },
          content: "edited on the server",
          reply_to: null,
          attachments: [],
          reactions: [],
          pinned: false,
          edited_at: "2026-03-15T10:05:00Z",
          deleted: false,
          timestamp: "2026-03-15T10:00:00Z",
        },
      ],
      has_more_before: false,
      has_more_after: false,
    });
    cleanup = wireDispatcher(mock.ws, {
      listBlocks: vi.fn().mockResolvedValue({ blocked_user_ids: [] }),
      getMessagesAround,
    });

    addOptimisticMessage({
      correlationId: "corr-dedup",
      clientMessageId: "dedup-logical",
      channelId: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "local draft text",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });
    markSendFailed("corr-dedup", "UNCONFIRMED");

    mock.dispatch(
      "chat_send_ok",
      { message_id: 501, timestamp: "2026-03-15T10:00:00Z", deduplicated: true },
      "corr-dedup",
    );

    await vi.waitFor(() => {
      expect(getMessagesAround).toHaveBeenCalledWith(1, 501);
    });
    expect(getChannelMessages(1)[0]).toMatchObject({
      id: 501,
      content: "edited on the server",
      status: "sent",
    });
  });

  it("does not let a stale reconcile overwrite a frame that landed while it was in flight", async () => {
    cleanup();
    const staleRow = {
      id: 501,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "read before the delete",
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned: false,
      edited_at: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
    };
    let release: (resp: unknown) => void = () => {};
    const getMessagesAround = vi
      .fn()
      // The first read took its snapshot before the delete; it resolves late.
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      // The retry is what the server answers for a message that is now gone.
      .mockRejectedValueOnce(new Error("404"));
    cleanup = wireDispatcher(mock.ws, {
      listBlocks: vi.fn().mockResolvedValue({ blocked_user_ids: [] }),
      getMessagesAround,
    });

    addOptimisticMessage({
      correlationId: "corr-race",
      clientMessageId: "race-logical",
      channelId: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "local draft text",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });
    markSendFailed("corr-race", "UNCONFIRMED");
    mock.dispatch(
      "chat_send_ok",
      { message_id: 501, timestamp: "2026-03-15T10:00:00Z", deduplicated: true },
      "corr-race",
    );
    await vi.waitFor(() => expect(getMessagesAround).toHaveBeenCalledTimes(1));

    mock.dispatch("chat_deleted", { message_id: 501, channel_id: 1 });
    release({ messages: [staleRow], has_more_before: false, has_more_after: false });

    // It noticed the row moved and asked again rather than applying the snapshot.
    await vi.waitFor(() => expect(getMessagesAround).toHaveBeenCalledTimes(2));
    expect(getChannelMessages(1)[0]).toMatchObject({ id: 501, deleted: true });
    expectConsole("warn", /\[dispatcher\] Failed to reconcile a deduplicated send/);
  });

  it("does not refetch history for an ordinary send ack", async () => {
    cleanup();
    const getMessagesAround = vi.fn().mockResolvedValue({
      messages: [],
      has_more_before: false,
      has_more_after: false,
    });
    cleanup = wireDispatcher(mock.ws, {
      listBlocks: vi.fn().mockResolvedValue({ blocked_user_ids: [] }),
      getMessagesAround,
    });

    addOptimisticMessage({
      correlationId: "corr-plain",
      clientMessageId: "plain-logical",
      channelId: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "hello",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch(
      "chat_send_ok",
      { message_id: 502, timestamp: "2026-03-15T10:00:00Z" },
      "corr-plain",
    );

    // Settle the ack's own work before asserting the absence of a fetch.
    await vi.waitFor(() => {
      expect(messagesStore.getState().pendingSends.has("corr-plain")).toBe(false);
    });
    expect(getMessagesAround).not.toHaveBeenCalled();
  });

  it("fails every pending optimistic send when the connection drops", () => {
    addOptimisticMessage({
      correlationId: "corr-drop",
      channelId: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "in flight",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    // Reaching connected must not fail anything…
    mock.dispatchState("connected");
    expect(messagesStore.getState().messagesByChannel.get(1)![0]!.status).toBe("pending");

    // …but the connection dropping can never deliver chat_send_ok for the
    // pending frame, so the row must fail with retry instead of spinning.
    mock.dispatchState("reconnecting");

    const msg = messagesStore.getState().messagesByChannel.get(1)![0]!;
    expect(msg.status).toBe("failed");
    expect(msg.errorCode).toBe("OFFLINE");
    expect(messagesStore.getState().pendingSends.size).toBe(0);
  });

  it("rolls back every pending optimistic reaction toggle when the connection drops", () => {
    mock.dispatch("chat_message", {
      id: 900,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "react to me",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    addOptimisticReaction("corr-react-drop", {
      channelId: 1,
      messageId: 900,
      emoji: "👍",
      action: "add",
    });

    const before = getChannelMessages(1)[0]!.reactions.find((r) => r.emoji === "👍");
    expect(before?.count).toBe(1);
    expect(before?.me).toBe(true);
    expect(messagesStore.getState().pendingReactions?.has("corr-react-drop")).toBe(true);

    // Same reasoning as pendingSends above: the frame is gone with the dying
    // socket, so the toggle must roll back instead of leaving a permanently
    // wrong pill and a stale pendingReactions entry.
    mock.dispatchState("reconnecting");

    const after = getChannelMessages(1)[0]!.reactions.find((r) => r.emoji === "👍");
    expect(after).toBeUndefined();
    expect(messagesStore.getState().pendingReactions?.has("corr-react-drop")).toBe(false);
  });

  it("wires chat_edited to messages store", () => {
    // First add a message
    mock.dispatch("chat_message", {
      id: 100,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "original",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("chat_edited", {
      message_id: 100,
      channel_id: 1,
      content: "edited content",
      edited_at: "2026-03-15T10:01:00Z",
    });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs).toBeDefined();
    const edited = msgs!.find((m) => m.id === 100);
    expect(edited?.content).toBe("edited content");
  });

  it("wires chat_deleted to messages store", () => {
    mock.dispatch("chat_message", {
      id: 100,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "doomed",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("chat_deleted", { message_id: 100, channel_id: 1 });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    const found = msgs?.find((m) => m.id === 100);
    expect(found?.deleted).toBe(true);
  });

  it("wires chat_bulk_deleted to messages store", () => {
    for (const id of [100, 101, 102]) {
      mock.dispatch("chat_message", {
        id,
        channel_id: 1,
        user: { id: 1, username: "alex", avatar: null },
        content: `spam ${id}`,
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });
    }

    mock.dispatch("chat_bulk_deleted", { channel_id: 1, ids: [102, 101] });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs?.find((m) => m.id === 102)?.deleted).toBe(true);
    expect(msgs?.find((m) => m.id === 101)?.deleted).toBe(true);
    // Tombstones, not removals: the rows and their content survive.
    expect(msgs).toHaveLength(3);
    expect(msgs?.find((m) => m.id === 102)?.content).toBe("spam 102");
    // An id outside the purge is untouched.
    expect(msgs?.find((m) => m.id === 100)?.deleted).toBe(false);
  });

  it("ignores chat_bulk_deleted for an unloaded channel and an empty id list", () => {
    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "keep",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });
    const before = messagesStore.getState().messagesByChannel;

    mock.dispatch("chat_bulk_deleted", { channel_id: 99, ids: [1, 2, 3] });
    mock.dispatch("chat_bulk_deleted", { channel_id: 1, ids: [] });

    // No-op dispatches must not churn the map identity (re-render trigger).
    expect(messagesStore.getState().messagesByChannel).toBe(before);
    expect(messagesStore.getState().messagesByChannel.get(1)?.[0]?.deleted).toBe(false);
  });

  it("wires chat_send_ok without id does not crash", () => {
    expect(() => {
      mock.dispatch("chat_send_ok", { message_id: 500, timestamp: "2026-03-15T10:00:00Z" });
    }).not.toThrow();
  });

  it("wires reaction_update to messages store", () => {
    // Seed current user
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
    }));

    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 1,
      user: { id: 2, username: "bob", avatar: null },
      content: "react to me",
      reply_to: null,
      attachments: [],
      reactions: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("reaction_update", {
      message_id: 200,
      channel_id: 1,
      emoji: "thumbsup",
      user_ids: [1, 2],
      count: 2,
    });

    // Verify it doesn't crash (the actual reaction update is in messages store)
    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs).toBeDefined();
  });

  // The who-reacted tooltip caches reactor lists per message+emoji; a
  // reaction_update on that message makes every one of them stale.
  it("invalidates the who-reacted cache for the message a reaction_update names", async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 1, username: "alice", avatar: "" }]);
    setReactionUsersFetcher(fetcher as never);
    clearReactionUsersCache();

    await loadReactionUsers(1, 200, "👍");
    await loadReactionUsers(1, 201, "👍");
    expect(getCachedReactionUsers(200, "👍")).toHaveLength(1);

    mock.dispatch("reaction_update", {
      message_id: 200,
      channel_id: 1,
      emoji: "👍",
      user_id: 2,
      action: "add",
    });

    expect(getCachedReactionUsers(200, "👍")).toBeUndefined();
    // Other messages' caches are untouched.
    expect(getCachedReactionUsers(201, "👍")).toHaveLength(1);
    setReactionUsersFetcher(null);
  });

  it("wires a local transport send failure to mark the pending row failed", () => {
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    addOptimisticMessage({
      correlationId: "corr-2",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    // ws_send rejected locally (outbound channel full) → the row fails with retry…
    mock.dispatchSendFailure("corr-2", "NETWORK");

    const row = getChannelMessages(7)[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("NETWORK");
    // …and no global transient error is raised.
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("ignores a transport send failure for an id with no pending send (fire-and-forget)", () => {
    const before = messagesStore.getState();

    mock.dispatchSendFailure("typing-id", "NETWORK");

    // No store mutation: fire-and-forget sends (typing, presence…) stay silent.
    expect(messagesStore.getState()).toBe(before);
  });

  it("does not increment unread for own messages", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
    }));

    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(5, {
        id: 5,
        name: "other-ch",
        type: "text" as const,
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    mock.dispatch("chat_message", {
      id: 300,
      channel_id: 5,
      user: { id: 1, username: "alex", avatar: null },
      content: "my own message",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(0);
  });

  it("reaction_update with no user in auth uses 0 as fallback", () => {
    authStore.setState(() => ({
      token: "t",
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));

    // Just dispatch without crashing
    expect(() => {
      mock.dispatch("reaction_update", {
        message_id: 200,
        channel_id: 1,
        emoji: "thumbsup",
        user_ids: [1],
        count: 1,
      });
    }).not.toThrow();
  });
});
