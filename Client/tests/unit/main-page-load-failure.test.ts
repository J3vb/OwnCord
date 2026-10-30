/**
 * A rejected `import("@pages/MainPage")` must not leave a blank window
 * (roadmap 4.12): the router (src/app/router.ts) shows the render fallback with its Reload and Sign
 * out buttons instead. The mount-throws case is in main.test.ts, which stubs a
 * MainPage that loads. The mocks below mirror main.test.ts's.
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
const { mockOnOpenUrl } = vi.hoisted(() => ({
  mockOnOpenUrl: vi.fn().mockResolvedValue(undefined),
}));

// CSS imports are handled natively by vite/vitest — no mock needed.

vi.mock("@lib/prefs/appearance", () => ({ applyStoredAppearance: vi.fn() }));
vi.mock("@lib/net/connectionDiagnostics", () => ({ configureConnectionDiagnostics: vi.fn() }));
const { mockPrefetchMainPage } = vi.hoisted(() => ({ mockPrefetchMainPage: vi.fn() }));
vi.mock("@pages/mainPagePrefetch", () => ({ prefetchMainPage: mockPrefetchMainPage }));
vi.mock("@lib/pendingMessages", () => ({ deactivatePendingMessages: vi.fn() }));
vi.mock("../../src/platform/desktop/pushToTalk", () => ({
  pushToTalk: { init: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@lib/logPersistence", () => ({
  initLogPersistence: vi.fn().mockResolvedValue(undefined),
  flushLogs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@lib/net/credentials", () => ({
  saveCredential: vi.fn().mockResolvedValue(true),
  loadCredential: vi.fn().mockResolvedValue(null),
  deleteCredential: vi.fn().mockResolvedValue(undefined),
  createUserUpdateCredentialSaver: vi.fn(() => vi.fn()),
}));
vi.mock("@lib/prefs/windowState", () => ({
  initWindowState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  register: vi.fn().mockResolvedValue(undefined),
  getCurrent: vi.fn().mockResolvedValue(null),
  onOpenUrl: (...args: unknown[]) => mockOnOpenUrl(...args),
}));
vi.mock("@lib/nav/messageNavigation", () => ({ jumpToMessage: vi.fn() }));
vi.mock("@components/CertMismatchModal", () => ({
  createCertMismatchModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
  createCertFirstUseModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));
vi.mock("@lib/net/certReconnect", () => ({ reconnectAfterCertAccept: vi.fn() }));
const mockProfileManager = vi.hoisted(() => ({
  loadProfiles: vi.fn().mockResolvedValue(undefined),
  saveProfiles: vi.fn().mockResolvedValue(undefined),
  getAll: vi.fn((): { id: string; name: string; host: string }[] => []),
  addProfile: vi.fn((data: unknown) => ({ id: "profile-1", ...(data as object) })),
  updateProfile: vi.fn(() => null),
  removeProfile: vi.fn(() => true),
  getAutoConnectProfile: vi.fn(() => null),
  setAutoLogin: vi.fn(),
  setLastConnected: vi.fn(),
}));

vi.mock("@lib/presence/profiles", async (importOriginal) => ({
  deriveCompatibility: (await importOriginal<typeof import("@lib/presence/profiles")>())
    .deriveCompatibility,
  createTauriBackend: vi.fn(() => ({})),
  createProfileManager: vi.fn(() => mockProfileManager),
}));

// api.ts — only login() is exercised (it drives wirePostAuth); nothing else
// in this flow touches the REST client. getConfig()/setConfig() track a real
// host so OC-0028's test can reproduce the isAuthenticated subscriber's
// `api.getConfig().host` read (main.ts:776) after a login sets it via
// `api.setConfig({ host })` (main.ts:515).
const mockLogin = vi.fn();
const mockRecoverAccount = vi.fn();
const mockVerifyTotp = vi.fn();
const mockRegister = vi.fn();
// UpdateNotifier (mounted on the connect page after a protocol-epoch refusal)
// calls checkForUpdate; stub the Tauri-backed updater so the test observes the
// call instead of an invoke() into nothing.
const mockCheckForUpdate = vi.fn();
vi.mock("@lib/net/updater", () => ({
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  downloadAndInstallUpdate: vi.fn(),
  subscribeToUpdateInstall: vi.fn((listener: (state: { status: "idle" }) => void) => {
    listener({ status: "idle" });
    return vi.fn();
  }),
}));
const mockApiState = { host: "" };
// server-info payload returned by the mocked client, so a test can drive the
// registration-mode snapshot `runHealthChecks` stores per host (B7-15a).
const mockServerInfo: { value: unknown } = {
  value: { name: "Test Server", protocol_epoch: 1, browser_client_enabled: false },
};
const mockHealthFails = { value: false };
// When set, a failing health probe rejects with this instead of a network error.
const mockHealthError: { value: (() => Error) | null } = { value: null };
vi.mock("@lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lib/api")>();
  return {
    ...actual,
    createApiClient: vi.fn(() => {
      const api = actual.createApiClient({ host: "" });
      return {
        ...api,
        setConfig: vi.fn((cfg: { host?: string; token?: string }) => {
          if (cfg.host !== undefined) mockApiState.host = cfg.host;
          api.setConfig(cfg);
        }),
        login: (...args: unknown[]) => mockLogin(...args),
        recoverAccount: (...args: unknown[]) => mockRecoverAccount(...args),
        verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
        register: (...args: unknown[]) => mockRegister(...args),
        getHealth: vi.fn(() =>
          mockHealthFails.value
            ? Promise.reject(mockHealthError.value ? mockHealthError.value() : new Error("offline"))
            : Promise.resolve({ version: null, online_users: null }),
        ),
        // A server that is down (plain network failure) answers neither probe;
        // a degraded one (health error with a status) still serves server-info.
        getServerInfo: vi.fn(() =>
          mockHealthFails.value && !mockHealthError.value
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(mockServerInfo.value),
        ),
      };
    }),
  };
});

// ConnectPage — captures the real onLogin callback main.ts wires up so the
// test can drive wirePostAuth exactly the way a real login does, without
// building the actual login form DOM.
const capturedConnectCallbacks: {
  onLogin?: (host: string, username: string, password: string) => Promise<void>;
  onRegister?: (
    host: string,
    username: string,
    password: string,
    inviteCode: string,
  ) => Promise<void>;
  onRecover?: (
    host: string,
    username: string,
    secret: string,
    newPassword: string,
  ) => Promise<void>;
  onTotpSubmit?: (code: string) => Promise<void>;
  getRegistrationMode?: (host: string) => string | null;
  getRetentionNotice?: (host: string) => string | null;
  onHostSettled?: (host: string) => void;
  onDeleteProfile?: (profileId: string) => void;
  onToggleAutoLogin?: (profileId: string, enabled: boolean) => void;
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
      showNotice: vi.fn(),
      resetToIdle: vi.fn(),
      updateHealthStatus: vi.fn(),
      updateCompatibility: vi.fn(),
      showIncompatible: vi.fn(),
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
// "main" -> "connect" round trip through the router (the router only navigates
// away from "connect" via the connected overlay's onReady -> router.navigate
// ("main") callback), but doesn't care what MainPage renders, so stand in
// with the same lightweight shape main-page.test.ts's own mocks return.
// A factory that throws makes the dynamic `import("@pages/MainPage")` reject,
// which is what a chunk that fails to load does.
vi.mock("@pages/MainPage", () => {
  throw new Error("chunk failed to load");
});

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

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { expectConsole } from "../helpers/console";
import { authStore, clearAuth } from "@stores/auth.store";
import { createConnectPage } from "@pages/ConnectPage";

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../../src/main");
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  clearAuth();
});

afterEach(async () => {
  clearAuth();
  await vi.advanceTimersByTimeAsync(10);
});

describe("main.ts when the main page chunk fails to load", () => {
  it("shows the fallback with Reload and Sign out, and Sign out ends the session", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("a.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "alex", avatar: null, role: "member" },
          server_name: "A",
          motd: "",
        },
      }),
    );
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    const app = document.getElementById("app")!;
    expect(app.textContent).toContain("Something went wrong");
    expect(app.querySelector('[data-testid="render-fallback-reload"]')?.textContent).toBe("Reload");
    const signOut = app.querySelector<HTMLButtonElement>(
      '[data-testid="render-fallback-sign-out"]',
    );
    expect(signOut?.textContent).toBe("Sign out");
    expectConsole("error", /Main page failed to load/);

    expect(authStore.getState().isAuthenticated).toBe(true);
    vi.mocked(createConnectPage).mockClear();
    signOut!.click();
    expect(authStore.getState().isAuthenticated).toBe(false);
    // Sign out is a real logout: it removes the saved credential (the unit
    // credential store here has nothing to remove).
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("warn", /Credential delete failed/);
    // The connect page is mounted again and the fallback is gone.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(createConnectPage).toHaveBeenCalled();
    expect(app.querySelector('[data-testid="render-fallback-sign-out"]')).toBeNull();
  });
});
