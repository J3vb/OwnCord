/**
 * Tests for src/app/session.ts, the SessionController (WP 7.4d). The module is
 * driven directly: configureSession() gets the real ws client over the shared
 * Tauri mocks, the real api client and a fake router. The dispatcher and the
 * connected overlay are small stand-ins that record what the controller does
 * to them, so ownership across a second startSession() is observable.
 *
 * The per-path teardown order (endSession before ws.disconnect) is pinned
 * through main.ts in main-teardown-order.test.ts; the cases here cover the
 * controller's own surface and the superseded-attempt edge.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  events: [] as string[],
  overlays: [] as Array<{
    onReady: () => void;
    destroyed: boolean;
    ready: boolean;
    element: HTMLElement;
  }>,
  saveCredential: vi.fn(async (..._args: unknown[]) => true),
  deleteCredential: vi.fn(async (_host: string) => true),
  leaveVoice: vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve()),
  warn: vi.fn(),
}));
const { events, overlays } = hoisted;

vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));
vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));
vi.mock("@pages/mainPagePrefetch", () => ({ prefetchMainPage: vi.fn() }));
vi.mock("@lib/net/credentials", () => ({
  saveCredential: hoisted.saveCredential,
  deleteCredential: hoisted.deleteCredential,
  createUserUpdateCredentialSaver: vi.fn(() => vi.fn()),
}));
vi.mock("@lib/voice/livekitSession", () => ({ leaveVoice: hoisted.leaveVoice }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: hoisted.warn,
    error: vi.fn(),
  }),
}));
vi.mock("@lib/prefs/lastChannel", () => ({ setLastChannelHost: vi.fn() }));
vi.mock("@components/ConnectedOverlay", () => ({
  createConnectedOverlay: vi.fn((opts: { onReady: () => void }) => {
    const entry = {
      onReady: opts.onReady,
      destroyed: false,
      ready: false,
      element: document.createElement("div"),
    };
    overlays.push(entry);
    return {
      element: entry.element,
      show: vi.fn(),
      markReady: () => {
        entry.ready = true;
      },
      destroy: () => {
        entry.destroyed = true;
        entry.element.remove();
      },
    };
  }),
}));

let dispatcherSeq = 0;
vi.mock("@lib/dispatcher", () => ({
  wireDispatcher: vi.fn(() => {
    const id = ++dispatcherSeq;
    return () => events.push(`dispatcher-${id}-unsub`);
  }),
}));

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { createApiClient } from "@lib/api";
import { createWsClient, PREAUTH_CONNECT_TIMEOUT_MS } from "@lib/ws";
import { authStore, clearAuth, setAuth } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { joinVoiceChannel } from "@stores/voice.store";
import {
  abandonInFlight,
  configureSession,
  installLogoutTeardown,
  sessionInFlight,
  sessionTarget,
  startSession,
} from "../../src/app/session";
import type { PageId } from "../../src/app/context";

const USER = { id: 7, username: "casey", avatar: null, role: "member" };
const api = createApiClient({ host: "" });
const ws = createWsClient();
let page: PageId = "connect";
const navigate = vi.fn((next: PageId) => {
  page = next;
});

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockReset().mockResolvedValue(undefined);
  hoisted.saveCredential.mockClear().mockResolvedValue(true);
  hoisted.deleteCredential.mockClear();
  hoisted.leaveVoice.mockClear().mockResolvedValue(undefined);
  hoisted.warn.mockClear();
  events.length = 0;
  overlays.length = 0;
  dispatcherSeq = 0;
  page = "connect";
  navigate.mockClear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  configureSession(api, ws, document.getElementById("app")!, () => page, navigate);
});

afterEach(async () => {
  abandonInFlight();
  api.endSession();
  clearAuth();
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
});

/** Lets ws.connect() register its Tauri listeners, then delivers the open and auth_ok frames. */
async function authOk(serverName = "Srv"): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  emitTauriEvent("ws-state", "open");
  emitTauriEvent(
    "ws-message",
    JSON.stringify({
      type: "auth_ok",
      payload: { user: USER, server_name: serverName, motd: "" },
    }),
  );
}

