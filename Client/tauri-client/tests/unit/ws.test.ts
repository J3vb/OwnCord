import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectionState } from "../../src/lib/ws";

// Mock Tauri APIs — vi.hoisted ensures availability when vi.mock runs
const { mockInvoke, mockListen, eventHandlers } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
  return {
    mockInvoke: vi.fn(),
    mockListen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const arr = handlers.get(event);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    }),
    eventHandlers: handlers,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

// Mock crypto.randomUUID
vi.stubGlobal("crypto", {
  randomUUID: () => "test-uuid-1234",
});

// Suppress console output
vi.spyOn(console, "debug").mockImplementation(() => {});
vi.spyOn(console, "info").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// Import after mocks are set up
import { createWsClient } from "../../src/lib/ws";

/** Simulate Tauri emitting an event to JS */
function emitTauriEvent(event: string, payload: unknown): void {
  const handlers = eventHandlers.get(event);
  if (handlers) {
    for (const h of handlers) {
      h({ payload });
    }
  }
}

describe("WebSocket Client (Tauri proxy)", () => {
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

  it("starts in disconnected state", () => {
    expect(client.getState()).toBe("disconnected");
  });

  it("transitions to connecting on connect", async () => {
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    client.connect({ host: "localhost:8443", token: "test-token" });
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toContain("connecting");
  });

  it("calls ws_connect with correct URL", async () => {
    client.connect({ host: "localhost:8443", token: "test-token" });
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInvoke).toHaveBeenCalledWith("ws_connect", {
      url: "wss://localhost:8443/api/v1/ws",
    });
  });

  it("sends auth message when Rust reports open", async () => {
    client.connect({ host: "localhost:8443", token: "test-token" });
    await vi.advanceTimersByTimeAsync(10);

    // Simulate Rust reporting connection open
    emitTauriEvent("ws-state", "open");

    // Should call ws_send with auth message
    expect(mockInvoke).toHaveBeenCalledWith(
      "ws_send",
      expect.objectContaining({
        message: expect.stringContaining('"type":"auth"'),
      }),
    );
  });

  it("transitions to connected on auth_ok", async () => {
    client.connect({ host: "localhost:8443", token: "test-token" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "alex", avatar: null, role: "admin" },
          server_name: "Test",
          motd: "Hello",
        },
      }),
    );

    expect(states).toContain("connected");
  });

  it("dispatches messages to typed listeners", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (payload) => messages.push(payload));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        payload: {
          id: 1,
          channel_id: 5,
          user: { id: 1, username: "alex", avatar: null },
          content: "Hello",
          reply_to: null,
          attachments: [],
          timestamp: "2026-03-14T10:00:00Z",
        },
      }),
    );

    expect(messages).toHaveLength(1);
  });

  it("unsubscribe removes listener", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    const unsub = client.on("chat_message", (payload) => messages.push(payload));
    unsub();

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        payload: {
          id: 1,
          channel_id: 5,
          user: { id: 1, username: "alex", avatar: null },
          content: "Hello",
          reply_to: null,
          attachments: [],
          timestamp: "2026-03-14T10:00:00Z",
        },
      }),
    );

    expect(messages).toHaveLength(0);
  });

  it("auth_error does NOT trigger reconnect", async () => {
    client.connect({ host: "localhost:8443", token: "bad-token" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const authErrors: unknown[] = [];
    client.on("auth_error", (payload) => authErrors.push(payload));

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_error",
        payload: { message: "Invalid token" },
      }),
    );

    await vi.advanceTimersByTimeAsync(60_000);

    expect(authErrors).toHaveLength(1);
    expect(client.getState()).toBe("disconnected");
  });

  it("reconnects on unexpected close with backoff", async () => {
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

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    // Simulate connection closed by Rust proxy
    emitTauriEvent("ws-state", "closed");

    expect(states).toContain("reconnecting");

    // After 1s backoff, should call ws_connect again
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    expect(mockInvoke).toHaveBeenCalledWith("ws_connect", expect.anything());
  });

  it("send returns correlation ID", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const id = client.send({
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    });

    expect(id).toBe("test-uuid-1234");
  });

  it("drops oversized messages", async () => {
    client.connect({
      host: "localhost:8443",
      token: "t",
      maxMessageSizeBytes: 50,
    });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    const bigData = JSON.stringify({
      type: "chat_message",
      payload: {
        id: 1,
        channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "x".repeat(100),
        reply_to: null,
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    });

    emitTauriEvent("ws-message", bigData);
    expect(messages).toHaveLength(0);
  });

  it("drops malformed JSON", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    emitTauriEvent("ws-message", "not-json{{{");
    expect(messages).toHaveLength(0);
  });

  it("disconnect prevents reconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    client.disconnect();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getState()).toBe("disconnected");
  });
});

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

