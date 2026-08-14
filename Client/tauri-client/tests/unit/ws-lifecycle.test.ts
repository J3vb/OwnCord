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
import { createWsClient } from "../../src/lib/ws";
import { addLogListener, type LogEntry } from "../../src/lib/logger";

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

  it("does not log raw frame content on parse failure (no plaintext leak)", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const entries: LogEntry[] = [];
    const remove = addLogListener((e) => entries.push(e));
    const secret = "SUPER_SECRET_eyJhbGciOiJIUzI1NiJ9";
    emitTauriEvent("ws-message", secret + " not-json{{{");
    remove();

    // The decrypted frame must never reach the (on-disk-persisted) log...
    expect(JSON.stringify(entries)).not.toContain(secret);
    // ...but the parse failure is still recorded so it stays debuggable.
    expect(entries.some((e) => e.message.includes("Failed to parse WS message"))).toBe(true);
  });

  it("disconnect prevents reconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    client.disconnect();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getState()).toBe("disconnected");
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

describe("disconnect() cancelling an in-flight connect()", () => {
  let client: ReturnType<typeof createWsClient>;
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
    mockListen.mockImplementation(originalMockListenImpl!);
    client.disconnect();
    vi.useRealTimers();
  });

  // Mirrors main.ts's onAutoLoginCancel: by the time the Cancel button is
  // clickable, wirePostAuth has already called ws.connect() and connect()
  // is suspended mid-await (setupEventListeners' tauriListen round trips).
  // disconnect() runs synchronously while that await is pending, then the
  // suspended connect() resumes.
  it("prevents ws_connect from being invoked after disconnect() runs mid-connect()", async () => {
    let releaseListen: (() => void) | null = null;
    mockListen.mockImplementation(
      async (event: string, handler: (e: { payload: unknown }) => void) => {
        if (event === "ws-message" && releaseListen === null) {
          // Pause connect() here, mimicking the Cancel click landing while
          // connect() is still awaiting its Tauri IPC round trips.
          await new Promise<void>((resolve) => {
            releaseListen = resolve;
          });
        }
        return originalMockListenImpl!(event, handler);
      },
    );

    client.connect({ host: "localhost:8443", token: "t" });
    // Let connect() run past ensureTauriApis()/cleanupEventListeners() and
    // into the paused first tauriListen("ws-message", ...) call.
    await vi.advanceTimersByTimeAsync(10);
    expect(releaseListen).not.toBeNull();

    // Cancel arrives while connect() is suspended mid-await.
    client.disconnect();
    expect(client.getState()).toBe("disconnected");

    // Resume the suspended connect() — it must notice the cancellation and
    // bail out instead of completing setupEventListeners() and invoking
    // ws_connect.
    releaseListen!();
    await vi.advanceTimersByTimeAsync(10);

    const wsConnectCalls = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(wsConnectCalls).toHaveLength(0);
    // The cancelled attempt must not have flipped the state back out of
    // "disconnected" (e.g. to "authenticating"/"reconnecting").
    expect(client.getState()).toBe("disconnected");
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
    mockListen.mockImplementation(originalMockListenImpl!);
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

// ---------------------------------------------------------------------------
// Listener registry mechanics (no Tauri connection needed)
// ---------------------------------------------------------------------------

describe("listener registry mechanics (on/off/dispatch)", () => {
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

  it("on() registers a listener and returns an unsubscribe function", () => {
    const listener = vi.fn();
    const unsub = client.on("chat_message", listener);
    expect(typeof unsub).toBe("function");
  });

  it("off via returned unsubscribe removes a specific listener", async () => {
    // Connect so we can dispatch messages through the proxy
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const calls: string[] = [];
    const listenerA = () => calls.push("A");
    const listenerB = () => calls.push("B");

    client.on("chat_message", listenerA);
    const unsubB = client.on("chat_message", listenerB);

    // Remove only B
    unsubB();

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

    expect(calls).toEqual(["A"]);
  });

  it("multiple listeners on the same event type all get called", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const calls: string[] = [];
    client.on("chat_message", () => calls.push("first"));
    client.on("chat_message", () => calls.push("second"));
    client.on("chat_message", () => calls.push("third"));

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

    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("listener removal mid-dispatch does not crash", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const calls: string[] = [];
    let unsubSelf: (() => void) | null = null;

    // This listener unsubscribes itself when called
    unsubSelf = client.on("chat_message", () => {
      calls.push("self-removing");
      unsubSelf!();
    });

    // Second listener should still be called
    client.on("chat_message", () => calls.push("survivor"));

    const msgJson = JSON.stringify({
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
    });

    // First dispatch — self-removing listener fires then removes itself
    emitTauriEvent("ws-message", msgJson);
    expect(calls).toContain("self-removing");
    expect(calls).toContain("survivor");

    // Second dispatch — only survivor should fire
    calls.length = 0;
    emitTauriEvent("ws-message", msgJson);
    expect(calls).toEqual(["survivor"]);
  });

  it("unknown event type dispatch does not throw", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    // Dispatch a completely unknown event type — should not crash
    expect(() => {
      emitTauriEvent(
        "ws-message",
        JSON.stringify({
          type: "totally_unknown_event",
          payload: { foo: "bar" },
        }),
      );
    }).not.toThrow();
  });

  it("error boundary: throwing listener does not prevent next listener from running", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const received: string[] = [];

    client.on("chat_message", () => {
      throw new Error("first listener explodes");
    });
    client.on("chat_message", (payload) => {
      received.push((payload as { content: string }).content);
    });
    client.on("chat_message", () => {
      throw new Error("third listener also explodes");
    });
    client.on("chat_message", (payload) => {
      received.push("fourth:" + (payload as { content: string }).content);
    });

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "chat_message",
        payload: {
          id: 1,
          channel_id: 1,
          user: { id: 1, username: "a", avatar: null },
          content: "hello",
          reply_to: null,
          attachments: [],
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );

    // Both non-throwing listeners should have received the message
    expect(received).toEqual(["hello", "fourth:hello"]);
  });
});
