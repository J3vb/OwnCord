import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// B7-14: a second device signing in displaces this one. Before the server
// named the reason, the close looked like a network drop, the client
// reconnected at its 1 s floor (auth_ok resets the backoff) and kicked the
// other device — two devices traded the socket forever. The real ws client
// and the real dispatcher are wired together here, so the test covers the
// whole path from the frame to "no reconnect".

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

  beforeEach(async () => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    setSessionReplaced(false);
    setConnectionStatus("disconnected");
    client = createWsClient();
    cleanups = [wireDispatcher(client), wireConnectionStatus(client)];
    authStore.setState((prev) => ({ ...prev, token: "t", isAuthenticated: true }));
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", authOk());
    expect(client.getState()).toBe("connected");
  });

  afterEach(() => {
    for (const c of cleanups) c();
    client.disconnect();
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
    await vi.advanceTimersByTimeAsync(1000);
    expect(wsConnects()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wsConnects()).toBe(1);
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });

  it("a later connection clears the signed-in-elsewhere state", () => {
    setSessionReplaced(true);
    setConnectionStatus("connected");
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });
});