describe("start and abandon", () => {
  it("reports no session until startSession runs", () => {
    expect(sessionTarget()).toBeNull();
    expect(sessionInFlight()).toBe(false);
  });

  it("records the connect target and wires the dispatcher on startSession", () => {
    startSession("a.example:8443", "tok-a", "casey");
    expect(sessionTarget()).toEqual({ host: "a.example:8443", token: "tok-a" });
    expect(sessionInFlight()).toBe(true);
    expect(authStore.getState().token).toBe("tok-a");
    expect(dispatcherSeq).toBe(1);
  });

  it("abandonInFlight tears the wiring and overlay down and forgets the target", async () => {
    startSession("a.example:8443", "tok-a", "casey");
    await authOk();
    expect(overlays).toHaveLength(1);
    const disconnect = vi.spyOn(ws, "disconnect");
    abandonInFlight();
    expect(events).toContain("dispatcher-1-unsub");
    expect(overlays[0]!.destroyed).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(sessionTarget()).toBeNull();
    expect(sessionInFlight()).toBe(false);
    disconnect.mockRestore();
  });

  it("abandonInFlight with nothing in flight only disconnects", () => {
    const disconnect = vi.spyOn(ws, "disconnect");
    abandonInFlight();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    disconnect.mockRestore();
  });
});

describe("a second startSession while an attempt is in flight", () => {
  it("tears down the prior dispatcher wiring and overlay", async () => {
    startSession("a.example:8443", "tok-a", "casey");
    await authOk("A");
    expect(overlays).toHaveLength(1);

    startSession("b.example:8443", "tok-b", "casey");
    expect(events).toContain("dispatcher-1-unsub");
    expect(overlays[0]!.destroyed).toBe(true);
    expect(sessionTarget()).toEqual({ host: "b.example:8443", token: "tok-b" });

    await authOk("B");
    expect(overlays).toHaveLength(2);
    expect(overlays.filter((o) => !o.destroyed)).toHaveLength(1);
  });

  it("does not let the superseded overlay's onReady navigate", async () => {
    startSession("a.example:8443", "tok-a", "casey");
    await authOk("A");
    const stale = overlays[0]!;

    startSession("b.example:8443", "tok-b", "casey");
    stale.onReady();
    expect(navigate).not.toHaveBeenCalled();

    await authOk("B");
    overlays[1]!.onReady();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("main");
  });
});

describe("a same-host, same-token re-entry", () => {
  it("drops the first attempt's listeners and keeps a single overlay", async () => {
    startSession("a.example:8443", "tok-a", "casey");
    startSession("a.example:8443", "tok-a", "casey");
    expect(events).toContain("dispatcher-1-unsub");
    await authOk();
    // Only the second attempt's auth_ok listener is left, so one overlay is built.
    expect(overlays).toHaveLength(1);
    expect(overlays.filter((o) => !o.destroyed)).toHaveLength(1);
  });
});

describe("pre-auth deadline", () => {
  it("ends the API session before closing the socket, then runs the explicit cleanups", async () => {
    startSession("a.example:8443", "tok-a", "casey");
    const endSession = vi.spyOn(api, "endSession").mockImplementation(() => {
      events.push("end-session");
    });
    const disconnect = vi.spyOn(ws, "disconnect").mockImplementation(() => {
      events.push("ws-disconnect");
    });
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 1);
    endSession.mockRestore();
    disconnect.mockRestore();
    // endSession is mocked out, so the scope does not run the cleanups: the
    // explicit dispatcher unsubscribe after the disconnect is the only one.
    expect(events).toEqual(["end-session", "ws-disconnect", "dispatcher-1-unsub"]);
    expect(sessionTarget()).toBeNull();
  });

  it("gives up on a never-authenticated attempt and runs the timeout callback", async () => {
    const onTimeout = vi.fn();
    startSession("a.example:8443", "tok-a", "casey", undefined, true, false, onTimeout);
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(sessionTarget()).toBeNull();
    expect(events).toContain("dispatcher-1-unsub");
    expect(uiStore.getState().transientError).not.toBeNull();
  });

  it("is cleared once the session authenticates", async () => {
    const onTimeout = vi.fn();
    startSession("a.example:8443", "tok-a", "casey", undefined, true, false, onTimeout);
    await authOk();
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 1);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(sessionInFlight()).toBe(true);
  });
});

