import { describe, it, expect, vi, afterEach } from "vitest";

import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());

import { mockInvoke, emitTauriEvent, eventHandlers } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";
import { attachRecorder } from "../../src/lib/diagnostics/eventSink";
import { expectConsole } from "../helpers/console";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import {
  WS_CONFIG,
  authOkFrame,
  chatMessage,
  collect,
  connectAndAuth,
  emitAuthOk,
  expectAuthLastSeq,
  openSocket,
  trackStates,
  wsConnectCalls,
} from "../helpers/wsSuiteHarness";

function emit(frame: unknown): void {
  emitTauriEvent("ws-message", JSON.stringify(frame));
}

// Each server frame is checked against the shape its type promises before any
// listener sees it. A frame that fails is dropped whole and only its type and
// field name are logged; a bad handshake frame ends the connect.
describe("ws frame shape check", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
  });

  function recordEvents(): Array<{ code: string; fields: Readonly<Record<string, unknown>> }> {
    const seen: Array<{ code: string; fields: Readonly<Record<string, unknown>> }> = [];
    detach = attachRecorder((code, fields) => {
      if (code === "ws.frame_invalid") seen.push({ code, fields });
    });
    // The sink replays what it buffered before a recorder attached.
    seen.length = 0;
    return seen;
  }

  function withoutContent(secret: string): unknown {
    const { content: _content, ...rest } = chatMessage({ content: secret }).payload;
    return { type: "chat_message", payload: rest };
  }

  it("dispatches a valid frame", async () => {
    await connectAndAuth(client);
    const received = collect(client, "chat_message");
    emit(chatMessage());
    expect(received).toHaveLength(1);
  });

  it("drops a frame missing a required field, logging the path and recording the event", async () => {
    await connectAndAuth(client);
    const received = collect(client, "chat_message");
    const events = recordEvents();

    emit(withoutContent("private words"));

    expect(received).toHaveLength(0);
    expectConsole("warn", /Invalid WS frame, dropping.*"type":"chat_message".*"path":"content"/);
    expect(events).toEqual([
      { code: "ws.frame_invalid", fields: { type: "chat_message", field: "content" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("private words");
  });

  it("drops a frame whose nested field has the wrong type", async () => {
    await connectAndAuth(client);
    const received = collect(client, "chat_message");
    const events = recordEvents();
    const bad = chatMessage();
    (bad.payload.user as { username: unknown }).username = 7;

    emit(bad);

    expect(received).toHaveLength(0);
    expectConsole("warn", /Invalid WS frame, dropping.*user\.username/);
    expect(events[0]?.fields.field).toBe("user.username");
  });

  it("still dispatches a frame with a field this client does not know", async () => {
    await connectAndAuth(client);
    const received = collect(client, "chat_message");
    const events = recordEvents();
    const frame = chatMessage();

    emit({ ...frame, payload: { ...frame.payload, added_by_a_newer_server: { x: 1 } } });

    expect(received).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it("passes a frame type it has no shape for through as before", async () => {
    await connectAndAuth(client);
    const events = recordEvents();

    emit({ type: "brand_new_event", payload: { anything: true } });

    expect(events).toHaveLength(0);
  });

  it("a bad sequenced frame redials as a fresh connect, so the server answers with a full state", async () => {
    await connectAndAuth(client);
    const bad = withoutContent("x") as { type: string; payload: unknown };
    emit({ ...bad, seq: 7 });
    expectConsole("warn", /Invalid WS frame, dropping/);

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(wsConnectCalls()).toHaveLength(1);
    emitTauriEvent("ws-state", "open");
    expectAuthLastSeq(0);
  });

  it("the same bad frame right after the fresh state waits longer before the next redial", async () => {
    await connectAndAuth(client);
    const bad = withoutContent("x") as { type: string; payload: unknown };
    emit({ ...bad, seq: 7 });
    expectConsole("warn", /Invalid WS frame, dropping/);
    await vi.advanceTimersByTimeAsync(5_001);
    emitTauriEvent("ws-state", "open");
    emitAuthOk({ replaySource: "none" });

    emit({ ...bad, seq: 8 });
    expectConsole("warn", /Invalid WS frame, dropping/);
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(wsConnectCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_200);
    expect(wsConnectCalls()).toHaveLength(1);
  });

  it("a bad frame without a seq does not ask for a fresh state", async () => {
    await connectAndAuth(client);
    emit(withoutContent("x"));
    expectConsole("warn", /Invalid WS frame, dropping/);

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsConnectCalls()).toHaveLength(0);
  });

  it("an unreadable auth_error ends the connect instead of redialling", async () => {
    await openSocket(client);
    const faults: number[] = [];
    client.onHandshakeFault(() => faults.push(1));
    emit({ type: "auth_error", payload: {} });
    expectConsole("warn", /Invalid WS frame, dropping.*"type":"auth_error"/);
    expect(faults).toHaveLength(1);

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(wsConnectCalls()).toHaveLength(0);
  });

  it("a throwing fault listener does not stop the others or the teardown", async () => {
    await connectAndAuth(client);
    const later: number[] = [];
    client.onHandshakeFault(() => {
      throw new Error("listener broke");
    });
    client.onHandshakeFault(() => later.push(1));
    const states = trackStates(client);

    emit({ type: "ready", payload: {} });

    expectConsole("warn", /Invalid WS frame, dropping/);
    expectConsole("error", /Handshake fault listener error/);
    expect(later).toHaveLength(1);
    expect(states).toContain("disconnected");
  });

  it("a bad ready ends the connect, tells the listener and does not dispatch", async () => {
    await connectAndAuth(client);
    const ready = collect(client, "ready");
    const faults: number[] = [];
    client.onHandshakeFault(() => faults.push(1));
    const states = trackStates(client);
    const events = recordEvents();

    emit({ type: "ready", payload: { channels: "not a list" } });

    expect(ready).toHaveLength(0);
    expect(faults).toHaveLength(1);
    expect(states).toContain("disconnected");
    expect(events).toHaveLength(1);
    expectConsole("warn", /Invalid WS frame, dropping.*"type":"ready"/);

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(wsConnectCalls()).toHaveLength(0);
  });

  it("a bad auth_ok never reaches connected and is not retried", async () => {
    await openSocket(client);
    const authOk = collect(client, "auth_ok");
    const faults: number[] = [];
    client.onHandshakeFault(() => faults.push(1));
    const states = trackStates(client);

    emit({ type: "auth_ok", payload: { server_name: "S" } });

    expect(authOk).toHaveLength(0);
    expect(faults).toHaveLength(1);
    expect(states).not.toContain("connected");
    expect(states).toContain("disconnected");
    expectConsole("warn", /Invalid WS frame, dropping.*"type":"auth_ok"/);

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(wsConnectCalls()).toHaveLength(0);
  });

  it("a valid auth_ok still connects", async () => {
    await openSocket(client);
    const states = trackStates(client);
    emitTauriEvent("ws-message", authOkFrame());
    expect(states).toContain("connected");
  });

  it("does nothing for a bad frame that arrives on a superseded attempt", async () => {
    client.connect(WS_CONFIG);
    await vi.advanceTimersByTimeAsync(10);
    const oldHandlers = [...(eventHandlers.get("ws-message") ?? [])];
    client.connect({ ...WS_CONFIG, token: "t2" });
    await vi.advanceTimersByTimeAsync(10);

    const faults: number[] = [];
    client.onHandshakeFault(() => faults.push(1));
    const states = trackStates(client);
    const events = recordEvents();

    for (const handler of oldHandlers) {
      handler({ payload: JSON.stringify({ type: "ready", payload: {} }) });
    }

    expect(faults).toHaveLength(0);
    expect(states).not.toContain("disconnected");
    expect(events).toHaveLength(0);
  });
});
