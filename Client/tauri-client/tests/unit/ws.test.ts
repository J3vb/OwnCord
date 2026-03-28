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
