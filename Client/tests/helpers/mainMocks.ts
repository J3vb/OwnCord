import { vi } from "vitest";

// main.ts registers its deep-link listener once at startup, and every test
// runs with its mock calls cleared, so the handler is kept here as it arrives.
export const { mockOnOpenUrl, deepLink } = (() => {
  const deepLink: { handler: ((urls: readonly string[]) => void) | null } = { handler: null };
  return {
    deepLink,
    mockOnOpenUrl: vi.fn((handler: (urls: readonly string[]) => void) => {
      deepLink.handler = handler;
      return Promise.resolve(undefined);
    }),
  };
})();

export const { mockPrefetchMainPage } = { mockPrefetchMainPage: vi.fn() };

// The Reload recovery leaves a call through this lazily imported module.
export const { mockLeaveVoice } = {
  mockLeaveVoice: vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve()),
};

export const mockProfileManager = {
  loadProfiles: vi.fn().mockResolvedValue(undefined),
  saveProfiles: vi.fn().mockResolvedValue(undefined),
  getAll: vi.fn((): { id: string; name: string; host: string }[] => []),
  addProfile: vi.fn((data: unknown) => ({ id: "profile-1", ...(data as object) })),
  updateProfile: vi.fn(() => null),
  removeProfile: vi.fn(() => true),
  getAutoConnectProfile: vi.fn(() => null),
  setAutoLogin: vi.fn(),
  setLastConnected: vi.fn(),
};

// api.ts — only login() is exercised (it drives wirePostAuth); nothing else
// in this flow touches the REST client. getConfig()/setConfig() track a real
// host so OC-0028's test can reproduce the isAuthenticated subscriber's
// `api.getConfig().host` read (main.ts:776) after a login sets it via
// `api.setConfig({ host })` (main.ts:515).
export const mockLogin = vi.fn();

export const mockRecoverAccount = vi.fn();

export const mockVerifyTotp = vi.fn();

export const mockRegister = vi.fn();

// UpdateNotifier (mounted on the connect page after a protocol-epoch refusal)
// calls checkForUpdate; stub the Tauri-backed updater so the test observes the
// call instead of an invoke() into nothing.
export const mockCheckForUpdate = vi.fn();

export const mockApiState = { host: "" };

// server-info payload returned by the mocked client, so a test can drive the
// registration-mode snapshot `runHealthChecks` stores per host (B7-15a).
export const mockServerInfo: { value: unknown } = {
  value: { name: "Test Server", protocol_epoch: 1, browser_client_enabled: false },
};

export const mockHealthFails = { value: false };

// When set, a failing health probe rejects with this instead of a network error.
export const mockHealthError: { value: (() => Error) | null } = { value: null };

// main.ts builds its API client once at startup; mock calls are cleared before
// every test, so the client is kept here rather than read from mock.results.
export const createdApiClients: unknown[] = [];

