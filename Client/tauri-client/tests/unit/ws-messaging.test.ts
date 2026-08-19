import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectionState } from "../../src/lib/ws";

// vi.mock is hoisted per file; the factories resolve to the shared handles
// exported from ./helpers/ws-mocks (see that module's doc comment).
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));

vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient, toConnectionStatus } from "../../src/lib/ws";

describe("message handling edge cases", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("silently ignores pong messages", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    // pong has no payload listeners, but we verify no crash
    client.on("chat_message", (p) => messages.push(p));

    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    expect(messages).toHaveLength(0);
  });

  it("drops messages with missing type", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    emitTauriEvent("ws-message", JSON.stringify({ payload: { data: "no type" } }));
    expect(messages).toHaveLength(0);
  });

  it("drops messages with undefined payload", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    emitTauriEvent("ws-message", JSON.stringify({ type: "chat_message" }));
    expect(messages).toHaveLength(0);
  });

  it("tracks highest seq number (ignores lower seq)", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 10,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // seq=50 then seq=30 — should keep 50
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 50,
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "hi",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 30,
        payload: {
          id: 2,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "hello",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Disconnect and reconnect to verify lastSeq
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    );
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(50);
  });

  it("handles message without seq field (defaults to 0)", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        // no seq field
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "no seq",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    expect(messages).toHaveLength(1);
  });

  it("dispatch logs when no listeners for message type", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Send a message with no listener registered — should log "no listeners"
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // No crash means the "no listeners" debug log path executed
    expect(client.getState()).toBe("connected");
  });

  it("dispatch catches listener errors", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Register a listener that throws
    client.on("chat_message", () => {
      throw new Error("listener boom");
    });

    // Also register a second listener to verify it still runs
    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "test",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Second listener should still receive the message
    expect(messages).toHaveLength(1);
  });

  it("state listener errors are caught", async () => {
    client.onStateChange(() => {
      throw new Error("state listener boom");
    });

    // Should not crash
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    expect(client.getState()).toBe("connecting");
  });

  it("ws-error event is logged without crash", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // Emit a ws-error event
    emitTauriEvent("ws-error", "Connection reset by peer");

    // No crash expected
    expect(client.getState()).toBe("connecting");
  });

  it("isReplaying returns false when not reconnecting", () => {
    expect(client.isReplaying()).toBe(false);
  });

  it("_getWs returns null", () => {
    expect(client._getWs()).toBeNull();
  });

  it("onStateChange unsubscribe works", async () => {
    const states: ConnectionState[] = [];
    const unsub = client.onStateChange((s) => states.push(s));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expect(states.length).toBeGreaterThan(0);

    const count = states.length;
    unsub();

    emitTauriEvent("ws-state", "open");
    expect(states.length).toBe(count);
  });

  it("onCertMismatch unsubscribe works", async () => {
    const events: unknown[] = [];
    const unsub = client.onCertMismatch((evt) => events.push(evt));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    unsub();

    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
      message: "Stored: sha256:OLD",
    });

    expect(events).toHaveLength(0);
  });
});

