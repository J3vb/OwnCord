/**
 * Tests for src/main.ts's post-auth wiring.
 *
 * main.ts is excluded from unit coverage (vitest.config.ts) — "no seam to
 * test below the e2e level; covered by tests/e2e." This file creates one:
 * every direct dependency of main.ts that is not needed to observe the two
 * behaviors below is stubbed out (mirroring the pattern main-page.test.ts
 * uses for MainPage.ts), while ws.ts, authStore, router.ts, safe-render.ts,
 * navigation-guard.ts and ConnectedOverlay.ts run for real — so the actual
 * event-ordering bug (OC-0063) is exercised, not simulated, and the tray
 * listener (OC-0037) is driven through the same Tauri event mock ws.ts's own
 * tests use.
 *
 * Covers:
 *  - OC-0037: the tray's "status-change" event must persist the choice
 *    through saveUserStatus() (the documented single source of truth for the
 *    selected status), not just fire a raw ws.send.
 *  - OC-0063: the connected overlay must read serverName/motd from the
 *    auth_ok payload, not from authStore snapshotted before dispatch() has
 *    run the dispatcher's own auth_ok handler (which is what actually writes
 *    authStore).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Tauri API mocks — reuse the ws-mocks.ts event-registry helper so ws.ts's
// real state machine can be driven with simulated Tauri events (same
// mechanism ws-lifecycle.test.ts uses), and so the tray's "status-change"
// listen() call registered by main.ts is capturable via the same
// emitTauriEvent().
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));
vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

// CSS imports are handled natively by vite/vitest — no mock needed.

vi.mock("@lib/appearance", () => ({ applyStoredAppearance: vi.fn() }));
vi.mock("@lib/themes", () => ({ restoreTheme: vi.fn() }));
vi.mock("@lib/ptt", () => ({ initPtt: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@lib/logPersistence", () => ({
  initLogPersistence: vi.fn().mockResolvedValue(undefined),
  flushLogs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@lib/credentials", () => ({
  saveCredential: vi.fn().mockResolvedValue(true),
  loadCredential: vi.fn().mockResolvedValue(null),
  deleteCredential: vi.fn().mockResolvedValue(undefined),
  createUserUpdateCredentialSaver: vi.fn(() => vi.fn()),
}));
vi.mock("@lib/window-state", () => ({ initWindowState: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@lib/deep-link", () => ({ initDeepLinks: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@lib/message-navigation", () => ({ jumpToMessage: vi.fn() }));
vi.mock("@components/CertMismatchModal", () => ({
  createCertMismatchModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
  createCertFirstUseModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));
vi.mock("@lib/cert-reconnect", () => ({ reconnectAfterCertAccept: vi.fn() }));
vi.mock("@lib/profiles", () => ({
  createTauriBackend: vi.fn(() => ({})),
  createProfileManager: vi.fn(() => ({
    loadProfiles: vi.fn().mockResolvedValue(undefined),
    saveProfiles: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn(() => []),
    addProfile: vi.fn((data: unknown) => ({ id: "profile-1", ...(data as object) })),
    updateProfile: vi.fn(() => null),
    removeProfile: vi.fn(() => true),
    getAutoConnectProfile: vi.fn(() => null),
    setAutoLogin: vi.fn(),
    setLastConnected: vi.fn(),
  })),
}));

// api.ts — only login() is exercised (it drives wirePostAuth); nothing else
// in this flow touches the REST client. getConfig()/setConfig() track a real
// host so OC-0028's test can reproduce the isAuthenticated subscriber's
// `api.getConfig().host` read (main.ts:776) after a login sets it via
// `api.setConfig({ host })` (main.ts:515).
const mockLogin = vi.fn();
// UpdateNotifier (mounted on the connect page after a protocol-epoch refusal)
// calls checkForUpdate; stub the Tauri-backed updater so the test observes the
// call instead of an invoke() into nothing.
const mockCheckForUpdate = vi.fn();
vi.mock("@lib/updater", () => ({
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  downloadAndInstallUpdate: vi.fn(),
}));
const mockApiState = { host: "" };
vi.mock("@lib/api", () => ({
  createApiClient: vi.fn(() => ({
    setConfig: vi.fn((cfg: { host?: string; token?: string }) => {
      if (cfg.host !== undefined) mockApiState.host = cfg.host;
    }),
    getConfig: vi.fn(() => ({ host: mockApiState.host })),
    login: (...args: unknown[]) => mockLogin(...args),
    getHealth: vi.fn().mockResolvedValue({ version: null, online_users: null }),
  })),
}));

// ConnectPage — captures the real onLogin callback main.ts wires up so the
// test can drive wirePostAuth exactly the way a real login does, without
// building the actual login form DOM.
const capturedConnectCallbacks: {
  onLogin?: (host: string, username: string, password: string) => Promise<void>;
} = {};
vi.mock("@pages/ConnectPage", () => ({
  createConnectPage: vi.fn((callbacks: typeof capturedConnectCallbacks) => {
    Object.assign(capturedConnectCallbacks, callbacks);
    return {
      mount: vi.fn(),
      destroy: vi.fn(),
      showTotp: vi.fn(),
      showConnecting: vi.fn(),
      showAutoConnecting: vi.fn(),
      showError: vi.fn(),
      resetToIdle: vi.fn(),
      updateHealthStatus: vi.fn(),
      getRememberPassword: vi.fn(() => false),
      getAutoConnect: vi.fn(() => false),
      getPassword: vi.fn(() => ""),
      refreshProfiles: vi.fn(),
      selectServer: vi.fn(),
      applyInviteLink: vi.fn(),
    };
  }),
}));

// MainPage.ts pulls in the whole chat/voice UI stack. OC-0028 needs a real
// "main" -> "connect" round trip through the router (main.ts only navigates
// away from "connect" via the connected overlay's onReady -> router.navigate
// ("main") callback), but doesn't care what MainPage renders, so stand in
// with the same lightweight shape main-page.test.ts's own mocks return.
vi.mock("@pages/MainPage", () => ({
  createMainPage: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));

// dispatcher.ts pulls in nearly every store/service in the app. Stand in
// with a slim replacement that reproduces the one behavior these tests must
// stay faithful to: the real dispatcher's auth_ok handler calls setAuth() on
// the REAL authStore (imported below, not mocked) — so main.ts's own race
// against that write is exercised unmodified, not sidestepped.
vi.mock("@lib/dispatcher", async () => {
  const { authStore, setAuth } = await import("@stores/auth.store");
  return {
    wireDispatcher: (ws: { on: (type: string, cb: (payload: unknown) => void) => () => void }) => {
      const unsub = ws.on("auth_ok", (payload) => {
        const p = payload as { user: unknown; server_name: string; motd: string };
        setAuth(authStore.getState().token ?? "", p.user as never, p.server_name, p.motd);
      });
      return () => unsub();
    },
    wireConnectionStatus: vi.fn(() => () => {}),
  };
});

import { mockInvoke, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { clearAuth } from "@stores/auth.store";
import { uiStore, setUpdateRequiredHost } from "@stores/ui.store";
import { loadUserStatus, loadUserStatusOrigin } from "@lib/userStatus";
import { createMainPage } from "@pages/MainPage";
import { setActivePresenceSender, type PresenceSender } from "@lib/presence";

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are registered. #app must
// exist first: main.ts reads document.getElementById("app") synchronously
// at module top level, and a static `import` line would be hoisted above any
// DOM setup written before it in source order — so this runs inside an async
// beforeAll instead of a top-level import.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../../src/main");
  // Flush the microtask the mocked (async) listen() call resolves on, so the
  // "status-change" handler main.ts registers at module load is actually in
  // eventHandlers before any test fires it.
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  clearAuth();
});

/** Drive a full login → WS connect → auth_ok cycle through the captured
 *  ConnectPage callback and the real ws.ts client living inside main.ts. */
