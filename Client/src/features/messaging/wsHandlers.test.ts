import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  failPendingOnDisconnect,
  handleChatMessage,
  handleMessagingError,
  handleSendFailure,
} from "./wsHandlers";
import {
  messagesStore,
  addOptimisticMessage,
  resetMessagesStore,
} from "../../stores/messages.store";
import { activatePendingMessages, deactivatePendingMessages } from "../../lib/pendingMessages";
import { createReconnectClock } from "../connection/dispatchContext";
import type { Payload } from "../connection/dispatchContext";

vi.mock("../../lib/notifications", () => ({ notifyIncomingMessage: vi.fn() }));
import { notifyIncomingMessage } from "../../lib/notifications";

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