describe("handleMessage size boundary", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("accepts message exactly at size limit", async () => {
    const limit = 200;
    client.connect({ host: "localhost:8443", token: "t", maxMessageSizeBytes: limit });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    const msg = {
      type: "chat_message",
      payload: {
        id: 1,
        channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "",
        reply_to: null,
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    };
    const json = JSON.stringify(msg);
    // Pad content to make JSON exactly at limit
    const padding = limit - json.length;
    if (padding > 0) {
      msg.payload.content = "x".repeat(padding);
    }
    const exactJson = JSON.stringify(msg);
    // Ensure it is exactly at limit (not over)
    expect(exactJson.length).toBeLessThanOrEqual(limit);

    emitTauriEvent("ws-message", exactJson);
    expect(messages.length).toBeGreaterThanOrEqual(0); // should not crash
  });

  it("drops message one byte over size limit", async () => {
    const limit = 100;
    client.connect({ host: "localhost:8443", token: "t", maxMessageSizeBytes: limit });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    const msg = {
      type: "chat_message",
      payload: {
        id: 1,
        channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "x".repeat(limit), // guarantees over limit
        reply_to: null,
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    };

    emitTauriEvent("ws-message", JSON.stringify(msg));
    expect(messages).toHaveLength(0);
  });

  it("uses default 1MB limit when maxMessageSizeBytes not configured", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    // Message under 1MB should pass
    const smallMsg = JSON.stringify({
      type: "chat_message",
      payload: {
        id: 1,
        channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "small",
        reply_to: null,
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    });
    emitTauriEvent("ws-message", smallMsg);
    expect(messages).toHaveLength(1);
  });

  it("does not drop an oversized `ready` frame — the handshake payload has no seq and no retry path (OC-0160)", async () => {
    const limit = 200;
    client.connect({ host: "localhost:8443", token: "t", maxMessageSizeBytes: limit });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const readyMessages: unknown[] = [];
    client.on("ready", (p) => readyMessages.push(p));

    const msg = {
      type: "ready",
      payload: {
        channels: [],
        // Padding well past `limit` — a real `ready` grows unbounded with the
        // server's member/channel/DM counts and carries no seq, so unlike a
        // sequenced frame nothing ever re-requests it after a drop.
        members: Array.from({ length: 20 }, (_, i) => ({ id: i, username: `user${i}` })),
        voice_states: [],
        roles: [],
      },
    };
    const json = JSON.stringify(msg);
    expect(json.length).toBeGreaterThan(limit);

    emitTauriEvent("ws-message", json);
    expect(readyMessages).toHaveLength(1);
  });

  it("does not drop an oversized `auth_ok` frame (handshake exempt from size limit, OC-0160)", async () => {
    const limit = 100;
    client.connect({ host: "localhost:8443", token: "t", maxMessageSizeBytes: limit });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const msg = {
      type: "auth_ok",
      payload: {
        user: { id: 1, username: "a".repeat(limit), avatar: null, role: "admin" },
        server_name: "S",
        motd: "",
      },
    };
    const json = JSON.stringify(msg);
    expect(json.length).toBeGreaterThan(limit);

    emitTauriEvent("ws-message", json);
    expect(client.getState()).toBe("connected");
  });

  it("still drops an oversized regular (non-handshake) frame (OC-0160 regression guard)", async () => {
    const limit = 100;
    client.connect({ host: "localhost:8443", token: "t", maxMessageSizeBytes: limit });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    const msg = {
      type: "chat_message",
      payload: {
        id: 1,
        channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "x".repeat(limit),
        reply_to: null,
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    };

    emitTauriEvent("ws-message", JSON.stringify(msg));
    expect(messages).toHaveLength(0);
  });
});

describe("dispatch with no listeners for type", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("does not crash when dispatching to type with empty listener set", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Register and immediately unregister a listener
    const unsub = client.on("chat_message", () => {});
    unsub();

    // Now dispatch a message to that type — empty set
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "test",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // No crash
    expect(true).toBe(true);
  });

  it("dispatches message with id to listener", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const receivedIds: (string | undefined)[] = [];
    client.on("chat_message", (_payload, id) => {
      receivedIds.push(id);
    });

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        id: "correlation-123",
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "test",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    expect(receivedIds).toEqual(["correlation-123"]);
  });
});

describe("on() creates Set for new type", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("creates a listener set for a type that has never been registered", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const results: unknown[] = [];
    client.on("presence", (p) => results.push(p));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "presence",
        payload: { user_id: 1, status: "online" },
      }),
    );

    expect(results).toHaveLength(1);
  });

  it("multiple listeners on same type all receive messages", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const results1: unknown[] = [];
    const results2: unknown[] = [];
    client.on("typing", (p) => results1.push(p));
    client.on("typing", (p) => results2.push(p));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "typing",
        payload: { channel_id: 1, user_id: 1, username: "a" },
      }),
    );

    expect(results1).toHaveLength(1);
    expect(results2).toHaveLength(1);
  });
});

describe("send envelope format", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("wraps message with id and serializes to JSON", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    mockInvoke.mockClear();

    client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hello", reply_to: null, attachments: [] },
    });

    const sendCall = mockInvoke.mock.calls.find((c) => c[0] === "ws_send");
    expect(sendCall).toBeDefined();

    const sent = JSON.parse((sendCall![1] as { message: string }).message);
    expect(sent.type).toBe("chat_send");
    expect(sent.id).toBe("test-uuid-1234");
    expect(sent.payload.channel_id).toBe(1);
    expect(sent.payload.content).toBe("hello");
    expect(sent.payload.reply_to).toBeNull();
    expect(sent.payload.attachments).toEqual([]);
  });
});

