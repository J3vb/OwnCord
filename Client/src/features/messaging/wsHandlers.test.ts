import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  failPendingOnDisconnect,
  handleChatBulkDeleted,
  handleChatDeleted,
  handleChatEdited,
  handleChatMessage,
  handleChatPinned,
  handleMessagingError,
  handleSendFailure,
} from "./wsHandlers";
import {
  messagesStore,
  addMessage,
  setMessagePinned,
  addOptimisticMessage,
  resetMessagesStore,
} from "../../stores/messages.store";
import { dmStore, setDmChannels, updateDmLastMessage } from "../../stores/dm.store";
import { channelsStore } from "../../stores/channels.store";
import { authStore } from "../../stores/auth.store";
import { setMembers, setTyping, getTypingUsers } from "../../stores/members.store";
import { activatePendingMessages, deactivatePendingMessages } from "../../lib/pendingMessages";
import { createReconnectClock } from "../connection/dispatchContext";
import type { DispatchApi, Payload } from "../connection/dispatchContext";
import type { DmChannelsResponse } from "../../lib/types";

vi.mock("../../lib/notifications", () => ({ notifyIncomingMessage: vi.fn() }));
import { notifyIncomingMessage } from "../../lib/notifications";
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
import { showToast } from "../../lib/toast";
import { setLiveTailInView } from "../../lib/read-state";
import { expectConsole } from "../../../tests/helpers/console";

function chat(id: number, timestamp: string): Payload<"chat_message"> {
  return {
    id,
    channel_id: 1,
    user: { id: 2, username: "bob", avatar: null },
    content: "hi",
    reply_to: null,
    attachments: [],
    timestamp,
  };
}

const me = { id: 1, username: "me", avatar: null };

function pendingSend(correlationId: string, clientMessageId?: string): void {
  addOptimisticMessage({
    correlationId,
    clientMessageId,
    channelId: 1,
    user: me,
    content: "draft",
    replyTo: null,
    timestamp: "2026-03-15T10:00:00Z",
  });
}

beforeEach(() => {
  resetMessagesStore();
  setMembers([]);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleChatMessage replay gate", () => {
  it("suppresses the notification for a frame timestamped before the reconnect handshake", () => {
    vi.useFakeTimers({ now: new Date("2026-03-15T10:00:10Z") });
    const clock = createReconnectClock();
    clock.lastReconnectHandshakeAt = Date.now();

    handleChatMessage(clock, chat(1, "2026-03-15T10:00:05Z"));

    expect(notifyIncomingMessage).not.toHaveBeenCalled();
    expect(clock.serverClockSkewMs).toBe(0);
  });

  it("notifies a live frame and samples the server clock skew from it", () => {
    vi.useFakeTimers({ now: new Date("2026-03-15T10:00:10Z") });
    const clock = createReconnectClock();
    clock.lastReconnectHandshakeAt = Date.now() - 1_000;

    handleChatMessage(clock, chat(1, "2026-03-15T10:00:12Z"));

    expect(notifyIncomingMessage).toHaveBeenCalledTimes(1);
    expect(clock.serverClockSkewMs).toBe(-2_000);
  });

  it("stops classifying frames as replay once the gate window has passed", () => {
    vi.useFakeTimers({ now: new Date("2026-03-15T10:00:10Z") });
    const clock = createReconnectClock();
    clock.lastReconnectHandshakeAt = Date.now() - 5_000;

    handleChatMessage(clock, chat(1, "2026-03-15T10:00:00Z"));

    expect(notifyIncomingMessage).toHaveBeenCalledTimes(1);
  });

  it("reads only the clock it is given", () => {
    vi.useFakeTimers({ now: new Date("2026-03-15T10:00:10Z") });
    const stale = createReconnectClock();
    stale.lastReconnectHandshakeAt = Date.now();

    handleChatMessage(createReconnectClock(), chat(1, "2026-03-15T10:00:05Z"));

    expect(notifyIncomingMessage).toHaveBeenCalledTimes(1);
  });
});