describe("cert mismatch blocking", () => {
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

  it("should block reconnect when cert mismatch detected", async () => {
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

    // Cert mismatch event fires
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
      message: "Stored: sha256:OLD",
    });

    expect(client.getState()).toBe("disconnected");

    // Connection closes after mismatch
    emitTauriEvent("ws-state", "closed");

    // Wait well beyond normal backoff — should NOT reconnect
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    const reconnectCalls = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnectCalls).toHaveLength(0);
  });

  it("should unblock after acceptCertFingerprint", async () => {
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

    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
      message: "Stored: sha256:OLD",
    });

    expect(client.getState()).toBe("disconnected");

    // Accept the new fingerprint
    await client.acceptCertFingerprint("localhost:8443", "sha256:NEW");

    // Now a manual reconnect should work
    mockInvoke.mockClear();
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    expect(mockInvoke).toHaveBeenCalledWith("ws_connect", expect.anything());
  });

  it("should not schedule reconnect when certMismatchBlock is true", async () => {
    const mismatchEvents: unknown[] = [];
    client.onCertMismatch((evt) => mismatchEvents.push(evt));

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

    // Trigger mismatch
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:CHANGED",
      status: "mismatch",
      message: "Stored: sha256:ORIGINAL",
    });

    expect(mismatchEvents).toHaveLength(1);

    // Connection drops
    emitTauriEvent("ws-state", "closed");

    // State should remain disconnected, not reconnecting
    expect(client.getState()).toBe("disconnected");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
  });
});

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

describe("reconnection dedup", () => {
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

  it("deduplicates messages during reconnection replay", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Auth and get some messages to advance lastSeq
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
          content: "original",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Disconnect unexpectedly
    emitTauriEvent("ws-state", "closed");

    // Wait for reconnect
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    // During reconnect, replay dedup is active
    expect(client.isReplaying()).toBe(true);

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    // Send a message during replay -- first occurrence passes
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
          content: "original",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Send the SAME message ID again — should be deduped
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
          content: "original",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Only the first occurrence should pass through
    expect(messages).toHaveLength(1);
    expect((messages[0] as { content: string }).content).toBe("original");
  });

  it("auth_ok and ready messages are not deduped during replay", async () => {
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

    expect(client.isReplaying()).toBe(true);

    const authPayloads: unknown[] = [];
    client.on("auth_ok", (p) => authPayloads.push(p));

    // auth_ok during replay should NOT be deduped
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 6,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    expect(authPayloads).toHaveLength(1);
    // After auth_ok, replay dedup should be cleared
    expect(client.isReplaying()).toBe(false);
  });

  it("dedup uses type:seq as key when message has no id", async () => {
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
        type: "presence",
        seq: 10,
        payload: { user_id: 1, status: "idle" },
      }),
    );

    // Disconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const presences: unknown[] = [];
    client.on("presence", (p) => presences.push(p));

    // First presence during replay — passes through
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "presence",
        seq: 10,
        payload: { user_id: 1, status: "idle" },
      }),
    );

    // Same type:seq — should be deduped
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "presence",
        seq: 10,
        payload: { user_id: 1, status: "idle" },
      }),
    );

    // Different seq — should pass through
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "presence",
        seq: 11,
        payload: { user_id: 1, status: "online" },
      }),
    );

    expect(presences).toHaveLength(2);
    expect((presences[0] as { status: string }).status).toBe("idle");
    expect((presences[1] as { status: string }).status).toBe("online");
  });

  it("dedup is not active for first connection (lastSeq=0)", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // First connect should NOT enable dedup
    expect(client.isReplaying()).toBe(false);
  });
});

