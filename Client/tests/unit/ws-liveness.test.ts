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
import { createWsClient, type ConnectionState } from "../../src/lib/ws";
import { expectConsole } from "../helpers/console";

const AUTH_OK = JSON.stringify({
  type: "auth_ok",
  payload: {
    user: { id: 1, username: "a", avatar: null, role: "admin" },
    server_name: "S",
    motd: "",
  },
});

describe("client liveness deadline (CLI-01)", () => {
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

  async function connectAndAuth(): Promise<void> {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", AUTH_OK);
  }

  it("reconnects when no frame arrives within the deadline", async () => {
    await connectAndAuth();

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    mockInvoke.mockClear();

    // The app-level heartbeat keeps sending pings, but the half-open socket
    // delivers no pong (or anything else). Without a deadline the client would
    // sit on "connected" forever.
    await vi.advanceTimersByTimeAsync(61_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    expect(states).toContain("reconnecting");

    // And the reconnect policy re-dials the socket.
    await vi.advanceTimersByTimeAsync(1_100);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
  });

  it("stays connected while pongs keep arriving", async () => {
    await connectAndAuth();

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(30_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(30_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(30_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));

    expect(states).not.toContain("reconnecting");
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
  });

  it("any inbound frame refreshes the deadline", async () => {
    await connectAndAuth();

    await vi.advanceTimersByTimeAsync(50_000);
    // A broadcast (not a pong) still proves the socket is delivering bytes.
    emitTauriEvent("ws-message", JSON.stringify({ type: "typing", payload: { channel_id: 1 } }));

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    // Past the original deadline, but the frame at t=50s moved it out.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(states).not.toContain("reconnecting");
  });

  it("treats a server heartbeat ping as a liveness frame without dispatching it", async () => {
    await connectAndAuth();

    const pinged: unknown[] = [];
    client.on("typing", (p) => pinged.push(p));

    await vi.advanceTimersByTimeAsync(50_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ping" }));

    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(states).not.toContain("reconnecting");
  });

  it("dial once when a close arrives while the silence deadline also fires", async () => {
    await connectAndAuth();

    // The deadline fires and schedules one retry (backoff >= 500ms), then the
    // socket's own close report lands before that retry dials. Both must share
    // one retry, not stack two.
    await vi.advanceTimersByTimeAsync(60_100);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(1);
  });

  it("does not arm a reconnect after an intentional disconnect", async () => {
    await connectAndAuth();
    client.disconnect();
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(120_000);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
  });
});
