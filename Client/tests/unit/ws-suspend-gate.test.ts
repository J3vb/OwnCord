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
  wsConnectCalls,
  connectAndAuth,
  lastAuthPayload,
  trackStates,
} from "../helpers/wsSuiteHarness";

// U4 follow-up: the wake is no longer gated on the client. A wall-clock gap
// past the wake threshold marks the next dial a wake (`auth.wake = true`) and
// the SERVER decides: it refuses with ANOTHER_DEVICE_ACTIVE only when another
// device actually holds the session. So a lone device reconnects silently on
// wake, and a woken laptop that would displace a live desktop is refused over
// the whole 90 s+ window, not only after 180 s.
describe("wake reconnect signal (U4 follow-up)", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  function reconnects(): unknown[][] {
    return wsConnectCalls();
  }

  /** Lets the backoff dial, opens the socket and checks the wake marker it sent. */
  async function expectRedialWake(wake: true | undefined): Promise<void> {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconnects().length).toBeGreaterThanOrEqual(1);
    emitTauriEvent("ws-state", "open");
    expect(lastAuthPayload().wake).toBe(wake);
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
    await connectAndAuth(client);
    mockInvoke.mockClear();

    await wakeAndDial();

    expect(reconnects().length).toBeGreaterThanOrEqual(1);
    emitTauriEvent("ws-state", "open");
    expect(lastAuthPayload().wake).toBe(true);
  });

  it("marks a 90-180 s freeze as a wake too, closing the silent-displacement window", async () => {
    await connectAndAuth(client);
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
    await connectAndAuth(client);
    mockInvoke.mockClear();

    vi.setSystemTime(Date.now() + 31_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconnects()).toHaveLength(0);

    emitTauriEvent("ws-state", "closed");
    await expectRedialWake(undefined);
  });

  it("an explicit takeover (Use here) after a wake is not marked a wake", async () => {
    await connectAndAuth(client);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    mockInvoke.mockClear();

    // "Use here" is the user's informed takeover, never a passive wake.
    client.connect({ host: "localhost:8443", token: "t" }, { takeover: true });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    expect(lastAuthPayload().wake).toBeUndefined();
  });

  it("a Retry after a failed wake dial still sends wake", async () => {
    await connectAndAuth(client);
    let offline = true;
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ws_connect" && offline
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(undefined),
    );
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    // The first backoff dial fires within 1 s and fails; its retry is at
    // least 1 s further out, so the user's Retry below is the next dial.
    await vi.advanceTimersByTimeAsync(1_000);
    expectConsole("error", /ws_connect failed/);
    offline = false;
    mockInvoke.mockClear();

    // Retry means "reconnect", not "take over from my other device".
    await openSocket(client);

    expect(lastAuthPayload().wake).toBe(true);
  });

  it("a leftover frame on the pre-sleep socket does not clear the wake", async () => {
    await connectAndAuth(client);
    mockInvoke.mockClear();

    // The old socket delivers a retransmitted frame and closes after the wake:
    // only a completed handshake proves the server still holds this session.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong", payload: {} }));
    emitTauriEvent("ws-state", "closed");
    await expectRedialWake(true);
  });

  it("a leftover frame that beats the heartbeat tick still marks the wake", async () => {
    await connectAndAuth(client);
    mockInvoke.mockClear();

    vi.setSystemTime(Date.now() + 10 * 60_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong", payload: {} }));
    emitTauriEvent("ws-state", "closed");
    await expectRedialWake(true);
  });

  it("auth_ok clears the wake so a later ordinary reconnect is unmarked", async () => {
    await connectAndAuth(client);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    emitAuthOk();
    mockInvoke.mockClear();

    emitTauriEvent("ws-state", "closed");
    await expectRedialWake(undefined);
  });

  it("backs off and retries a dial that fails long after the last activity", async () => {
    // The connect page sat idle past the wake threshold before login; the
    // clock was running the whole time, so this is not a wake.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ws_connect" ? Promise.reject(new Error("refused")) : Promise.resolve(undefined),
    );
    const states = trackStates(client);

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("error", /ws_connect failed/);

    expect(states).toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expectConsole("error", /ws_connect failed/);
    expect(reconnects()).toHaveLength(2);
  });

  it("disconnect() clears a pending wake", async () => {
    await connectAndAuth(client);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    client.disconnect();
    mockInvoke.mockClear();

    await openSocket(client);
    expect(lastAuthPayload().wake).toBeUndefined();
  });
});