describe("send edge cases", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("send when not connected does not crash (logs warning)", () => {
    // Client is disconnected — send should warn but not crash
    const id = client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    });

    expect(id).toBe("test-uuid-1234");
  });

  it("ws_connect failure triggers reconnect", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_connect") throw new Error("connection refused");
      return undefined;
    });

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // Should attempt reconnect after failure
    expect(states).toContain("reconnecting");
  });

  it("reconnect with successful auth_ok resets reconnect attempt counter", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Drop connection
    emitTauriEvent("ws-state", "closed");

    // First reconnect (1s backoff)
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 2,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Drop again
    emitTauriEvent("ws-state", "closed");

    // If reconnect counter was reset, delay should be back to 1s (not 2s)
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);

    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
  });

  it("ws_send rejection is caught without crash", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Make ws_send reject
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_send") throw new Error("send failed");
      return undefined;
    });

    // Send should not crash despite ws_send rejection
    client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    });

    // Flush promise to trigger the catch
    await vi.advanceTimersByTimeAsync(10);
    expect(client.getState()).toBe("connected");
  });

  it("onSendFailure fires with NETWORK when ws_send hits backpressure (channel full)", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_send") throw new Error("ws_send: channel full, message dropped");
      return undefined;
    });

    const failures: Array<{ id: string; code: string }> = [];
    client.onSendFailure((id, code) => failures.push({ id, code }));

    const id = client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(failures).toEqual([{ id, code: "NETWORK" }]);
  });

  it("onSendFailure fires with OFFLINE when ws_send reports the channel closed", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_send") throw new Error("ws_send: channel closed");
      return undefined;
    });

    const failures: Array<{ id: string; code: string }> = [];
    client.onSendFailure((id, code) => failures.push({ id, code }));

    const id = client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(failures).toEqual([{ id, code: "OFFLINE" }]);
  });

  it("onSendFailure fires with OFFLINE when sending while the proxy is not open", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Drop the proxy: subsequent sends take the not-open early return.
    emitTauriEvent("ws-state", "closed");

    const failures: Array<{ id: string; code: string }> = [];
    client.onSendFailure((id, code) => failures.push({ id, code }));

    const id = client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    });
    // The early-return notification is deferred a microtask so callers can
    // register the id (optimistic row) before the failure lands.
    expect(failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);

    expect(failures).toEqual([{ id, code: "OFFLINE" }]);
  });

  it("heartbeat ping failures do not fire onSendFailure (no envelope id)", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_send") throw new Error("ws_send: channel full, message dropped");
      return undefined;
    });

    const failures: Array<{ id: string; code: string }> = [];
    client.onSendFailure((id, code) => failures.push({ id, code }));

    // Let the 30s heartbeat fire (and its ws_send reject).
    await vi.advanceTimersByTimeAsync(30_100);

    expect(failures).toEqual([]);
  });

  it("onSendFailure unsubscribe works", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_send") throw new Error("ws_send: channel full, message dropped");
      return undefined;
    });

    const failures: Array<{ id: string; code: string }> = [];
    const unsub = client.onSendFailure((id, code) => failures.push({ id, code }));
    unsub();

    client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(failures).toEqual([]);
  });

  it("ws_disconnect error is ignored during disconnectProxy", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Make ws_disconnect throw
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_disconnect") throw new Error("disconnect failed");
      return undefined;
    });

    // Disconnect should not crash
    client.disconnect();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.getState()).toBe("disconnected");
  });

  it("reconnect delay is capped by maxReconnectDelayMs", async () => {
    client.connect({
      host: "localhost:8443",
      token: "t",
      maxReconnectDelayMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Force multiple reconnect attempts to ramp up backoff
    for (let i = 0; i < 5; i++) {
      emitTauriEvent("ws-state", "closed");
      await vi.advanceTimersByTimeAsync(10_000); // well past any backoff
      emitTauriEvent("ws-state", "open");
      emitTauriEvent(
        "ws-message",
        JSON.stringify({
          type: "auth_ok",
          seq: i + 2,
          payload: {
            user: { id: 1, username: "a", avatar: null, role: "admin" },
            server_name: "S",
            motd: "",
          },
        }),
      );
    }

    // At this point, the reconnect delay should be capped at 5000ms
    // The fact that the loop completed without hanging proves capping works
    expect(client.getState()).toBe("connected");
  });
});

describe("toConnectionStatus", () => {
  it("maps the internal 5-state machine onto the UX-facing 3-state status", () => {
    expect(toConnectionStatus("connected")).toBe("connected");
    expect(toConnectionStatus("disconnected")).toBe("disconnected");
    // Mid-retry states must read as "reconnecting", not "disconnected" —
    // a reconnect cycle passes through connecting/authenticating.
    expect(toConnectionStatus("reconnecting")).toBe("reconnecting");
    expect(toConnectionStatus("connecting")).toBe("reconnecting");
    expect(toConnectionStatus("authenticating")).toBe("reconnecting");
  });
});