async function loginAndReachAuthOk(
  host: string,
  username: string,
  authOkPayload: { user: unknown; server_name: string; motd: string },
): Promise<void> {
  mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
  await capturedConnectCallbacks.onLogin!(host, username, "hunter2");
  await vi.advanceTimersByTimeAsync(10);
  emitTauriEvent("ws-state", "open");
  emitTauriEvent("ws-message", JSON.stringify({ type: "auth_ok", payload: authOkPayload }));
}

describe("main.ts tray status-change listener (OC-0037)", () => {
  it("persists a tray-selected status through saveUserStatus, not just the wire", async () => {
    expect(eventHandlers.has("status-change")).toBe(true);

    emitTauriEvent("status-change", "dnd");

    // This is the crux of OC-0037: the tray path must agree with the
    // client's own documented "single source of truth" for the selected
    // status (lib/userStatus.ts), the same way UserBar's StatusPicker does.
    // Before the fix nothing here ever calls saveUserStatus, so this stays
    // "online" forever regardless of what the tray sent over the wire.
    expect(loadUserStatus()).toBe("dnd");
    expect(loadUserStatusOrigin()).toBe("manual");
  });

  it("maps the tray's legacy offline value to invisible, matching userStatus.ts's migration", async () => {
    emitTauriEvent("status-change", "offline");

    expect(loadUserStatus()).toBe("invisible");
  });
});

