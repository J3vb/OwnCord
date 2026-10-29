/**
 * The portal's credential save (WP 6.13e1): startSession on the web keeps the
 * token for every login, session-only when "Stay signed in" is unticked, and
 * tells the user when a save fails. The credential store is the real browser
 * adapter over jsdom's Web Storage; the socket and dispatcher are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubGlobal("isSecureContext", true);
});

const hoisted = vi.hoisted(() => ({
  warn: vi.fn(),
  userUpdate: null as null | ((payload: { user_id: number; username: string }) => void),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: hoisted.warn, error: vi.fn() }),
}));
vi.mock("@pages/mainPagePrefetch", () => ({ prefetchMainPage: vi.fn() }));
vi.mock("@lib/last-channel", () => ({ setLastChannelHost: vi.fn() }));
vi.mock("@lib/dispatcher", () => ({ wireDispatcher: vi.fn(() => () => undefined) }));
vi.mock("@components/ConnectedOverlay", () => ({ createConnectedOverlay: vi.fn() }));

import { createApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import { authStore, clearAuth } from "@stores/auth.store";
import { setTransientError, uiStore } from "@stores/ui.store";
import {
  abandonInFlight,
  configureSession,
  installLogoutTeardown,
  startSession,
} from "../../src/app/session";
import { connectText } from "../../src/i18n/connect";
import { credentials } from "../../src/platform/browser/credentials";

const HOST = location.host;
const KEY = `owncord:credential:${HOST}`;

const api = createApiClient({ host: "" });
const unsub = (): (() => void) => () => undefined;
const ws = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  onCertFirstUse: vi.fn(unsub),
  onServerBusy: vi.fn(unsub),
  onStateChange: vi.fn(unsub),
  getConnectFailureCode: vi.fn(() => null),
  on: vi.fn((type: string, handler: unknown) => {
    if (type === "user_update") hoisted.userUpdate = handler as typeof hoisted.userUpdate;
    return () => undefined;
  }),
} as unknown as WsClient;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function stored(area: Storage): { username: string; token: string } | null {
  const raw = area.getItem(KEY);
  return raw === null ? null : (JSON.parse(raw) as { username: string; token: string });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  hoisted.userUpdate = null;
  hoisted.warn.mockClear();
  setTransientError(null);
  document.body.innerHTML = '<div id="app"></div>';
  configureSession(api, ws, document.getElementById("app")!, () => "connect", vi.fn());
});

afterEach(() => {
  abandonInFlight();
  api.endSession();
  clearAuth();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A user's own login: remember-password is hidden on the portal, so it is false. */
function login(autoConnect: boolean, token = "tok-1"): void {
  startSession(HOST, token, "casey", undefined, false, true, undefined, autoConnect);
}

describe("portal session credential save", () => {
  it("ticked login saves to localStorage", async () => {
    login(true);
    await flush();
    expect(stored(localStorage)).toEqual({ username: "casey", token: "tok-1" });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("unticked login saves session-only and removes kept copy", async () => {
    // An earlier, ticked sign-in left a kept copy behind.
    localStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "old" }));
    login(false, "tok-2");
    await flush();
    expect(stored(sessionStorage)).toEqual({ username: "casey", token: "tok-2" });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("resume keeps token area", async () => {
    // A resume replays a stored credential, so it is not the user's own choice.
    sessionStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "old" }));
    startSession(HOST, "fresh", "casey", undefined, false, false, undefined, true);
    await flush();
    expect(stored(sessionStorage)).toEqual({ username: "casey", token: "fresh" });
    expect(localStorage.getItem(KEY)).toBeNull();

    sessionStorage.clear();
    localStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "old" }));
    startSession(HOST, "fresh", "casey", undefined, false, false, undefined, false);
    await flush();
    expect(stored(localStorage)).toEqual({ username: "casey", token: "fresh" });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("a resume save leaves the other area's different token alone", async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "T1" }));
    localStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "T2" }));
    startSession(HOST, "T1b", "casey", undefined, false, false, undefined, true);
    await flush();
    expect(stored(sessionStorage)?.token).toBe("T1b");
    expect(stored(localStorage)?.token).toBe("T2");
  });

  it("a sign-out in one tab leaves a different token stored by another tab", async () => {
    installLogoutTeardown();
    login(false, "T1");
    await flush();
    // Another tab signs in and keeps its own token.
    localStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "T2" }));
    configureSession(api, ws, document.getElementById("app")!, () => "main", vi.fn());
    authStore.setState((prev) => ({ ...prev, isAuthenticated: true }));
    await flush();
    clearAuth();
    await flush();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(stored(localStorage)?.token).toBe("T2");
  });

  it("failed save surfaces error", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    login(false);
    await flush();
    expect(uiStore.getState().transientError).toBe(connectText("session.credentialsSaveFailed"));
    expect(hoisted.warn).toHaveBeenCalledTimes(1);
  });

  it("user-update re-save false surfaces error", async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "tok-1" }));
    login(false);
    await flush();
    setTransientError(null);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 7, username: "casey", avatar: null, role: "member" } as never,
      token: "tok-1",
    }));
    expect(hoisted.userUpdate).not.toBeNull();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    hoisted.userUpdate!({ user_id: 7, username: "casey2" });
    await flush();
    expect(uiStore.getState().transientError).toBe(connectText("session.credentialsSaveFailed"));
    expect(hoisted.warn).toHaveBeenCalledTimes(1);
  });
});

describe("browser credential save order", () => {
  /** Make one Storage method throw for one area only, as a full or private store does. */
  function breakArea(area: Storage, method: "setItem" | "removeItem"): void {
    const original = Storage.prototype[method];
    vi.spyOn(Storage.prototype, method).mockImplementation(function (
      this: Storage,
      ...args: [string, string]
    ) {
      if (this === area) throw new DOMException("quota", "QuotaExceededError");
      return original.apply(this, args);
    });
  }

  it("a write that throws keeps the old sign-in in the other area", async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "old" }));
    breakArea(localStorage, "setItem");
    // Moving session-only to kept: the new copy cannot be written.
    expect(await credentials.save(HOST, "casey", "new", "", false, false)).toBe(false);
    expect(stored(sessionStorage)).toEqual({ username: "casey", token: "old" });
    expect(await credentials.load(HOST)).toEqual(expect.objectContaining({ token: "old" }));
  });

  it("a removal that throws after a good write still reports the token saved", async () => {
    localStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "old" }));
    breakArea(localStorage, "removeItem");
    // Moving kept to session-only: the new copy lands, the old one cannot go.
    expect(await credentials.save(HOST, "casey", "new", "", false, true)).toBe(true);
    expect(stored(sessionStorage)).toEqual({ username: "casey", token: "new" });
    // Session is read first, so the new token is the one that loads.
    expect(await credentials.load(HOST)).toEqual(expect.objectContaining({ token: "new" }));
  });
});
