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
import { createWsClient, setActiveChannelProvider } from "../../src/lib/ws";

/** Parses the payload of the most recent `auth` frame sent via ws_send. */
function getAuthPayload(): Record<string, unknown> {
  const authCall = mockInvoke.mock.calls.find(
    (c) =>
      c[0] === "ws_send" &&
      typeof c[1]?.message === "string" &&
      (c[1].message as string).includes('"type":"auth"'),
  );
  expect(authCall).toBeDefined();
  const parsed = JSON.parse((authCall![1] as { message: string }).message) as {
    payload: Record<string, unknown>;
  };
  return parsed.payload;
}

describe("auth frame: active_channel_id + reconnect-replay dedup arming", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    // activeChannelProvider is a module-level singleton (registered once at
    // app bootstrap in dispatcher.ts) — reset it so state doesn't leak across
    // tests/files.
    setActiveChannelProvider(null);
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    setActiveChannelProvider(null);
    vi.useRealTimers();
  });

  it("fresh connect (reconnectAttempt=0, lastSeq=0): no active_channel_id key even with a provider registered, and dedup is not armed", async () => {
    setActiveChannelProvider(() => 99);
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(payload, "active_channel_id")).toBe(false);
    expect(client.isReplaying()).toBe(false);
  });

  it("reconnect with lastSeq > 0 and a registered provider: active_channel_id carries the provider's id", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 7,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    setActiveChannelProvider(() => 42);

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(7);
    expect(payload.active_channel_id).toBe(42);
  });

  it("reconnect with lastSeq > 0 and NO provider registered: no active_channel_id key", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 3,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // No setActiveChannelProvider call — stays null from beforeEach reset.
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(payload, "active_channel_id")).toBe(false);
  });

  it("reconnect with lastSeq > 0 and a provider that returns null: no active_channel_id key", async () => {
    setActiveChannelProvider(() => null);

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 4,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(4);
    expect(Object.prototype.hasOwnProperty.call(payload, "active_channel_id")).toBe(false);
  });

  it("lastSeq > 0 but reconnectAttempt === 0: the provider is still consulted (gated on lastSeq, not reconnect count) and dedup stays unarmed", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    // First "open": reconnectAttempt=0, lastSeq=0 — irrelevant, just gets us started.
    emitTauriEvent("ws-state", "open");

    // Bump lastSeq WITHOUT ever going through a "closed"/scheduleReconnect
    // cycle, so reconnectAttempt never increments off 0.
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "presence",
        seq: 9,
        payload: { user_id: 1, status: "idle" },
      }),
    );

    setActiveChannelProvider(() => 5);
    mockInvoke.mockClear();

    // Rust reports "open" again on the same (never-closed) connection.
    emitTauriEvent("ws-state", "open");

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(9);
    expect(payload.active_channel_id).toBe(5);
    // Dedup requires reconnectAttempt > 0 too — must still be unarmed.
    expect(client.isReplaying()).toBe(false);
  });

  it("reconnectAttempt > 0 but lastSeq === 0: no active_channel_id key and dedup stays unarmed", async () => {
    setActiveChannelProvider(() => 5);

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    // No message ever arrives — lastSeq stays 0.

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open"); // reconnectAttempt is now 1, lastSeq is still 0

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(payload, "active_channel_id")).toBe(false);
    expect(client.isReplaying()).toBe(false);
  });

  it("dedup is armed only when BOTH reconnectAttempt > 0 AND lastSeq > 0: a genuine reconnect replay dedups a repeated message (fresh-connect non-arming is covered above)", async () => {
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

    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    // Both conditions true now: reconnectAttempt=1, lastSeq=1.
    expect(client.isReplaying()).toBe(true);

    const replayed: unknown[] = [];
    client.on("chat_message", (p) => replayed.push(p));

    const dupMsg = JSON.stringify({
      type: "chat_message",
      seq: 5,
      id: "dup-msg",
      payload: {
        id: 1,
        channel_id: 1,
        user: { id: 1, username: "a", avatar: null },
        content: "replayed",
        reply_to: null,
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    });
    emitTauriEvent("ws-message", dupMsg);
    emitTauriEvent("ws-message", dupMsg);

    expect(replayed).toHaveLength(1);
  });
});