// ConnectPage — captures the real onLogin callback main.ts wires up so the
// test can drive wirePostAuth exactly the way a real login does, without
// building the actual login form DOM.
export const capturedConnectCallbacks: {
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

// Every connect page main.ts builds, in order. The first is built at startup,
// before the per-test mock clear, so tests read pages from here.
export const createdConnectPages: unknown[] = [];

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are registered. #app must
// exist first: main.ts reads document.getElementById("app") synchronously
// at module top level, and a static `import` line would be hoisted above any
// DOM setup written before it in source order — so this runs inside an async
// beforeAll instead of a top-level import.
// ---------------------------------------------------------------------------
export let startupInvokes: unknown[] = [];

// ---------------------------------------------------------------------------
// Tauri API mocks — reuse the ws-mocks.ts event-registry helper so ws.ts's
// real state machine can be driven with simulated Tauri events (same
// mechanism ws-lifecycle.test.ts uses), and so the tray's "status-change"
// listen() call registered by main.ts is capturable via the same
// emitTauriEvent().
// ---------------------------------------------------------------------------
export async function apiCoreMock() {
  return {
    invoke: (await import("../unit/helpers/ws-mocks")).mockInvoke,
  };
}

export async function apiEventMock() {
  return {
    listen: (await import("../unit/helpers/ws-mocks")).mockListen,
  };
}

// CSS imports are handled natively by vite/vitest — no mock needed.
export function prefsAppearanceMock() {
  return { applyStoredAppearance: vi.fn() };
}

export function netConnectionDiagnosticsMock() {
  return { configureConnectionDiagnostics: vi.fn() };
}

export function pagesMainPagePrefetchMock() {
  return { prefetchMainPage: mockPrefetchMainPage };
}

export function pendingMessagesMock() {
  return { deactivatePendingMessages: vi.fn() };
}

export function desktopPushToTalkMock() {
  return {
    pushToTalk: { init: vi.fn().mockResolvedValue(undefined) },
  };
}

export function logPersistenceMock() {
  return {
    initLogPersistence: vi.fn().mockResolvedValue(undefined),
    flushLogs: vi.fn().mockResolvedValue(undefined),
  };
}

export function netCredentialsMock() {
  return {
    saveCredential: vi.fn().mockResolvedValue(true),
    loadCredential: vi.fn().mockResolvedValue(null),
    deleteCredential: vi.fn().mockResolvedValue(undefined),
    createUserUpdateCredentialSaver: vi.fn(() => vi.fn()),
  };
}

export function prefsWindowStateMock() {
  return {
    initWindowState: vi.fn().mockResolvedValue(undefined),
  };
}

export function deepLinkMock() {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    getCurrent: vi.fn().mockResolvedValue(null),
    onOpenUrl: (handler: (urls: readonly string[]) => void) => mockOnOpenUrl(handler),
  };
}

export function voiceLivekitSessionMock() {
  return {
    leaveVoice: (...args: unknown[]) => mockLeaveVoice(...args),
  };
}

export function navMessageNavigationMock() {
  return { jumpToMessage: vi.fn() };
}

export function certMismatchModalMock() {
  return {
    createCertMismatchModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
    createCertFirstUseModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
  };
}

export function netCertReconnectMock() {
  return { reconnectAfterCertAccept: vi.fn() };
}

export async function presenceProfilesMock(importOriginal: <T>() => Promise<T>) {
  return {
    deriveCompatibility: (await importOriginal<typeof import("@lib/presence/profiles")>())
      .deriveCompatibility,
    createTauriBackend: vi.fn(() => ({})),
    createProfileManager: vi.fn(() => mockProfileManager),
  };
}

export function netUpdaterMock() {
  return {
    checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
    downloadAndInstallUpdate: vi.fn(),
    subscribeToUpdateInstall: vi.fn((listener: (state: { status: "idle" }) => void) => {
      listener({ status: "idle" });
      return vi.fn();
    }),
  };
}

export async function apiMock(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("@lib/api")>();
  return {
    ...actual,
    createApiClient: vi.fn(() => {
      const api = actual.createApiClient({ host: "" });
      const client = {
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
      createdApiClients.push(client);
      return client;
    }),
  };
}

export function pagesConnectPageMock() {
  return {
    createConnectPage: vi.fn((callbacks: typeof capturedConnectCallbacks) => {
      Object.assign(capturedConnectCallbacks, callbacks);
      const page = {
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
        resubmitAfterCertAccept: vi.fn(),
        refreshProfiles: vi.fn(),
        selectServer: vi.fn(),
        applyInviteLink: vi.fn(),
      };
      createdConnectPages.push(page);
      return page;
    }),
  };
}

// MainPage.ts pulls in the whole chat/voice UI stack. OC-0028 needs a real
// "main" -> "connect" round trip through the router (main.ts only navigates
// away from "connect" via the connected overlay's onReady -> router.navigate
// ("main") callback), but doesn't care what MainPage renders, so stand in
// with the same lightweight shape the mainPage/ tests' own mocks return.
export function pagesMainPageMock() {
  return {
    createMainPage: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
  };
}

// dispatcher.ts pulls in nearly every store/service in the app. Stand in
// with a slim replacement that reproduces the one behavior these tests must
// stay faithful to: the real dispatcher's auth_ok handler calls setAuth() on
// the REAL authStore (imported below, not mocked) — so main.ts's own race
// against that write is exercised unmodified, not sidestepped.
export async function dispatcherMock() {
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
}

export function setStartupInvokes(calls: unknown[]): void {
  startupInvokes = calls;
}
