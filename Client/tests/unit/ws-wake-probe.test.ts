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

function pingSends(): unknown[][] {
  return mockInvoke.mock.calls.filter(
    (c) =>
      c[0] === "ws_send" &&
      typeof c[1]?.message === "string" &&
      (c[1].message as string).includes('"type":"ping"'),
  );
}

describe("wake probe (U7d)", () => {
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

  it("reconnects when the wake probe's pong never arrives", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    mockInvoke.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));

    await vi.advanceTimersByTimeAsync(15_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    expect(states).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(1_100);
    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
  });

  it("stays connected when the wake probe's pong arrives", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    mockInvoke.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));

    // Feed the heartbeat's own pings too, or its unanswered ping would trip
    // the ordinary CLI-01 deadline independently of the wake probe.
    await vi.advanceTimersByTimeAsync(30_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(30_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));

    expect(states).not.toContain("reconnecting");
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect")).toHaveLength(0);
  });

  it("probes when the device's network returns", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();

    window.dispatchEvent(new Event("online"));

    expect(pingSends().length).toBeGreaterThanOrEqual(1);
  });

  it("probes when the document becomes visible again", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(pingSends().length).toBeGreaterThanOrEqual(1);
  });

  it("probes on the first heartbeat after the wall clock jumped over a sleep", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    mockInvoke.mockClear();

    // The suspend moves the wall clock without running any timer.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pingSends()).toHaveLength(1);

    // The 15 s pong grace, not the 60 s silence deadline, decides the redial.
    await vi.advanceTimersByTimeAsync(15_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    expect(states).toContain("reconnecting");
  });

  it("keeps the 60 s silence deadline for an on-time heartbeat", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    await vi.advanceTimersByTimeAsync(45_000);

    expect(states).not.toContain("reconnecting");
  });

  it("does not probe while disconnected", async () => {
    mockInvoke.mockClear();

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(pingSends()).toHaveLength(0);
  });

  it("stops probing after disconnect", async () => {
    await connectAndAuth();
    client.disconnect();
    mockInvoke.mockClear();

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(pingSends()).toHaveLength(0);
  });
});
