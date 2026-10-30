/**
 * main.ts guards the connect page's onHostSettled with the in-flight set from
 * src/app/serverHealth.ts (WP 7.4f edge case 2): a typed host whose
 * `server-info` probe is already running is not probed twice, and one whose
 * snapshot is already stored is not probed at all. The harness mirrors
 * main-page-load-failure.test.ts: the real main.ts with a ConnectPage stand-in
 * that captures the callbacks, and an API client whose getServerInfo is
 * counted per host.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@lib/message-navigation", () => ({ jumpToMessage: vi.fn() }));
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

vi.mock("@lib/profiles", async (importOriginal) => ({
  deriveCompatibility: (await importOriginal<typeof import("@lib/profiles")>()).deriveCompatibility,
  createTauriBackend: vi.fn(() => ({})),
  createProfileManager: vi.fn(() => mockProfileManager),
}));
vi.mock("@lib/net/updater", () => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  subscribeToUpdateInstall: vi.fn((listener: (state: { status: "idle" }) => void) => {
    listener({ status: "idle" });
    return vi.fn();
  }),
}));

// Every getServerInfo call stays pending until the test settles it.
const infoCalls: Array<{ host: string; settle: () => void }> = [];
vi.mock("@lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lib/api")>();
  return {
    ...actual,
    createApiClient: vi.fn(() => ({
      ...actual.createApiClient({ host: "" }),
      getHealth: vi.fn(() => Promise.resolve({ version: null, online_users: null })),
      getServerInfo: vi.fn(
        (host: string) =>
          new Promise((resolve) => {
            infoCalls.push({
              host,
              settle: () =>
                resolve({ name: "S", protocol_epoch: 1, browser_client_enabled: false }),
            });
          }),
      ),
    })),
  };
});

const captured: { onHostSettled?: (host: string) => void } = {};
vi.mock("@pages/ConnectPage", () => ({
  createConnectPage: vi.fn((callbacks: typeof captured) => {
    Object.assign(captured, callbacks);
    return {
      mount: vi.fn(),
      destroy: vi.fn(),
      updateHealthStatus: vi.fn(),
      updateCompatibility: vi.fn(),
      showIncompatible: vi.fn(),
      getRememberPassword: vi.fn(() => false),
      getAutoConnect: vi.fn(() => false),
      refreshProfiles: vi.fn(),
      applyInviteLink: vi.fn(),
    };
  }),
}));
vi.mock("@pages/MainPage", () => ({ createMainPage: vi.fn() }));
vi.mock("@lib/dispatcher", () => ({
  wireDispatcher: vi.fn(() => () => {}),
  wireConnectionStatus: vi.fn(() => () => {}),
}));

import { mockInvoke } from "./helpers/ws-mocks";

const probesFor = (host: string) => infoCalls.filter((c) => c.host === host);

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../../src/main");
  for (let i = 0; i < 8; i++) await Promise.resolve();
});

beforeEach(() => {
  mockInvoke.mockReset().mockResolvedValue(undefined);
});

describe("onHostSettled", () => {
  it("probes a typed host once while its probe is in flight, and not again once stored", async () => {
    const host = "typed.example:8443";
    expect(typeof captured.onHostSettled).toBe("function");

    captured.onHostSettled!(host);
    captured.onHostSettled!(host);
    expect(probesFor(host)).toHaveLength(1);

    probesFor(host)[0]!.settle();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    captured.onHostSettled!(host);
    expect(probesFor(host)).toHaveLength(1);
  });
});