describe("handleChatMessage clears the sender's typing (DP-15)", () => {
  const bob = { id: 2, username: "bob", avatar: null, role: "member", status: "online" as const };

  it("clears the sender's typing state when their message lands", () => {
    setMembers([bob]);
    setTyping(1, 2);
    expect(getTypingUsers(1)).toHaveLength(1);

    handleChatMessage(createReconnectClock(), chat(1, "2026-03-15T10:00:00Z"));

    expect(getTypingUsers(1)).toHaveLength(0);
  });

  it("clears only the sender, leaving other typers in the channel", () => {
    const carol = {
      id: 3,
      username: "carol",
      avatar: null,
      role: "member",
      status: "online" as const,
    };
    setMembers([bob, carol]);
    setTyping(1, 2);
    setTyping(1, 3);

    handleChatMessage(createReconnectClock(), chat(1, "2026-03-15T10:00:00Z"));

    expect(getTypingUsers(1).map((m) => m.id)).toEqual([3]);
  });

  it("does not throw for a message from a user who is not typing (replay burst)", () => {
    setMembers([bob]);

    expect(() =>
      handleChatMessage(createReconnectClock(), chat(2, "2026-03-15T10:00:00Z")),
    ).not.toThrow();
    expect(getTypingUsers(1)).toHaveLength(0);
  });
});

describe("handleChatPinned (F5)", () => {
  it("sets the row's pinned flag from the broadcast", () => {
    addMessage({
      id: 9,
      channel_id: 7,
      user: { id: 1, username: "me", avatar: null },
      content: "x",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });
    handleChatPinned({ message_id: 9, channel_id: 7, pinned: true });
    const row = messagesStore
      .getState()
      .messagesByChannel.get(7)!
      .find((m) => m.id === 9);
    expect(row?.pinned).toBe(true);
  });

  it("clears the flag on an unpin broadcast", () => {
    addMessage({
      id: 9,
      channel_id: 7,
      user: { id: 1, username: "me", avatar: null },
      content: "x",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });
    setMessagePinned(7, 9, true);
    handleChatPinned({ message_id: 9, channel_id: 7, pinned: false });
    const row = messagesStore
      .getState()
      .messagesByChannel.get(7)!
      .find((m) => m.id === 9);
    expect(row?.pinned).toBe(false);
  });
});

describe("handleMessagingError", () => {
  it("consumes an error answering a pending send and fails that row", () => {
    pendingSend("corr-1");

    expect(handleMessagingError({ code: "SLOW_MODE", message: "" }, "corr-1")).toBe(true);
    expect(messagesStore.getState().pendingSends.has("corr-1")).toBe(false);
  });

  it("labels a refused pre-restore retry and keeps its text (OC-0476)", () => {
    const floor = Date.now() + 5 * 60 * 1000 + 1000;
    activatePendingMessages({ host: "chat.example", userId: 1 }, me, true, floor);
    try {
      const beforeFloor = `${Date.now()}:${crypto.randomUUID()}`;
      const afterFloor = `${floor}:${crypto.randomUUID()}`;
      pendingSend("corr-old", beforeFloor);
      pendingSend("corr-new", afterFloor);

      handleMessagingError({ code: "BAD_REQUEST", message: "" }, "corr-old");
      handleMessagingError({ code: "BAD_REQUEST", message: "" }, "corr-new");

      const rows = messagesStore.getState().messagesByChannel.get(1)!;
      expect(rows.find((m) => m.correlationId === "corr-old")).toMatchObject({
        status: "failed",
        errorCode: "BEFORE_RESTORE",
        content: "draft",
      });
      expect(rows.find((m) => m.correlationId === "corr-new")).toMatchObject({
        status: "failed",
        errorCode: "BAD_REQUEST",
      });
      expect(showToast).toHaveBeenCalledOnce();
      expect(showToast).toHaveBeenCalledWith(
        "The server was restored — check the conversation before sending this again.",
        "error",
      );
    } finally {
      deactivatePendingMessages();
    }
  });

  it("leaves an error with no matching send or reaction to the rest of the chain", () => {
    expect(handleMessagingError({ code: "FORBIDDEN", message: "" }, "other")).toBe(false);
    expect(handleMessagingError({ code: "FORBIDDEN", message: "" }, undefined)).toBe(false);
  });
});

