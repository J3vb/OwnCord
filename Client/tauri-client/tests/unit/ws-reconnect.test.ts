import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted per file; the factories resolve to the shared handles
// exported from ./helpers/ws-mocks (see that module's doc comment).
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));

vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";

describe("lastSeq tracking", () => {
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

  it("should start with lastSeq = 0", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // When open fires, auth message should contain last_seq: 0
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    );
    expect(authCall).toBeDefined();
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(0);
  });

  it("should update lastSeq from seq field in incoming messages", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Send auth_ok so we're connected
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

    // Send a message with seq 42
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 42,
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

    // Now simulate a disconnect + reconnect to verify lastSeq was updated
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100); // backoff
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    );
    expect(authCall).toBeDefined();
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(42);
  });

  it("should send last_seq in auth message on reconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 5,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Disconnect unexpectedly
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
    expect(authCall).toBeDefined();
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(5);
  });

  it("should preserve lastSeq across auto-reconnects", async () => {
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

    // First auto-reconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    // Receive more messages with higher seq
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 11,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 25,
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

    // Second auto-reconnect
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2100); // 2nd attempt = 2s backoff
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    );
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(25);
  });

  it("resets lastSeq when auth_ok reports replay_source: none (full resync)", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Initial connect — lastSeq climbs to 5000 via live traffic (no seq on
    // auth_ok itself, matching the real server: h.buildAuthOK never sets a
    // top-level "seq" field).
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
          replay_source: "none",
        },
      }),
    );
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 5000,
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

    // Socket drops; server restarted meanwhile with its seq counter reset
    // (event_persistence.enabled=false), so the reconnect's replay tier is a
    // full resync — auth_ok comes back with replay_source: "none" again.
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
          replay_source: "none",
        },
      }),
    );

    // A subsequent drop must send last_seq=0 (adopting the server's new
    // epoch), not the stale 5000 watermark from the old epoch.
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2100); // 2nd attempt = 2s backoff
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    );
    expect(authCall).toBeDefined();
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(0);
  });

  it("does NOT reset lastSeq when auth_ok reports replay_source: buffer/db (real resume)", async () => {
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
          replay_source: "none",
        },
      }),
    );
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 42,
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

    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    // A real resume from the ring buffer/DB — must NOT reset lastSeq.
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
          replay_source: "buffer",
        },
      }),
    );

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2100);
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    );
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(42);
  });

  it("should reset lastSeq to 0 on intentional disconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 50,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Intentional disconnect (e.g. logout)
    client.disconnect();

    // Reconnect fresh
    mockInvoke.mockClear();
    client.connect({ host: "localhost:8443", token: "t2" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    );
    expect(authCall).toBeDefined();
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(0);
  });
});

describe("reconnection replay handling", () => {
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

  it("dispatches replay-burst frames arriving after auth_ok verbatim (no client-side dedup layer)", async () => {
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
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 5,
        id: "msg-5",
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "before disconnect",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    // The server writes auth_ok BEFORE the replay burst
    // (reconnectWriteReplay), so replayed frames land in the connected state
    // exactly like live ones. The ws layer applies them verbatim — the old
    // replayDedup machinery keyed off a pre-auth_ok window that never exists
    // against a spec-compliant server and was removed (audit-2026-08-19
    // F-6); duplicate handling belongs to the stores.
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 5,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
          replay_source: "buffer",
        },
      }),
    );

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    const replayFrame = JSON.stringify({
      type: "chat_message",
      seq: 6,
      id: "msg-6",
      payload: {
        id: 2,
        channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "replayed",
        reply_to: null,
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    });
    emitTauriEvent("ws-message", replayFrame);
    emitTauriEvent("ws-message", replayFrame);

    expect(messages).toHaveLength(2);
  });
});

describe("seq tracking boundary conditions", () => {
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

  it("does NOT update lastSeq when seq equals current lastSeq (> not >=)", async () => {
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

    // Send message with same seq=10 — should NOT change lastSeq
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 10,
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "same seq",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Verify lastSeq is still 10 via reconnect auth message
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
    expect(authMsg.payload.last_seq).toBe(10);
  });

  it("treats non-number seq as 0", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 5,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Send message with string seq — treated as 0, should not reduce lastSeq
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: "not-a-number",
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "bad seq",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

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
    expect(authMsg.payload.last_seq).toBe(5);
  });
});

describe("scheduleReconnect guard clauses", () => {
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

  it("does not reconnect when intentionalClose is true (disconnect called)", async () => {
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

    // Intentional disconnect sets intentionalClose=true
    client.disconnect();
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
    expect(client.getState()).toBe("disconnected");
  });

  it("does not reconnect when certMismatchBlock is true", async () => {
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

    // Trigger cert mismatch
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
    });

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
  });

  it("reconnect timer callback bails out safely when config is cleared", async () => {
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

    // Unexpected close schedules reconnect.
    emitTauriEvent("ws-state", "closed");

    // Simulate config being cleared before timer callback executes.
    client.disconnect();
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
    expect(client.getState()).toBe("disconnected");
  });
});

describe("auth_error during reconnection replay", () => {
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

  it("auth_error after a reconnect handshake stops reconnection", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 5,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Disconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const errors: unknown[] = [];
    client.on("auth_error", (p) => errors.push(p));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_error",
        payload: { message: "Token expired" },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(client.getState()).toBe("disconnected");

    // Should not reconnect after auth_error
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
  });
});

describe("auth_ok during reconnection logs reconnect info", () => {
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

  it("resets reconnectAttempt to 0 after successful reconnect auth_ok", async () => {
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

    // First drop
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100); // 1s backoff
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

    // Second drop — if reconnectAttempt was reset, delay is back to 1s not 2s
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    // At 1s should reconnect (not 2s)
    await vi.advanceTimersByTimeAsync(1000);
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(calls).toHaveLength(1);
  });
});
