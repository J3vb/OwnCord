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

// U4 follow-up: the wake is no longer gated on the client. A wall-clock gap
// past the wake threshold marks the next dial a wake (`auth.wake = true`) and
// the SERVER decides: it refuses with ANOTHER_DEVICE_ACTIVE only when another
// device actually holds the session. So a lone device reconnects silently on
// wake, and a woken laptop that would displace a live desktop is refused over
// the whole 90 s+ window, not only after 180 s.
describe("wake reconnect signal (U4 follow-up)", () => {
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

  function lastAuthPayload(): Record<string, unknown> {
    const call = mockInvoke.mock.calls
      .filter(
        (c) =>
          c[0] === "ws_send" &&
          typeof c[1]?.message === "string" &&
          (c[1].message as string).includes('"type":"auth"'),
      )
      .at(-1);
    expect(call).toBeDefined();
    return JSON.parse((call![1] as { message: string }).message).payload as Record<string, unknown>;
  }

  /** Drive a suspend wake through the heartbeat probe and the failed-pong
   *  reconnect, then let the dial happen and read the auth frame it sent. */
  async function wakeAndDial(): Promise<void> {
    // The suspend moves the wall clock without running timers: the next
    // heartbeat tick lands far past its interval, marking a pending wake and
    // probing the (dead) socket.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    // The probe's pong never arrives; the liveness deadline schedules the
    // reconnect, which dials with the wake marker.
    await vi.advanceTimersByTimeAsync(15_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    await vi.advanceTimersByTimeAsync(2_000);
  }

  it("reconnects after a long suspend, marking the dial as a wake", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();

    await wakeAndDial();

    expect(reconnects().length).toBeGreaterThanOrEqual(1);
    emitTauriEvent("ws-state", "open");
    expect(lastAuthPayload().wake).toBe(true);
  });

  it("marks a 90-180 s freeze as a wake too, closing the silent-displacement window", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();

    // A gap past the wake threshold but under the old 180 s gate: this is the
    // window where a woken laptop used to displace the desktop silently.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    await vi.advanceTimersByTimeAsync(2_000);

    emitTauriEvent("ws-state", "open");
    expect(reconnects().length).toBeGreaterThanOrEqual(1);
    expect(lastAuthPayload().wake).toBe(true);
  });

  it("does not mark a throttled ~60 s gap as a wake", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();

    vi.setSystemTime(Date.now() + 31_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // No wake flag on the (still connected) socket's next ordinary frames; the
    // point is that no wake reconnect was armed.
    expect(reconnects()).toHaveLength(0);
  });

  it("an explicit user connect after a wake is not marked a wake", async () => {
    await connectAndAuth();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    mockInvoke.mockClear();

    // The user's own Reconnect ("Use here") is a deliberate takeover, never a
    // passive wake: no wake flag.
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    expect(lastAuthPayload().wake).toBeUndefined();
  });

  it("backs off and retries a dial that fails long after the last activity", async () => {
    // The connect page sat idle past the wake threshold before login; the
    // clock was running the whole time, so this is not a wake.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ws_connect" ? Promise.reject(new Error("refused")) : Promise.resolve(undefined),
    );
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("error", /ws_connect failed/);

    expect(states).toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expectConsole("error", /ws_connect failed/);
    expect(reconnects()).toHaveLength(2);
  });

  it("disconnect() clears a pending wake", async () => {
    await connectAndAuth();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    client.disconnect();
    mockInvoke.mockClear();

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    expect(lastAuthPayload().wake).toBeUndefined();
  });
});