describe("failPendingOnDisconnect", () => {
  it("fails every pending send on reconnecting or disconnected, and nothing otherwise", () => {
    pendingSend("corr-a");
    failPendingOnDisconnect("connected");
    expect(messagesStore.getState().pendingSends.has("corr-a")).toBe(true);

    failPendingOnDisconnect("reconnecting");
    expect(messagesStore.getState().pendingSends.size).toBe(0);

    pendingSend("corr-b");
    failPendingOnDisconnect("disconnected");
    expect(messagesStore.getState().pendingSends.size).toBe(0);
  });
});

describe("handleSendFailure", () => {
  it("fails the matching pending send", () => {
    pendingSend("corr-c");

    handleSendFailure("corr-c", "OFFLINE");

    expect(messagesStore.getState().pendingSends.has("corr-c")).toBe(false);
  });
});

function seedDm(lastMessageId: number, lastMessage: string, lastMessageAt: string): void {
  setDmChannels([
    {
      channelId: 1,
      recipient: { id: 2, username: "bob", avatar: "", status: "online" },
      participants: [],
      name: "",
      isGroup: false,
      lastMessageId,
      lastMessage,
      lastMessageAt,
      unreadCount: 0,
      mentionCount: 0,
    },
  ]);
}
const dm = () => dmStore.getState().channels[0]!;

function dmApi(getDmChannels: () => Promise<DmChannelsResponse>): DispatchApi {
  return { listBlocks: vi.fn(), getDmChannels };
}