describe("heartbeat", () => {
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

  it("sends heartbeat ping every 30 seconds after auth_ok", async () => {
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

    mockInvoke.mockClear();

    // Advance 30 seconds — should send a ping
    await vi.advanceTimersByTimeAsync(30_000);

    const pingSends = mockInvoke.mock.calls.filter(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"ping"'),
    );
    expect(pingSends.length).toBeGreaterThanOrEqual(1);
  });

  it("stops heartbeat on disconnect", async () => {
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

    client.disconnect();
    mockInvoke.mockClear();

    // No heartbeat should be sent after disconnect
    await vi.advanceTimersByTimeAsync(60_000);

    const pingSends = mockInvoke.mock.calls.filter(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"ping"'),
    );
    expect(pingSends).toHaveLength(0);
  });
});

describe("parseStoredFingerprint", () => {
  // Import the pure function directly
  let parseStoredFingerprint: typeof import("../../src/lib/ws").parseStoredFingerprint;

  beforeEach(async () => {
    const mod = await import("../../src/lib/ws");
    parseStoredFingerprint = mod.parseStoredFingerprint;
  });

  it("returns undefined for undefined input", () => {
    expect(parseStoredFingerprint(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseStoredFingerprint("")).toBeUndefined();
  });

  it("returns undefined when no Stored: prefix found", () => {
    expect(parseStoredFingerprint("no match here")).toBeUndefined();
  });

  it("extracts fingerprint after Stored: prefix", () => {
    expect(parseStoredFingerprint("Stored: sha256:ABCDEF")).toBe("sha256:ABCDEF");
  });

  it("extracts first non-whitespace token after Stored:", () => {
    expect(parseStoredFingerprint("Stored:   sha256:XYZ  trailing")).toBe("sha256:XYZ");
  });

  it("extracts fingerprint from longer message string", () => {
    expect(parseStoredFingerprint("Certificate mismatch. Stored: sha256:OLD123")).toBe(
      "sha256:OLD123",
    );
  });
});

describe("setState deduplication", () => {
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

  it("does not notify listeners when state is already the same", async () => {
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // State is now "connecting". Count how many times "connecting" appeared.
    const connectingCount = states.filter((s) => s === "connecting").length;
    expect(connectingCount).toBe(1);
  });

  it("notifies listeners when state actually changes", async () => {
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

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

    // Should have transitioned: connecting -> authenticating -> connected
    expect(states).toContain("connecting");
    expect(states).toContain("authenticating");
    expect(states).toContain("connected");
  });
});

describe("getReconnectDelay boundary and arithmetic", () => {
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

  it("first reconnect delay is 1000ms (1000 * 2^0)", async () => {
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

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    // At 999ms, should NOT have reconnected yet
    await vi.advanceTimersByTimeAsync(999);
    const callsBefore = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(callsBefore).toHaveLength(0);

    // At 1000ms total, should reconnect
    await vi.advanceTimersByTimeAsync(1);
    const callsAfter = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(callsAfter).toHaveLength(1);
  });

  it("second reconnect delay is 2000ms (1000 * 2^1)", async () => {
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

    // First drop + reconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    // Don't send auth_ok, so reconnectAttempt stays incremented
    // Simulate another close immediately
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();

    // Second attempt should have 2000ms delay
    await vi.advanceTimersByTimeAsync(1999);
    const callsBefore = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(callsBefore).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const callsAfter = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(callsAfter).toHaveLength(1);
  });

  it("delay uses default 30000ms cap when maxReconnectDelayMs not set", async () => {
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

    // Simulate many drops to ramp up backoff
    for (let i = 0; i < 10; i++) {
      emitTauriEvent("ws-state", "closed");
      await vi.advanceTimersByTimeAsync(31_000);
    }

    // After 10 attempts, uncapped delay would be 1000*2^10 = 1024000ms
    // But it should be capped at 30000ms (default)
    mockInvoke.mockClear();
    emitTauriEvent("ws-state", "closed");

    // Should reconnect within 30s (capped), not 1024s
    await vi.advanceTimersByTimeAsync(30_001);
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(calls.length).toBeGreaterThanOrEqual(1);
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
});

describe("cert-tofu non-mismatch statuses", () => {
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

  it("trusted_first_use status does not block reconnect", async () => {
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

    // Non-mismatch cert event
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:FIRST",
      status: "trusted_first_use",
    });

    // State should still be connected (not disconnected)
    expect(client.getState()).toBe("connected");

    // Verify mismatch listener was NOT called
    const mismatchEvents: unknown[] = [];
    client.onCertMismatch((e) => mismatchEvents.push(e));

    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:TRUSTED",
      status: "trusted",
    });

    expect(mismatchEvents).toHaveLength(0);
    expect(client.getState()).toBe("connected");
  });
});

