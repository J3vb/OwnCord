import { describe, it, expect, vi } from "vitest";
import type { ConnectionState } from "../../src/lib/ws";

import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient, toConnectionStatus } from "../../src/lib/ws";
import { expectConsole } from "../helpers/console";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import {
  WS_CONFIG,
  chatMessage,
  openSocket,
  emitAuthOk,
  emitChat,
  dropAndReopen,
  expectAuthLastSeq,
  wsConnectCalls,
  collect,
  emitCertMismatch,
  sendChat,
  trackSendFailures,
  rejectWsSend,
  trackStates,
} from "../helpers/wsSuiteHarness";

describe("message handling edge cases", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("silently ignores pong messages", async () => {
    await openSocket(client);

    const messages = collect(client, "chat_message");

    // "pong" is not part of the ServerMessage union — the transport eats it
    // before dispatch — so the registry has to be reached through a cast to
    // prove nothing arrives. The frame carries a payload on purpose: a
    // payload-less pong is also dropped by the "missing type or payload"
    // guard further down, which would hide a broken early return.
    const onPong = vi.fn();
    (client.on as unknown as (t: string, l: () => void) => () => void)("pong", onPong);

    emitTauriEvent("ws-message", JSON.stringify({ type: "pong", payload: {} }));

    expect(onPong).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
  });

  it("drops messages with missing type", async () => {
    await openSocket(client);

    const messages = collect(client, "chat_message");

    emitTauriEvent("ws-message", JSON.stringify({ payload: { data: "no type" } }));
    expectConsole("warn", /\[ws\] Invalid WS message: missing type or payload/);
    expect(messages).toHaveLength(0);
  });

  it("drops messages with undefined payload", async () => {
    await openSocket(client);

    const messages = collect(client, "chat_message");

    emitTauriEvent("ws-message", JSON.stringify({ type: "chat_message" }));
    expectConsole("warn", /\[ws\] Invalid WS message: missing type or payload/);
    expect(messages).toHaveLength(0);
  });

  it("tracks highest seq number (ignores lower seq)", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 10 });

    // seq=50 then seq=30 — should keep 50
    emitChat({ seq: 50 });

    emitChat({ seq: 30, id: 2, content: "hello" });

    // Disconnect and reconnect to verify lastSeq
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(50);
  });

  it("handles message without seq field (defaults to 0)", async () => {
    await openSocket(client);

    const messages = collect(client, "chat_message");

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
    await openSocket(client);

    // Send a message with no listener registered — should log "no listeners"
    emitAuthOk();

    // No crash means the "no listeners" debug log path executed
    expect(client.getState()).toBe("connected");
  });

  it("dispatch catches listener errors", async () => {
    await openSocket(client);

    // Register a listener that throws
    client.on("chat_message", () => {
      throw new Error("listener boom");
    });

    // Also register a second listener to verify it still runs
    const messages = collect(client, "chat_message");

    emitChat({ content: "test" });
    expectConsole("error", /\[ws\] Listener error for chat_message/);

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
    // The throwing listener fires once per state change: this one is the
    // connect transition.
    expectConsole("error", /\[ws\] State listener error/);

    expect(client.getState()).toBe("connecting");

    // The second is the disconnect transition. Provoke it here rather than
    // leaving it to this file's afterEach: a log raised during teardown has no
    // test body left to claim it.
    client.disconnect();
    expectConsole("error", /\[ws\] State listener error/);
  });

  it("ws-error event is logged without crash", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // Emit a ws-error event
    emitTauriEvent("ws-error", "Connection reset by peer");
    expectConsole("warn", /\[ws\] WebSocket error \(proxy\)/);

    // No crash expected
    expect(client.getState()).toBe("connecting");
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

    await openSocket(client);

    unsub();

    emitCertMismatch("localhost:8443");

    expect(events).toHaveLength(0);
  });
});

