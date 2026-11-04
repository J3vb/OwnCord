import { describe, it, expect, vi } from "vitest";

import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";
import { expectConsole } from "../helpers/console";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import { wsConnectCalls, trackStates, connectAndAuth } from "../helpers/wsSuiteHarness";

describe("client liveness deadline", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("reconnects when no frame arrives within the deadline", async () => {
    await connectAndAuth(client);

    const states = trackStates(client);
    mockInvoke.mockClear();

    // The app-level heartbeat keeps sending pings, but the half-open socket
    // delivers no pong (or anything else). Without a deadline the client would
    // sit on "connected" forever.
    await vi.advanceTimersByTimeAsync(61_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    expect(states).toContain("reconnecting");

    // And the reconnect policy re-dials the socket.
    await vi.advanceTimersByTimeAsync(1_100);
    const reconnects = wsConnectCalls();
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
  });

  it("stays connected while pongs keep arriving", async () => {
    await connectAndAuth(client);

    const states = trackStates(client);
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
    const reconnects = wsConnectCalls();
    expect(reconnects).toHaveLength(0);
  });

  it("any inbound frame refreshes the deadline", async () => {
    await connectAndAuth(client);

    await vi.advanceTimersByTimeAsync(50_000);
    // A broadcast (not a pong) still proves the socket is delivering bytes.
    emitTauriEvent("ws-message", JSON.stringify({ type: "typing", payload: { channel_id: 1 } }));

    const states = trackStates(client);

    // Past the original deadline, but the frame at t=50s moved it out.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(states).not.toContain("reconnecting");
  });

  it("does not count silence as dead until a heartbeat ping goes unanswered", async () => {
    // A minimised webview throttles the heartbeat setInterval; capture its
    // callback so the test decides when (and whether) a ping goes out.
    let heartbeat: (() => void) | null = null;
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms === 30_000) {
        heartbeat = fn;
        return 0 as unknown as ReturnType<typeof setInterval>;
      }
      return realSetInterval(fn, ms);
    }) as typeof setInterval);
    try {
      await connectAndAuth(client);
    } finally {
      spy.mockRestore();
    }
    expect(heartbeat).not.toBeNull();
    const fireHeartbeat = (): void => heartbeat?.();

    const states = trackStates(client);

    // Past the deadline with no ping ever sent: silence is not yet evidence.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(states).not.toContain("reconnecting");

    // The throttled heartbeat finally fires; its pong lands within the grace.
    fireHeartbeat();
    await vi.advanceTimersByTimeAsync(5_000);
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).not.toContain("reconnecting");

    // A ping that stays unanswered past the grace is a dead link.
    fireHeartbeat();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(states).not.toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(2_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    expect(states).toContain("reconnecting");
  });

  it("dial once when a close arrives while the silence deadline also fires", async () => {
    await connectAndAuth(client);

    // The deadline fires and schedules one retry (backoff >= 500ms), then the
    // socket's own close report lands before that retry dials. Both must share
    // one retry, not stack two.
    await vi.advanceTimersByTimeAsync(60_100);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    const reconnects = wsConnectCalls();
    expect(reconnects).toHaveLength(1);
  });

  it("does not arm a reconnect after an intentional disconnect", async () => {
    await connectAndAuth(client);
    client.disconnect();
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(120_000);
    const reconnects = wsConnectCalls();
    expect(reconnects).toHaveLength(0);
  });
});