describe("main.ts tray status-change routes through the shared PresenceSender (OC-0176)", () => {
  afterEach(() => {
    setActivePresenceSender(null);
  });

  it("sends the tray's chosen status through the session's registered PresenceSender, not a raw ws.send", () => {
    // Stand in for the one PresenceSender MainPage.ts registers for the
    // session (via setActivePresenceSender) — the shared limiter token, the
    // coalescing retry, and the optimistic update all live inside it.
    const fakeSender: PresenceSender = { send: vi.fn(), destroy: vi.fn() };
    setActivePresenceSender(fakeSender);

    emitTauriEvent("status-change", "dnd");

    // Before the fix, main.ts calls ws.send({ type: "presence_update", ... })
    // directly — bypassing this sender (and the shared rate-limit budget it
    // enforces) entirely, so fakeSender.send is never called.
    expect(fakeSender.send).toHaveBeenCalledExactlyOnceWith("dnd");
  });

  it("is a safe no-op (no throw) when no session's PresenceSender is registered", () => {
    setActivePresenceSender(null);

    expect(() => emitTauriEvent("status-change", "idle")).not.toThrow();
  });
});

describe("main.ts connected overlay (OC-0063)", () => {
  it("shows the auth_ok payload's server_name and motd, not the pre-handshake authStore snapshot", async () => {
    await loginAndReachAuthOk("192.168.1.10:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "My Guild",
      motd: "Welcome to My Guild!",
    });

    const overlay = document.querySelector('[data-testid="connected-overlay"]');
    expect(overlay).not.toBeNull();

    // ws.ts fires onStateChange("connected") synchronously BEFORE dispatching
    // the auth_ok message that carries server_name/motd (ws.ts: setState()
    // then dispatch() in the same handleMessage() call) — so a handler that
    // reads authStore.getState() at that point sees the pre-auth_ok snapshot.
    // Reading directly from the payload sidesteps the race.
    const motdEl = overlay?.querySelector(".connected-motd");
    expect(motdEl?.textContent).toBe("Welcome to My Guild!");

    const iconEl = overlay?.querySelector(".connected-srv-icon");
    expect(iconEl?.textContent).toBe("M"); // first letter of "My Guild", not "1" (host) or "" (blank auth)
  });
});

describe("main.ts connected overlay teardown on mid-handshake session end (OC-0157)", () => {
  it('destroys the connected overlay when auth clears before the router leaves "connect"', async () => {
    await loginAndReachAuthOk("mid-handshake.example:8443", "casey", {
      user: { id: 7, username: "casey", avatar: null, role: "member" },
      server_name: "Mid Handshake Co",
      motd: "",
    });

    // auth_ok landed: the overlay is mounted over #app while the router is
    // still "connect" — it only moves to "main" from the overlay's own
    // onReady, 800ms after the `ready` event arrives.
    expect(document.querySelector('[data-testid="connected-overlay"]')).not.toBeNull();

    // Simulate a session that ends here — a ban, an auth_error on an
    // intervening reconnect, or a server shutdown — none of which the
    // client ever receives `ready` for. dispatcher.ts's handlers for all
    // three do `ws.disconnect(); clearAuth();` before `ready` can arrive.
    clearAuth();
    // authStore notifications are microtask-deferred (see store.ts).
    await Promise.resolve();
    await Promise.resolve();

    // Before the fix, the isAuthenticated subscriber's gate is
    // `router.getCurrentPage() === "main"` — since the router never left
    // "connect", the subscriber no-ops entirely and the overlay
    // (position:fixed, opaque, z-index 200) is orphaned over the connect
    // page forever; only an app restart clears it.
    expect(document.querySelector('[data-testid="connected-overlay"]')).toBeNull();
  });

  it("cancels the overlay's armed onReady timer when the session ends inside the 800ms ready window", async () => {
    const mainPageCallsBefore = vi.mocked(createMainPage).mock.calls.length;

    await loginAndReachAuthOk("wide-window.example:8443", "riley", {
      user: { id: 8, username: "riley", avatar: null, role: "member" },
      server_name: "Wide Window Co",
      motd: "",
    });

    // `ready` arrives and arms the overlay's 800ms onReady timer (which
    // would otherwise call router.navigate("main") on its own).
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));

    // The ban/shutdown lands partway through that 800ms window — well after
    // `ready`, well before the timer fires.
    await vi.advanceTimersByTimeAsync(300);
    clearAuth();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('[data-testid="connected-overlay"]')).toBeNull();

    // Advance past the timer's original 800ms deadline. Before the fix, the
    // subscriber never called connectedOverlay.destroy() (its AbortController
    // is what cancels the pending setTimeout — see ConnectedOverlay.ts), so
    // the already-armed timer still fires onReady() -> router.navigate("main"),
    // mounting MainPage on a cleared authStore and a disconnected socket even
    // though the isAuthenticated subscriber already ran and won't run again.
    await vi.advanceTimersByTimeAsync(600);

    expect(vi.mocked(createMainPage).mock.calls.length).toBe(mainPageCallsBefore);
  });
});