function serverDms(
  lastMessageId: number,
  lastMessage: string,
  lastMessageAt: string,
): DmChannelsResponse {
  return {
    dm_channels: [
      {
        channel_id: 1,
        recipient: { id: 2, username: "bob", avatar: "", status: "online" },
        last_message_id: lastMessageId,
        last_message: lastMessage,
        last_message_at: lastMessageAt,
        unread_count: 0,
      },
    ],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("DM preview follows an edit or delete of its last message", () => {
  afterEach(() => setDmChannels([]));

  it("replaces the preview text when the shown message is edited", () => {
    seedDm(7, "oops, wrong person", "2026-03-15T10:00:00Z");
    handleChatEdited(undefined, { message_id: 7, channel_id: 1, content: "fixed", edited_at: "x" });
    expect(dm().lastMessage).toBe("fixed");
    expect(dm().lastMessageAt).toBe("2026-03-15T10:00:00Z");
  });

  it("leaves the preview alone when an older message is edited", () => {
    seedDm(7, "latest", "2026-03-15T10:00:00Z");
    handleChatEdited(undefined, { message_id: 6, channel_id: 1, content: "older", edited_at: "x" });
    expect(dm().lastMessage).toBe("latest");
  });

  it("blanks the deleted preview at once, then shows the server's last message", async () => {
    // A full ready kept stale rows 1..5, then 7 arrived live: 6 is missing from the cache.
    addMessage({ ...chat(5, "2026-03-15T08:00:00Z"), content: "stale" });
    addMessage({ ...chat(7, "2026-03-15T10:00:00Z"), content: "oops, wrong person" });
    seedDm(7, "oops, wrong person", "2026-03-15T10:00:00Z");
    const refetch = deferred<DmChannelsResponse>();
    const api = dmApi(() => refetch.promise);

    handleChatDeleted(api, { message_id: 7, channel_id: 1 });

    expect(dm()).toMatchObject({ lastMessageId: 7, lastMessage: "" });
    refetch.resolve(serverDms(6, "the real previous one", "2026-03-15T09:00:00Z"));
    await refetch.promise;
    await Promise.resolve();
    expect(dm()).toMatchObject({
      lastMessageId: 6,
      lastMessage: "the real previous one",
      lastMessageAt: "2026-03-15T09:00:00Z",
    });
  });

  it("refetches the server's last message after a bulk delete that includes the shown one", async () => {
    addMessage({ ...chat(5, "2026-03-15T08:00:00Z"), content: "stale" });
    seedDm(7, "purged too", "2026-03-15T10:00:00Z");
    const api = dmApi(() => Promise.resolve(serverDms(4, "server says", "2026-03-15T07:00:00Z")));

    handleChatBulkDeleted(api, { channel_id: 1, ids: [7, 6] });

    expect(dm().lastMessage).toBe("");
    await vi.waitFor(() =>
      expect(dm()).toMatchObject({ lastMessageId: 4, lastMessage: "server says" }),
    );
  });

  it("keeps a newer message that replaced the preview before the refetch answered", async () => {
    seedDm(7, "oops, wrong person", "2026-03-15T10:00:00Z");
    const refetch = deferred<DmChannelsResponse>();
    const api = dmApi(() => refetch.promise);

    handleChatDeleted(api, { message_id: 7, channel_id: 1 });
    updateDmLastMessage(1, 8, "brand new", "2026-03-15T11:00:00Z");
    refetch.resolve(serverDms(6, "older", "2026-03-15T09:00:00Z"));
    await refetch.promise;
    await Promise.resolve();

    expect(dm()).toMatchObject({ lastMessageId: 8, lastMessage: "brand new" });
  });

  it("drops an answer newer than the preview so the live frame still counts as new", async () => {
    seedDm(7, "oops, wrong person", "2026-03-15T10:00:00Z");
    const refetch = deferred<DmChannelsResponse>();

    handleChatDeleted(
      dmApi(() => refetch.promise),
      { message_id: 7, channel_id: 1 },
    );
    refetch.resolve(serverDms(8, "sent right after", "2026-03-15T11:00:00Z"));
    await refetch.promise;
    await Promise.resolve();

    expect(dm()).toMatchObject({ lastMessageId: 7, lastMessage: "" });
    updateDmLastMessage(1, 8, "sent right after", "2026-03-15T11:00:00Z");
    expect(dm()).toMatchObject({
      lastMessageId: 8,
      lastMessage: "sent right after",
      unreadCount: 1,
    });
  });

  it("reissues the refetch when an edit lands while one is in flight", async () => {
    seedDm(7, "oops, wrong person", "2026-03-15T10:00:00Z");
    const first = deferred<DmChannelsResponse>();
    const second = deferred<DmChannelsResponse>();
    const getDmChannels = vi
      .fn<() => Promise<DmChannelsResponse>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = dmApi(getDmChannels);

    handleChatDeleted(api, { message_id: 7, channel_id: 1 });
    handleChatEdited(api, { message_id: 6, channel_id: 1, content: "b", edited_at: "x" });
    expect(getDmChannels).toHaveBeenCalledTimes(2);

    first.resolve(serverDms(6, "a", "2026-03-15T09:00:00Z"));
    await first.promise;
    await Promise.resolve();
    expect(dm()).toMatchObject({ lastMessageId: 7, lastMessage: "" });

    second.resolve(serverDms(6, "b", "2026-03-15T09:00:00Z"));
    await second.promise;
    await Promise.resolve();
    expect(dm()).toMatchObject({ lastMessageId: 6, lastMessage: "b" });
  });

  it("reissues the refetch when another delete lands while one is in flight", async () => {
    seedDm(7, "oops, wrong person", "2026-03-15T10:00:00Z");
    const first = deferred<DmChannelsResponse>();
    const second = deferred<DmChannelsResponse>();
    const getDmChannels = vi
      .fn<() => Promise<DmChannelsResponse>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = dmApi(getDmChannels);

    handleChatDeleted(api, { message_id: 7, channel_id: 1 });
    handleChatDeleted(api, { message_id: 6, channel_id: 1 });
    expect(getDmChannels).toHaveBeenCalledTimes(2);

    first.resolve(serverDms(6, "deleted since", "2026-03-15T09:00:00Z"));
    await first.promise;
    await Promise.resolve();
    expect(dm()).toMatchObject({ lastMessageId: 7, lastMessage: "" });

    second.resolve(serverDms(5, "still here", "2026-03-15T08:00:00Z"));
    await second.promise;
    await Promise.resolve();
    expect(dm()).toMatchObject({ lastMessageId: 5, lastMessage: "still here" });
  });

  it("leaves the preview blank when the refetch fails", async () => {
    seedDm(7, "oops, wrong person", "2026-03-15T10:00:00Z");
    const getDmChannels = vi.fn(() => Promise.reject(new Error("offline")));

    handleChatDeleted(dmApi(getDmChannels), { message_id: 7, channel_id: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expectConsole("warn", /Failed to refetch a DM preview after a delete/);

    expect(dm()).toMatchObject({ lastMessageId: 7, lastMessage: "" });
  });

  it("does not refetch when a message other than the shown one is deleted", () => {
    seedDm(7, "latest", "2026-03-15T10:00:00Z");
    const getDmChannels = vi.fn();

    handleChatDeleted(dmApi(getDmChannels), { message_id: 6, channel_id: 1 });

    expect(getDmChannels).not.toHaveBeenCalled();
    expect(dm().lastMessage).toBe("latest");
  });
});

// P4-03: "active" used to mean "the reader is watching", but a minimised or
// unfocused window shows nothing, so a message landing in the active channel
// then must count like one in any other channel (badge, taskbar, divider).
// The focus source is document.hasFocus(), as in lib/notifications.ts.
function seedActiveChannel(lastMessageId: number | null = null): void {
  channelsStore.setState(() => ({
    channels: new Map([
      [
        1,
        {
          id: 1,
          name: "general",
          type: "text" as const,
          category: null,
          position: 0,
          unreadCount: 0,
          mentionCount: 0,
          lastMessageId,
          canSend: true,
          topic: "",
          slowMode: 0,
          nsfw: false,
          voiceMaxUsers: 0,
          voiceMaxVideo: 0,
        },
      ],
    ]),
    activeChannelId: 1,
    roles: [],
  }));
}
const channel = () => channelsStore.getState().channels.get(1)!;
const live = (id: number) => chat(id, new Date().toISOString());

describe("handleChatMessage counts the active channel while the window is unfocused (P4-03)", () => {
  beforeEach(() => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "me", avatar: null, role: "member" },
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setDmChannels([]);
    channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  });

  it("counts a message in the active, attached channel while the window is unfocused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    seedActiveChannel();

    handleChatMessage(createReconnectClock(), live(10));

    expect(channel().unreadCount).toBe(1);
  });

  it("counts a mention in the active channel while the window is unfocused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    seedActiveChannel();

    handleChatMessage(createReconnectClock(), { ...live(10), content: "hey @me", mentions: [1] });

    expect(channel().unreadCount).toBe(1);
    expect(channel().mentionCount).toBe(1);
  });

  it("still skips the active channel while the window is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    seedActiveChannel();

    handleChatMessage(createReconnectClock(), live(10));

    expect(channel().unreadCount).toBe(0);
  });

  it("never counts the reader's own message, focused or not", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    seedActiveChannel();

    handleChatMessage(createReconnectClock(), { ...live(10), user: me });

    expect(channel().unreadCount).toBe(0);
  });

  // OC-0328: a frame already reflected in ready's lastMessageId must not count twice.
  it("does not double-count a redelivered frame behind the watermark", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    seedActiveChannel(10);

    handleChatMessage(createReconnectClock(), live(10));

    expect(channel().unreadCount).toBe(0);
  });

  it("counts a message in the open DM while the window is unfocused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    seedDm(5, "earlier", "2026-03-15T09:00:00Z");
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

    handleChatMessage(createReconnectClock(), live(10));

    expect(dm().unreadCount).toBe(1);
  });

  it("does not count a message in the open DM while the window is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    seedDm(5, "earlier", "2026-03-15T09:00:00Z");
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

    handleChatMessage(createReconnectClock(), live(10));

    expect(dm().unreadCount).toBe(0);
  });
});

describe("handleChatMessage counts the active channel while its live tail is out of view", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "me", avatar: null, role: "member" },
    }));
  });
  afterEach(() => {
    setLiveTailInView(1, true);
    vi.restoreAllMocks();
    channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  });

  it("counts a message and a mention while the list is scrolled up", () => {
    seedActiveChannel();
    setLiveTailInView(1, false);

    handleChatMessage(createReconnectClock(), live(10));
    handleChatMessage(createReconnectClock(), { ...live(11), content: "hey @me", mentions: [1] });

    expect(channel().unreadCount).toBe(2);
    expect(channel().mentionCount).toBe(1);
  });

  it("does not count once the live tail is back in view", () => {
    seedActiveChannel();
    setLiveTailInView(1, false);
    setLiveTailInView(1, true);

    handleChatMessage(createReconnectClock(), live(10));

    expect(channel().unreadCount).toBe(0);
  });
});
