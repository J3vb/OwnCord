import { describe, it, expect, vi } from "vitest";

import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";
import { expectConsole } from "../helpers/console";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import {
  openSocket,
  emitAuthOk,
  emitChat,
  dropAndReopen,
  expectAuthLastSeq,
  wsConnectCalls,
  collect,
  expectNoReconnectAfterDrop,
} from "../helpers/wsSuiteHarness";

describe("lastSeq tracking", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("should start with lastSeq = 0", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    // When open fires, auth message should contain last_seq: 0
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(0);
  });

  it("should update lastSeq from seq field in incoming messages", async () => {
    await openSocket(client);

    // Send auth_ok so we're connected
    emitAuthOk({ seq: 1 });

    // Send a message with seq 42
    emitChat({ seq: 42 });

    // Now simulate a disconnect + reconnect to verify lastSeq was updated
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100); // backoff
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(42);
  });

  it("should send last_seq in auth message on reconnect", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 5 });

    // Disconnect unexpectedly
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(5);
  });

  it("should preserve lastSeq across auto-reconnects", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 10 });

    // First auto-reconnect
    await dropAndReopen();

    // Receive more messages with higher seq
    emitAuthOk({ seq: 11 });
    emitChat({ seq: 25, id: 2, content: "hello" });

    // Second auto-reconnect
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2100); // 2nd attempt = 2s backoff
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(25);
  });

  it("resets lastSeq when auth_ok reports replay_source: none (full resync)", async () => {
    await openSocket(client);

    // Initial connect — lastSeq climbs to 5000 via live traffic (no seq on
    // auth_ok itself, matching the real server: h.buildAuthOK never sets a
    // top-level "seq" field).
    emitAuthOk({ replaySource: "none" });
    emitChat({ seq: 5000 });

    // Socket drops; server restarted meanwhile with its seq counter reset
    // (event_persistence.enabled=false), so the reconnect's replay tier is a
    // full resync — auth_ok comes back with replay_source: "none" again.
    await dropAndReopen();

    emitAuthOk({ replaySource: "none" });

    // A subsequent drop must send last_seq=0 (adopting the server's new
    // epoch), not the stale 5000 watermark from the old epoch.
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2100); // 2nd attempt = 2s backoff
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(0);
  });

  it("does NOT reset lastSeq when auth_ok reports replay_source: buffer/db (real resume)", async () => {
    await openSocket(client);

    emitAuthOk({ replaySource: "none" });
    emitChat({ seq: 42 });

    await dropAndReopen();

    // A real resume from the ring buffer/DB — must NOT reset lastSeq.
    emitAuthOk({ replaySource: "buffer" });

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2100);
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(42);
  });

  it("should reset lastSeq to 0 on intentional disconnect", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 50 });

    // Intentional disconnect (e.g. logout)
    client.disconnect();

    // Reconnect fresh
    mockInvoke.mockClear();
    await openSocket(client, { host: "localhost:8443", token: "t2" });

    expectAuthLastSeq(0);
  });
});

describe("reconnection replay handling", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("dispatches replay-burst frames arriving after auth_ok verbatim (no client-side dedup layer)", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 1 });
    emitChat({ seq: 5, corrId: "msg-5", content: "before disconnect" });

    await dropAndReopen();

    // The server writes auth_ok BEFORE the replay burst
    // (reconnectWriteReplay), so replayed frames land in the connected state
    // exactly like live ones. The ws layer applies them verbatim — the old
    // replayDedup machinery keyed off a pre-auth_ok window that never exists
    // against a spec-compliant server and was removed (audit-2026-08-19
    // F-6); duplicate handling belongs to the stores.
    emitAuthOk({ seq: 5, replaySource: "buffer" });

    const messages = collect(client, "chat_message");

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
  useWsClientFixture((created) => {
    client = created;
  });

  it("does NOT update lastSeq when seq equals current lastSeq (> not >=)", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 10 });

    // Send message with same seq=10 — should NOT change lastSeq
    emitChat({ seq: 10, content: "same seq" });

    // Verify lastSeq is still 10 via reconnect auth message
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(10);
  });

  it("treats non-number seq as 0", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 5 });

    // Send message with string seq — treated as 0, should not reduce lastSeq
    emitChat({ seq: "not-a-number", content: "bad seq" });

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    expectAuthLastSeq(5);
  });
});

describe("scheduleReconnect guard clauses", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("does not reconnect when intentionalClose is true (disconnect called)", async () => {
    await openSocket(client);

    emitAuthOk();

    // Intentional disconnect sets intentionalClose=true
    client.disconnect();
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    const reconnects = wsConnectCalls();
    expect(reconnects).toHaveLength(0);
    expect(client.getState()).toBe("disconnected");
  });

  it("does not reconnect when certMismatchBlock is true", async () => {
    await openSocket(client);

    emitAuthOk();

    // Trigger cert mismatch
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
    });
    expectConsole("error", /\[ws\] Certificate fingerprint mismatch/);

    await expectNoReconnectAfterDrop(60_000);
  });

  it("reconnect timer callback bails out safely when config is cleared", async () => {
    await openSocket(client);

    emitAuthOk();

    // Unexpected close schedules reconnect.
    emitTauriEvent("ws-state", "closed");

    // Simulate config being cleared before timer callback executes.
    client.disconnect();
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    const reconnects = wsConnectCalls();
    expect(reconnects).toHaveLength(0);
    expect(client.getState()).toBe("disconnected");
  });
});

describe("auth_error during reconnection replay", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("auth_error after a reconnect handshake stops reconnection", async () => {
    await openSocket(client);

    emitAuthOk({ seq: 5 });

    // Disconnect
    await dropAndReopen();

    const errors = collect(client, "auth_error");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_error",
        payload: { message: "Token expired" },
      }),
    );
    expectConsole("error", /\[ws\] Authentication failed/);

    expect(errors).toHaveLength(1);
    expect(client.getState()).toBe("disconnected");

    // Should not reconnect after auth_error
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    const reconnects = wsConnectCalls();
    expect(reconnects).toHaveLength(0);
  });
});

describe("auth_ok during reconnection logs reconnect info", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("resets reconnectAttempt to 0 after successful reconnect auth_ok", async () => {
    await openSocket(client);

    emitAuthOk();

    // First drop
    await dropAndReopen(); // 1s backoff

    emitAuthOk();

    // Second drop — if reconnectAttempt was reset, delay is back to 1s not 2s
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    // At 1s should reconnect (not 2s)
    await vi.advanceTimersByTimeAsync(1000);
    const calls = wsConnectCalls();
    expect(calls).toHaveLength(1);
  });
});
