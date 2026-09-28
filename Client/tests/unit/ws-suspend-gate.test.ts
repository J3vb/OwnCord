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

describe("suspend wake gate (U4)", () => {
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

  function reconnects(): unknown[][] {
    return mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
  }

  it("holds the reconnect after a long suspend and notifies the app", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    const wakes: number[] = [];
    client.onSuspendWake(() => wakes.push(1));
    mockInvoke.mockClear();

    // The suspend moves the wall clock without running any timer: the next
    // heartbeat tick lands far past its interval.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expectConsole("warn", /\[ws\] Woke from suspend; holding the reconnect/);

    expect(wakes).toHaveLength(1);
    expect(states).toContain("disconnected");
    expect(reconnects()).toHaveLength(0);

    // And the gate holds: no later tick dials on its own.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reconnects()).toHaveLength(0);
    expect(wakes).toHaveLength(1);
  });

  it("dials again when the user chooses after a suspend", async () => {
    await connectAndAuth();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expectConsole("warn", /\[ws\] Woke from suspend; holding the reconnect/);
    mockInvoke.mockClear();

    // The user's own reconnect (the banner's Reconnect here action) clears the
    // gate and dials.
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    expect(reconnects().length).toBeGreaterThanOrEqual(1);
  });

  it("gates the reconnect when the socket closed and then the process slept", async () => {
    await connectAndAuth();
    // The socket closes first (a Wi-Fi drop before the lid shut), then the
    // machine sleeps: no timer runs during the suspend, so only the wall clock
    // shows it. The reconnect timer fires on wake and must gate, not dial —
    // this is the sequence that let a laptop reclaim a desktop's call.
    emitTauriEvent("ws-state", "closed");
    vi.setSystemTime(Date.now() + 10 * 60_000);
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    expectConsole("warn", /\[ws\] Woke from suspend; holding the reconnect/);
    expect(reconnects()).toHaveLength(0);

    // The gate holds against later backoff ticks.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reconnects()).toHaveLength(0);
  });

  it("does not gate an ordinary socket close", async () => {
    await connectAndAuth();
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(1_100);

    expect(reconnects().length).toBeGreaterThanOrEqual(1);
  });

  it("does not gate a throttled ~60 s gap", async () => {
    await connectAndAuth();
    const wakes: number[] = [];
    client.onSuspendWake(() => wakes.push(1));

    // A long-hidden page's intensive throttling spaces ticks ~60 s apart,
    // under the 90 s suspend threshold.
    vi.setSystemTime(Date.now() + 31_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(wakes).toHaveLength(0);
  });

  it("backs off and retries a dial that fails long after the last activity", async () => {
    const wakes: number[] = [];
    client.onSuspendWake(() => wakes.push(1));
    // The connect page sat idle past the suspend threshold before the user
    // logged in; the clock was running the whole time.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ws_connect" ? Promise.reject(new Error("refused")) : Promise.resolve(undefined),
    );
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("error", /ws_connect failed/);

    expect(wakes).toHaveLength(0);
    expect(states).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expectConsole("error", /ws_connect failed/);
    expect(reconnects()).toHaveLength(2);
    expect(wakes).toHaveLength(0);
  });

  it("disconnect() does not leave a stale suspend notification", async () => {
    await connectAndAuth();
    const wakes: number[] = [];
    client.onSuspendWake(() => wakes.push(1));
    client.disconnect();

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(wakes).toHaveLength(0);
  });
});