describe("main.ts connect-page skip-auto-login flag (OC-0028)", () => {
  afterEach(() => {
    sessionStorage.clear();
    mockApiState.host = "";
  });

  it("consumes owncord:skip-auto-login on a quick-switch mount, not just on a plain logout", async () => {
    // Reach "main" for host A via an ordinary login — the quick-switch
    // overlay (SidebarArea.ts) can only fire from a live session.
    await loginAndReachAuthOk("server-a.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Server A",
      motd: "",
    });
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    // ConnectedOverlay.markReady() fires onReady after READY_DELAY_MS (800ms),
    // which calls router.navigate("main") — main.ts's only route away from
    // "connect", needed so a later navigate("connect") is a real transition
    // and not a same-page no-op.
    await vi.advanceTimersByTimeAsync(800);

    // Quick-switch overlay's flow (SidebarArea.ts:756-760): stash the target
    // host, then log out via a bare clearAuth() (reason defaults to "user").
    // The isAuthenticated subscriber below (main.ts:750-788) turns that into
    // a stored "owncord:skip-auto-login" flag, since host is set and
    // logoutReason !== "server_shutdown".
    sessionStorage.setItem("owncord:quick-switch-target", "server-b.example:8443");
    clearAuth();

    // authStore notifications are microtask-deferred (see store.ts), and the
    // connect page's own load-profiles IIFE awaits a mocked (but still
    // native-Promise) loadProfiles() before reaching the quick-switch check —
    // flush both hops.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Quick-switch consumed its own key...
    expect(sessionStorage.getItem("owncord:quick-switch-target")).toBeNull();
    // ...and per OC-0028 must ALSO consume skip-auto-login on this same
    // mount. Before the fix, the quick-switch branch returns early (line 669)
    // without ever reaching the skip-auto-login read/remove at line 680-683,
    // so the flag set by the clearAuth() above survives indefinitely — and
    // would go on to suppress the auto-login that a later, unrelated
    // clearAuth("server_shutdown") deliberately relies on.
    expect(sessionStorage.getItem("owncord:skip-auto-login")).toBeNull();
  });
});

describe("main.ts connect page after a protocol-epoch refusal (B2-2)", () => {
  it("mounts the update notifier on the connect page so a refused client can update in place", async () => {
    await loginAndReachAuthOk("server-a.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Server A",
      motd: "",
    });
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);

    // The real dispatcher's auth_error handler records the host when the
    // server says this client's epoch is too old (dispatcher.test.ts covers
    // that); the dispatcher is stubbed here, so set what it would have set,
    // then end the session the way auth_error does.
    mockCheckForUpdate.mockResolvedValue({ available: false, version: null, body: null });
    setUpdateRequiredHost("server-a.example:8443");
    clearAuth();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The notifier checks 3 s after mount (UpdateNotifier.ts mount()).
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockCheckForUpdate).toHaveBeenCalledWith("https://server-a.example:8443");
    // Consumed on mount: the next connect page must not re-check.
    expect(uiStore.getState().updateRequiredHost).toBeNull();
  });
});
