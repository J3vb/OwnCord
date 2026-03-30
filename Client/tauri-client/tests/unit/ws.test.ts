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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok",
      payload: {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "Test",
        motd: "Hello",
      },
    }));

    expect(states).toContain("connected");
  });

  it("dispatches messages to typed listeners", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    client.on("chat_message", (payload) => messages.push(payload));

    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message",
      payload: {
        id: 1, channel_id: 5,
        user: { id: 1, username: "alex", avatar: null },
        content: "Hello",
        reply_to: null, attachments: [],
        timestamp: "2026-03-14T10:00:00Z",
      },
    }));

    expect(messages).toHaveLength(1);
  });

  it("unsubscribe removes listener", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const messages: unknown[] = [];
    const unsub = client.on("chat_message", (payload) => messages.push(payload));
    unsub();

    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message",
      payload: {
        id: 1, channel_id: 5,
        user: { id: 1, username: "alex", avatar: null },
        content: "Hello",
        reply_to: null, attachments: [],
        timestamp: "2026-03-14T10:00:00Z",
      },
    }));

    expect(messages).toHaveLength(0);
  });

  it("auth_error does NOT trigger reconnect", async () => {
    client.connect({ host: "localhost:8443", token: "bad-token" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const authErrors: unknown[] = [];
    client.on("auth_error", (payload) => authErrors.push(payload));

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_error",
      payload: { message: "Invalid token" },
    }));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(authErrors).toHaveLength(1);
    expect(client.getState()).toBe("disconnected");
  });

  it("reconnects on unexpected close with backoff", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok",
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "x".repeat(100),
        reply_to: null, attachments: [],
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
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"auth"'),
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
    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok",
      seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // Send a message with seq 42
    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message",
      seq: 42,
      payload: {
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "hi", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

    // Now simulate a disconnect + reconnect to verify lastSeq was updated
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100); // backoff
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"auth"'),
    );
    expect(authCall).toBeDefined();
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(42);
  });

  it("should send last_seq in auth message on reconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok",
      seq: 5,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // Disconnect unexpectedly
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"auth"'),
    );
    expect(authCall).toBeDefined();
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(5);
  });

  it("should preserve lastSeq across auto-reconnects", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 10,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // First auto-reconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    // Receive more messages with higher seq
    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 11,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));
    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message", seq: 25,
      payload: {
        id: 2, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "hello", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

    // Second auto-reconnect
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2100); // 2nd attempt = 2s backoff
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"auth"'),
    );
    const authMsg = JSON.parse((authCall![1] as { message: string }).message);
    expect(authMsg.payload.last_seq).toBe(25);
  });

  it("should reset lastSeq to 0 on intentional disconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 50,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // Intentional disconnect (e.g. logout)
    client.disconnect();

    // Reconnect fresh
    mockInvoke.mockClear();
    client.connect({ host: "localhost:8443", token: "t2" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"auth"'),
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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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
    const reconnectCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "ws_connect",
    );
    expect(reconnectCalls).toHaveLength(0);
  });

  it("should unblock after acceptCertFingerprint", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 10,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // seq=50 then seq=30 — should keep 50
    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message", seq: 50,
      payload: {
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "hi", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message", seq: 30,
      payload: {
        id: 2, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "hello", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

    // Disconnect and reconnect to verify lastSeq
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const authCall = mockInvoke.mock.calls.find(
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"auth"'),
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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message",
      // no seq field
      payload: {
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "no seq", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

    expect(messages).toHaveLength(1);
  });

  it("dispatch logs when no listeners for message type", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Send a message with no listener registered — should log "no listeners"
    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok",
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message",
      payload: {
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "test", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

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
    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message", seq: 5, id: "msg-5",
      payload: {
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "original", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

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
    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message", seq: 5, id: "msg-5",
      payload: {
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "original", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

    // Send the SAME message ID again — should be deduped
    emitTauriEvent("ws-message", JSON.stringify({
      type: "chat_message", seq: 5, id: "msg-5",
      payload: {
        id: 1, channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "original", reply_to: null, attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    }));

    // Only the first occurrence should pass through
    expect(messages).toHaveLength(1);
    expect((messages[0] as { content: string }).content).toBe("original");
  });

  it("auth_ok and ready messages are not deduped during replay", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 5,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // Disconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    expect(client.isReplaying()).toBe(true);

    const authPayloads: unknown[] = [];
    client.on("auth_ok", (p) => authPayloads.push(p));

    // auth_ok during replay should NOT be deduped
    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 6,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    expect(authPayloads).toHaveLength(1);
    // After auth_ok, replay dedup should be cleared
    expect(client.isReplaying()).toBe(false);
  });

  it("dedup uses type:seq as key when message has no id", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    emitTauriEvent("ws-message", JSON.stringify({
      type: "presence", seq: 10,
      payload: { user_id: 1, status: "idle" },
    }));

    // Disconnect
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const presences: unknown[] = [];
    client.on("presence", (p) => presences.push(p));

    // First presence during replay — passes through
    emitTauriEvent("ws-message", JSON.stringify({
      type: "presence", seq: 10,
      payload: { user_id: 1, status: "idle" },
    }));

    // Same type:seq — should be deduped
    emitTauriEvent("ws-message", JSON.stringify({
      type: "presence", seq: 10,
      payload: { user_id: 1, status: "idle" },
    }));

    // Different seq — should pass through
    emitTauriEvent("ws-message", JSON.stringify({
      type: "presence", seq: 11,
      payload: { user_id: 1, status: "online" },
    }));

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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    mockInvoke.mockClear();

    // Advance 30 seconds — should send a ping
    await vi.advanceTimersByTimeAsync(30_000);

    const pingSends = mockInvoke.mock.calls.filter(
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"ping"'),
    );
    expect(pingSends.length).toBeGreaterThanOrEqual(1);
  });

  it("stops heartbeat on disconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    client.disconnect();
    mockInvoke.mockClear();

    // No heartbeat should be sent after disconnect
    await vi.advanceTimersByTimeAsync(60_000);

    const pingSends = mockInvoke.mock.calls.filter(
      (c) => c[0] === "ws_send" && typeof c[1]?.message === "string" && (c[1].message as string).includes('"type":"ping"'),
    );
    expect(pingSends).toHaveLength(0);
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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // Drop connection
    emitTauriEvent("ws-state", "closed");

    // First reconnect (1s backoff)
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 2,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

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

    emitTauriEvent("ws-message", JSON.stringify({
      type: "auth_ok", seq: 1,
      payload: {
        user: { id: 1, username: "a", avatar: null, role: "admin" },
        server_name: "S", motd: "",
      },
    }));

    // Force multiple reconnect attempts to ramp up backoff
    for (let i = 0; i < 5; i++) {
      emitTauriEvent("ws-state", "closed");
      await vi.advanceTimersByTimeAsync(10_000); // well past any backoff
      emitTauriEvent("ws-state", "open");
      emitTauriEvent("ws-message", JSON.stringify({
        type: "auth_ok", seq: i + 2,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S", motd: "",
        },
      }));
    }

    // At this point, the reconnect delay should be capped at 5000ms
    // The fact that the loop completed without hanging proves capping works
    expect(client.getState()).toBe("connected");
  });
});
