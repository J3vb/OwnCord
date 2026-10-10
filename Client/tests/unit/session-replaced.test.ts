import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// B7-14: a second device signing in displaces this one. Before the server
// named the reason, the close looked like a network drop, the client
// reconnected on its first backoff step (auth_ok resets the backoff) and
// kicked the other device — two devices traded the socket forever. The real
// ws client and the real dispatcher are wired together here, so the test
// covers the whole path from the frame to "no reconnect".
//
// The reconnect delay uses equal jitter: attempt n waits somewhere in
// [ceiling / 2, ceiling) with ceiling = 1000 * 2^n ms, so the first retry
// lands in [500, 1000) and the second in [1000, 2000). The clients here
// inject `random` instead of drawing from Math.random, which keeps the
// timing exact: `() => 1` is the upper edge (1000 ms, then 2000 ms) and
// `() => 0` the lower edge (500 ms, then 1000 ms).

vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));
vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));
vi.mock("@lib/livekitSession", () => ({ leaveVoice: vi.fn() }));
vi.mock("@lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/identity", () => ({ ensureIdentityKeyPublished: vi.fn(async () => true) }));

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";
import { wireDispatcher, wireConnectionStatus } from "../../src/lib/dispatcher";
import { authStore } from "../../src/stores/auth.store";
import { uiStore, setConnectionStatus, setSessionReplaced } from "../../src/stores/ui.store";
import { expectConsole } from "../helpers/console";

function authOk(): string {
  return JSON.stringify({
    type: "auth_ok",
    payload: {
      user: { id: 1, username: "a", avatar: null, role: "member" },
      server_name: "S",
      motd: "",
      replay_source: "none",
    },
  });
}

function wsConnects(): number {
  return mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect").length;
}

describe("SESSION_REPLACED stops the two-device reconnect fight", () => {
  let client: ReturnType<typeof createWsClient>;
  let cleanups: Array<() => void>;

  // `random` is fixed when the client is created, so a test that needs a
  // different jitter point stops the running client and calls this again.
  async function startClient(random: () => number): Promise<void> {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    setSessionReplaced(false);
    setConnectionStatus("disconnected");
    client = createWsClient({ random });
    cleanups = [wireDispatcher(client), wireConnectionStatus(client)];
    authStore.setState((prev) => ({ ...prev, token: "t", isAuthenticated: true }));
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", authOk());
    expect(client.getState()).toBe("connected");
  }

  function stopClient(): void {
    for (const c of cleanups) c();
    client.disconnect();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    // Pin the upper jitter endpoint: the delays are exactly 1000 ms, then 2000 ms.
    await startClient(() => 1);
  });

  afterEach(() => {
    stopClient();
    vi.useRealTimers();
  });

  it("does not reconnect after a SESSION_REPLACED frame, and keeps the device signed in", async () => {
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "error",
        payload: { code: "SESSION_REPLACED", message: "signed in on another device" },
      }),
    );
    expectConsole("error", /\[dispatcher\] Server error/);
    emitTauriEvent("ws-state", "closed");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wsConnects()).toBe(0);
    expect(client.getState()).toBe("disconnected");
    expect(uiStore.getState().sessionReplaced).toBe(true);
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(authStore.getState().token).toBe("t");
  });

  it("treats ANOTHER_DEVICE_ACTIVE like SESSION_REPLACED: same prompt, no reconnect", async () => {
    // The server refused this device's wake reconnect because another device
    // holds the session (U4). Same user choice as a displacement, same path.
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "error",
        payload: { code: "ANOTHER_DEVICE_ACTIVE", message: "another device is active" },
      }),
    );
    expectConsole("error", /\[dispatcher\] Server error/);

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wsConnects()).toBe(0);
    expect(uiStore.getState().sessionReplaced).toBe(true);
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(authStore.getState().token).toBe("t");
  });

  it("control: a plain close with no such frame still reconnects, and backs off", async () => {
    emitTauriEvent("ws-state", "closed");
    expect(client.getState()).toBe("reconnecting");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(wsConnects()).toBe(1);

    // The retry fails before auth_ok, so the next delay doubles.
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    // The second delay is in [1000, 2000) ms. Nothing may fire just under its
    // lower edge, and with the upper endpoint pinned the retry lands at 2000.
    await vi.advanceTimersByTimeAsync(999);
    expect(wsConnects()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsConnects()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wsConnects()).toBe(1);
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });

  it("control: at the lower jitter edge the second retry fires at exactly 1000 ms", async () => {
    // The flake this pins: with the second delay at the bottom of its window,
    // the retry fires inside a 1000 ms advance, not after it.
    stopClient();
    await startClient(() => 0);

    emitTauriEvent("ws-state", "closed");
    expect(client.getState()).toBe("reconnecting");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(499);
    expect(wsConnects()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsConnects()).toBe(1);

    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(999);
    expect(wsConnects()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsConnects()).toBe(1);
  });

  it("a later connection clears the signed-in-elsewhere state", () => {
    setSessionReplaced(true);
    setConnectionStatus("connected");
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });
});
