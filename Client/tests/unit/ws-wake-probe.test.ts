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
import { handleConnectionError } from "../../src/features/connection/wsHandlers";
import { setSessionReplaced, uiStore } from "../../src/stores/ui.store";

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

  it("probes on the first heartbeat after a brief freeze", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    mockInvoke.mockClear();

    // A freeze past the wake gap moves the wall clock without running any
    // timer. Marking the next dial a wake (U4) is covered in
    // ws-suspend-gate.test.ts.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pingSends()).toHaveLength(1);

    // The 15 s pong grace, not the 60 s silence deadline, decides the redial.
    await vi.advanceTimersByTimeAsync(15_000);
    expectConsole("warn", /\[ws\] No inbound frame within the liveness deadline/);
    expect(states).toContain("reconnecting");
  });

  it("treats a throttled ~60 s heartbeat gap as no wake", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    // A long-hidden page's intensive throttling fires the tick ~60 s late.
    vi.setSystemTime(Date.now() + 31_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(states).not.toContain("reconnecting");
  });

  it("never pushes back a sooner deadline or an older unanswered ping", async () => {
    await connectAndAuth();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    // The heartbeat ping at 30 s goes unanswered; the silence deadline is 60 s.
    await vi.advanceTimersByTimeAsync(55_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);

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

// DP-02: the network or the screen coming back while the client is waiting out
// a reconnect backoff dials at once rather than after up to 30 s.
describe("wake kick while reconnecting (DP-02)", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    // The top of each backoff window, so the fourth failed dial waits 16 s.
    client = createWsClient({ random: () => 1 });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  function dials(): number {
    return mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect").length;
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

  async function connectAndAuth(): Promise<void> {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", AUTH_OK);
  }

  // Loses the live socket, then fails three redials, leaving the fourth
  // attempt pending 16 s out.
  async function reconnectingAtSixteenSeconds(): Promise<void> {
    await connectAndAuth();
    emitTauriEvent("ws-state", "closed");
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      emitTauriEvent("ws-state", "closed");
    }
    expect(client.getState()).toBe("reconnecting");
    mockInvoke.mockClear();
  }

  it("dials at once when the network returns, replacing the pending backoff", async () => {
    await reconnectingAtSixteenSeconds();

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(dials()).toBe(1);

    // The backoff timer the kick replaced never fires a second dial.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(dials()).toBe(1);
  });

  it("dials at once when the document becomes visible again", async () => {
    await reconnectingAtSixteenSeconds();

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(dials()).toBe(1);
  });

  it("marks the kicked dial a wake after a suspend (U4)", async () => {
    await reconnectingAtSixteenSeconds();

    // The laptop slept through the backoff: the wall clock moved, no timer ran.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(dials()).toBe(1);
    emitTauriEvent("ws-state", "open");

    expect(lastAuthPayload().wake).toBe(true);
  });

  it("does not mark the kicked dial a wake without a suspend", async () => {
    await reconnectingAtSixteenSeconds();

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(dials()).toBe(1);
    emitTauriEvent("ws-state", "open");

    expect(lastAuthPayload().wake).toBeUndefined();
  });

  it("kicks at most once per 2 s", async () => {
    await reconnectingAtSixteenSeconds();

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(dials()).toBe(1);

    // The kicked dial fails straight away and another event lands at once.
    emitTauriEvent("ws-state", "closed");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(dials()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(dials()).toBe(2);
  });

  it("does not dial after disconnect()", async () => {
    await reconnectingAtSixteenSeconds();
    client.disconnect();
    mockInvoke.mockClear();

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(dials()).toBe(0);
  });

  it("does not dial after auth_error", async () => {
    await reconnectingAtSixteenSeconds();
    await vi.advanceTimersByTimeAsync(16_000);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({ type: "auth_error", payload: { message: "revoked" } }),
    );
    expectConsole("error", /\[ws\] Authentication failed/);
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(dials()).toBe(0);
  });

  it("does not redial through a certificate-mismatch latch (TOFU)", async () => {
    await reconnectingAtSixteenSeconds();
    // The pending redial reaches a server whose certificate changed.
    await vi.advanceTimersByTimeAsync(16_000);
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
      message: "Stored: sha256:OLD",
    });
    expectConsole("error", /\[ws\] Certificate fingerprint mismatch/);
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(dials()).toBe(0);
  });

  it("does not dial while the account is signed in elsewhere", async () => {
    client.on("error", (payload) => handleConnectionError(client, payload));
    await reconnectingAtSixteenSeconds();
    // The kicked wake dial is refused: another device holds the session.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "error",
        payload: { code: "ANOTHER_DEVICE_ACTIVE", message: "in use elsewhere" },
      }),
    );
    expect(uiStore.getState().sessionReplaced).toBe(true);
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(dials()).toBe(0);
    setSessionReplaced(false);
  });
});