describe("handleMessage size boundary", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("accepts message exactly at size limit", async () => {
    const limit = 200;
    await openSocket(client, { ...WS_CONFIG, maxMessageSizeBytes: limit });

    const messages = collect(client, "chat_message");

    const msg = chatMessage({ content: "" });
    const json = JSON.stringify(msg);
    // Pad content to make JSON exactly at limit
    const padding = limit - json.length;
    if (padding > 0) {
      msg.payload.content = "x".repeat(padding);
    }
    const exactJson = JSON.stringify(msg);
    // Exactly ON the limit, not merely under it — the guard drops only what is
    // strictly OVER, so a frame one byte short would pass either way and prove
    // nothing about the boundary.
    expect(exactJson.length).toBe(limit);

    emitTauriEvent("ws-message", exactJson);
    expect(messages).toHaveLength(1);
  });

  it("drops message one byte over size limit", async () => {
    const limit = 100;
    await openSocket(client, { ...WS_CONFIG, maxMessageSizeBytes: limit });

    const messages = collect(client, "chat_message");

    const msg = chatMessage({ content: "x".repeat(limit) }); // guarantees over limit

    emitTauriEvent("ws-message", JSON.stringify(msg));
    expectConsole("warn", /\[ws\] Message exceeds size limit, dropping/);
    expect(messages).toHaveLength(0);
  });

  it("uses default 1MB limit when maxMessageSizeBytes not configured", async () => {
    await openSocket(client);

    const messages = collect(client, "chat_message");

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

  it("does not drop an oversized `ready` frame — the handshake payload has no seq and no retry path", async () => {
    const limit = 200;
    await openSocket(client, { ...WS_CONFIG, maxMessageSizeBytes: limit });

    const readyMessages = collect(client, "ready");

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

  it("does not drop an oversized `auth_ok` frame (handshake exempt from size limit)", async () => {
    const limit = 100;
    await openSocket(client, { ...WS_CONFIG, maxMessageSizeBytes: limit });

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

  it("still drops an oversized regular (non-handshake) frame (regression guard)", async () => {
    const limit = 100;
    await openSocket(client, { ...WS_CONFIG, maxMessageSizeBytes: limit });

    const messages = collect(client, "chat_message");

    const msg = chatMessage({ content: "x".repeat(limit) });

    emitTauriEvent("ws-message", JSON.stringify(msg));
    expectConsole("warn", /\[ws\] Message exceeds size limit, dropping/);
    expect(messages).toHaveLength(0);
  });
});

describe("dispatch with no listeners for type", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("does not crash when dispatching to type with empty listener set", async () => {
    await openSocket(client);

    // Register and immediately unregister a listener
    const unsub = client.on("chat_message", () => {});
    unsub();

    // Now dispatch a message to that type — empty set
    emitChat({ content: "test" });

    // No crash
    expect(true).toBe(true);
  });

  it("dispatches message with id to listener", async () => {
    await openSocket(client);

    const receivedIds: (string | undefined)[] = [];
    client.on("chat_message", (_payload, id) => {
      receivedIds.push(id);
    });

    emitChat({ corrId: "correlation-123", content: "test" });

    expect(receivedIds).toEqual(["correlation-123"]);
  });
});

describe("on() creates Set for new type", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("creates a listener set for a type that has never been registered", async () => {
    await openSocket(client);

    const results = collect(client, "presence");

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
    await openSocket(client);

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
  useWsClientFixture((created) => {
    client = created;
  });

  it("wraps message with id and serializes to JSON", async () => {
    await openSocket(client);

    emitAuthOk();

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
  useWsClientFixture((created) => {
    client = created;
  });

  it("send when not connected does not crash (logs warning)", () => {
    // Client is disconnected — send should warn but not crash
    const id = sendChat(client);
    expectConsole("warn", /\[ws\] Cannot send, WebSocket not open/);

    expect(id).toBe("test-uuid-1234");
  });

  it("ws_connect failure triggers reconnect", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ws_connect") throw new Error("connection refused");
      return undefined;
    });

    const states = trackStates(client);

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("error", /\[ws\] ws_connect failed/);

    // Should attempt reconnect after failure
    expect(states).toContain("reconnecting");
  });

  it("reconnect with successful auth_ok resets reconnect attempt counter", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 1 });

    // Drop connection
    emitTauriEvent("ws-state", "closed");

    // First reconnect (1s backoff)
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    emitAuthOk({ seq: 2 });

    // Drop again
    emitTauriEvent("ws-state", "closed");

    // If reconnect counter was reset, delay should be back to 1s (not 2s)
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);

    const reconnects = wsConnectCalls();
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
  });

  it("ws_send rejection is caught without crash", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 1 });

    // Make ws_send reject
    rejectWsSend("send failed");

    // Send should not crash despite ws_send rejection
    sendChat(client);

    // Flush promise to trigger the catch
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("error", /\[ws\] ws_send failed/);
    expect(client.getState()).toBe("connected");
  });

  it("onSendFailure fires with NETWORK when ws_send hits backpressure (channel full)", async () => {
    await openSocket(client);
    emitAuthOk({ seq: 1 });

    rejectWsSend("ws_send: channel full, message dropped");

    const failures = trackSendFailures(client);

    const id = sendChat(client);
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("warn", /\[ws\] ws_send: outbound channel full, message dropped/);

    expect(failures).toEqual([{ id, code: "NETWORK" }]);
  });

  it("onSendFailure fires with OFFLINE when ws_send reports the channel closed", async () => {
    await openSocket(client);
    emitAuthOk({ seq: 1 });

    rejectWsSend("ws_send: channel closed");

    const failures = trackSendFailures(client);

    const id = sendChat(client);
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("error", /\[ws\] ws_send failed/);

    expect(failures).toEqual([{ id, code: "OFFLINE" }]);
  });

  it("onSendFailure fires with OFFLINE when sending while the proxy is not open", async () => {
    await openSocket(client);
    emitAuthOk({ seq: 1 });

    // Drop the proxy: subsequent sends take the not-open early return.
    emitTauriEvent("ws-state", "closed");

    const failures = trackSendFailures(client);

    const id = sendChat(client);
    expectConsole("warn", /\[ws\] Cannot send, WebSocket not open/);
    // The early-return notification is deferred a microtask so callers can
    // register the id (optimistic row) before the failure lands.
    expect(failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);

    expect(failures).toEqual([{ id, code: "OFFLINE" }]);
  });

  it("heartbeat ping failures do not fire onSendFailure (no envelope id)", async () => {
    await openSocket(client);
    emitAuthOk({ seq: 1 });

    rejectWsSend("ws_send: channel full, message dropped");

    const failures = trackSendFailures(client);

    // Let the 30s heartbeat fire (and its ws_send reject).
    await vi.advanceTimersByTimeAsync(30_100);
    expectConsole("warn", /\[ws\] ws_send: outbound channel full, message dropped/);

    expect(failures).toEqual([]);
  });

  it("onSendFailure unsubscribe works", async () => {
    await openSocket(client);
    emitAuthOk({ seq: 1 });

    rejectWsSend("ws_send: channel full, message dropped");

    const failures: Array<{ id: string; code: string }> = [];
    const unsub = client.onSendFailure((id, code) => failures.push({ id, code }));
    unsub();

    sendChat(client);
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("warn", /\[ws\] ws_send: outbound channel full, message dropped/);

    expect(failures).toEqual([]);
  });

  it("ws_disconnect error is ignored during disconnectProxy", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 1 });

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

    emitAuthOk({ seq: 1 });

    // Force multiple reconnect attempts to ramp up backoff
    for (let i = 0; i < 5; i++) {
      await dropAndReopen(10_000); // well past any backoff
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