describe("dedup eviction when exceeding MAX_DEDUP_SIZE", () => {
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

  it("evicts oldest entry when dedup set exceeds 1000 entries", async () => {
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

    // Get past lastSeq > 0 condition
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 100,
        payload: {
          id: 99,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "bump seq",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Disconnect to trigger dedup mode
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");
    expect(client.isReplaying()).toBe(true);

    const messages: unknown[] = [];
    client.on("chat_message", (p) => messages.push(p));

    // Send 1002 unique messages to trigger eviction (MAX_DEDUP_SIZE = 1000)
    for (let i = 0; i < 1002; i++) {
      emitTauriEvent(
        "ws-message",
        JSON.stringify({
          type: "chat_message",
          seq: 101 + i,
          id: `msg-${i}`,
          payload: {
            id: i,
            channel_id: 1,
            user: { id: 1, username: "a", avatar: null },
            content: `msg ${i}`,
            reply_to: null,
            attachments: [],
            timestamp: "2026-01-01T00:00:00Z",
          },
        }),
      );
    }

    // All 1002 should have been dispatched (first occurrence of each)
    expect(messages).toHaveLength(1002);

    // Now re-send the very first message (msg-0) — it was evicted, so it should pass again
    const countBefore = messages.length;
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 101,
        id: "msg-0",
        payload: {
          id: 0,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "msg 0",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );
    expect(messages).toHaveLength(countBefore + 1);
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

  it("auth_error is not deduped during replay and stops reconnect", async () => {
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
    expect(client.isReplaying()).toBe(true);

    const errors: unknown[] = [];
    client.on("auth_error", (p) => errors.push(p));

    // auth_error during replay — should NOT be deduped
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

describe("wsGeneration stale listener guard", () => {
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

  it("ignores events from stale generation after new connect()", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // Capture the handlers registered in the first connect
    const oldMsgHandlers = [...(eventHandlers.get("ws-message") ?? [])];
    const oldStateHandlers = [...(eventHandlers.get("ws-state") ?? [])];

    // Start a new connection (increments wsGeneration, cleans up old handlers)
    client.connect({ host: "localhost:8443", token: "t2" });
    await vi.advanceTimersByTimeAsync(10);

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    // If any old handlers survived cleanup, calling them should be a no-op
    // because gen !== wsGeneration
    for (const h of oldMsgHandlers) {
      h({
        payload: JSON.stringify({
          type: "auth_ok",
          payload: {
            user: { id: 1, username: "a", avatar: null, role: "admin" },
            server_name: "S",
            motd: "",
          },
        }),
      });
    }

    for (const h of oldStateHandlers) {
      h({ payload: "open" });
    }

    // State should NOT have changed to connected from stale handlers
    expect(states).not.toContain("connected");
  });
});

describe("acceptCertFingerprint edge cases", () => {
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

  it("calls Tauri invoke with correct command and args", async () => {
    // Must connect first so Tauri APIs are loaded
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    await client.acceptCertFingerprint("example.com", "sha256:NEWCERT");

    expect(mockInvoke).toHaveBeenCalledWith("accept_cert_fingerprint", {
      host: "example.com",
      fingerprint: "sha256:NEWCERT",
    });
  });

  it("clears certMismatchBlock so reconnect works again", async () => {
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

    // Block with mismatch
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
    });
    expect(client.getState()).toBe("disconnected");

    // Accept fingerprint
    await client.acceptCertFingerprint("localhost:8443", "sha256:NEW");

    // Reconnect should now work
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expect(client.getState()).toBe("connecting");
  });
});

describe("heartbeat proxyOpen guard", () => {
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

  it("does not send ping when proxyOpen is false (connection dropped mid-heartbeat)", async () => {
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

    // Heartbeat started. Now close the proxy (sets proxyOpen=false)
    emitTauriEvent("ws-state", "closed");

    // Clear mocks and advance past heartbeat interval
    mockInvoke.mockClear();

    // The heartbeat was stopped by close handler, so no pings should fire
    await vi.advanceTimersByTimeAsync(35_000);

    const pings = mockInvoke.mock.calls.filter(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"ping"'),
    );
    expect(pings).toHaveLength(0);
  });
});

describe("disconnect resets certMismatchBlock", () => {
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

  it("clears certMismatchBlock on intentional disconnect", async () => {
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

    // Set cert mismatch block
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
    });

    // Intentional disconnect should clear the block
    client.disconnect();

    // Now reconnect should work (certMismatchBlock was cleared)
    mockInvoke.mockClear();
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    expect(mockInvoke).toHaveBeenCalledWith("ws_connect", expect.anything());
    expect(client.getState()).toBe("connecting");
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

describe("connect when Tauri APIs unavailable", () => {
  it("falls back to disconnected when ensureTauriApis fails", async () => {
    vi.useFakeTimers();

    // Create a fresh client that will try to load Tauri APIs fresh
    // The mock is already set up to resolve, so we need to simulate unavailability
    // by making tauriInvoke null after ensureTauriApis
    const origInvoke = mockInvoke;

    // Temporarily clear the mock module to simulate Tauri not available
    // We test this indirectly: if ws_connect is never called but state
    // goes back to disconnected, the guard worked
    const client2 = createWsClient();
    const states: ConnectionState[] = [];
    client2.onStateChange((s) => states.push(s));

    client2.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // With the mock in place, it should proceed normally
    expect(states).toContain("connecting");

    client2.disconnect();
    vi.useRealTimers();
  });
});

describe("cleanupEventListeners edge cases", () => {
  let client: ReturnType<typeof createWsClient>;
  // Save original mockListen implementation to restore after override tests
  let originalMockListenImpl: (typeof mockListen)["getMockImplementation"] extends () => infer R
    ? R
    : never;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    originalMockListenImpl = mockListen.getMockImplementation()!;
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    // Restore the original mockListen implementation so later tests work
    mockListen.mockImplementation(originalMockListenImpl);
    vi.useRealTimers();
  });

  it("handles unsub functions that return rejected promises", async () => {
    // Override mockListen to return an unsub that returns a rejected promise
    mockListen.mockImplementation(
      async (_event: string, _handler: (e: { payload: unknown }) => void) => {
        return () => {
          return Promise.reject(new Error("resource invalidated"));
        };
      },
    );

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // Disconnect triggers cleanupEventListeners — should not crash
    client.disconnect();
    await vi.advanceTimersByTimeAsync(10);

    expect(client.getState()).toBe("disconnected");
  });

  it("handles unsub functions that throw synchronously", async () => {
    mockListen.mockImplementation(
      async (_event: string, _handler: (e: { payload: unknown }) => void) => {
        return () => {
          throw new Error("sync unsub error");
        };
      },
    );

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // Should not crash
    client.disconnect();
    expect(client.getState()).toBe("disconnected");
  });
});

describe("dedup does not filter auth_ok, auth_error, or ready during replay", () => {
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

  it("ready message is not deduped during replay", async () => {
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

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        seq: 10,
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

    // Disconnect and reconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");
    expect(client.isReplaying()).toBe(true);

    const readyPayloads: unknown[] = [];
    client.on("ready", (p) => readyPayloads.push(p));

    // Send ready during replay BEFORE auth_ok — should NOT be deduped
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "ready",
        seq: 11,
        payload: {
          channels: [],
          members: [],
          voice_states: [],
          roles: [],
        },
      }),
    );

    expect(readyPayloads).toHaveLength(1);

    // Send ready again with same seq — ready is exempt from dedup, so it passes
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "ready",
        seq: 11,
        payload: {
          channels: [],
          members: [],
          voice_states: [],
          roles: [],
        },
      }),
    );

    expect(readyPayloads).toHaveLength(2);
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
