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
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
// in this flow touches the REST client.
const mockLogin = vi.fn();
vi.mock("@lib/api", () => ({
  createApiClient: vi.fn(() => ({
    setConfig: vi.fn(),
    getConfig: vi.fn(() => ({ host: "" })),
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
import { loadUserStatus, loadUserStatusOrigin } from "@lib/userStatus";

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