describe("credentials", () => {
  it("saves the token and password when remember is on", () => {
    startSession("a.example:8443", "tok-a", "casey", "pw", true, true);
    expect(hoisted.saveCredential).toHaveBeenCalledWith(
      "a.example:8443",
      "casey",
      "tok-a",
      "pw",
      false,
    );
  });

  it("warns the user when the credential save fails", async () => {
    hoisted.saveCredential.mockResolvedValue(false);
    startSession("a.example:8443", "tok-a", "casey", "pw", true, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(uiStore.getState().transientError).not.toBeNull();
  });

  it("deletes the stored credential when the user declines being remembered", async () => {
    startSession("a.example:8443", "tok-a", "casey", undefined, false, true, undefined, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.deleteCredential).toHaveBeenCalledWith("a.example:8443");
    expect(hoisted.saveCredential).not.toHaveBeenCalled();
  });

  it("keeps the credential when the decline is not the user's own choice", async () => {
    startSession("a.example:8443", "tok-a", "casey", undefined, false, false, undefined, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.deleteCredential).not.toHaveBeenCalled();
  });
});

describe("logout teardown", () => {
  beforeAll(() => {
    // App-lifetime and never unsubscribed: tests above this describe run without it.
    installLogoutTeardown();
  });

  async function signIn(): Promise<void> {
    startSession("a.example:8443", "tok-a", "casey");
    await authOk();
    setAuth("tok-a", USER, "Srv", "");
    page = "main";
    await vi.advanceTimersByTimeAsync(0);
  }

  it("tears the session down, drops the credential and returns to connect", async () => {
    await signIn();
    const disconnect = vi.spyOn(ws, "disconnect");
    api.endSession();
    clearAuth();
    await vi.advanceTimersByTimeAsync(0);

    expect(disconnect).toHaveBeenCalled();
    expect(events).toContain("dispatcher-1-unsub");
    expect(overlays[0]!.destroyed).toBe(true);
    expect(sessionTarget()).toBeNull();
    expect(navigate).toHaveBeenCalledWith("connect");
    expect(sessionStorage.getItem("owncord:skip-auto-login")).toBe("1");
    expect(hoisted.deleteCredential).toHaveBeenCalledWith("a.example:8443");
    disconnect.mockRestore();
  });

  it("keeps the credential on a server switch", async () => {
    await signIn();
    api.endSession();
    clearAuth("server_switch");
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.deleteCredential).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("connect");
  });

  it("leaves the voice channel before the socket closes", async () => {
    await signIn();
    joinVoiceChannel(3);
    const send = vi.spyOn(ws, "send");
    api.endSession();
    clearAuth();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    expect(hoisted.leaveVoice).toHaveBeenCalledWith(false);
    send.mockRestore();
  });

  it("warns instead of throwing when the voice leave fails", async () => {
    hoisted.leaveVoice.mockRejectedValue(new Error("gone"));
    await signIn();
    joinVoiceChannel(3);
    api.endSession();
    clearAuth();
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.warn).toHaveBeenCalledWith("Failed to leave voice session", expect.any(Error));
  });

  it("finishes the teardown for a session that dropped between auth_ok and ready", async () => {
    startSession("a.example:8443", "tok-a", "casey");
    await authOk();
    setAuth("tok-a", USER, "Srv", "");
    await vi.advanceTimersByTimeAsync(0);
    expect(page).toBe("connect");
    api.endSession();
    clearAuth();
    await vi.advanceTimersByTimeAsync(0);
    expect(overlays[0]!.destroyed).toBe(true);
    expect(sessionInFlight()).toBe(false);
    expect(navigate).toHaveBeenCalledWith("connect");
  });
});
