/**
 * A rejected `import("@pages/MainPage")` must not leave a blank window
 * (roadmap 4.12): the router (src/app/router.ts) shows the render fallback with its Reload and Sign
 * out buttons instead. The mount-throws case is in the main/ tests, which stub a
 * MainPage that loads. The mocks below mirror the main/ tests'.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../helpers/mainMocks";

vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("@lib/prefs/appearance", () => mocks.prefsAppearanceMock());
vi.mock("@lib/net/connectionDiagnostics", () => mocks.netConnectionDiagnosticsMock());
vi.mock("@pages/mainPagePrefetch", () => mocks.pagesMainPagePrefetchMock());
vi.mock("@lib/pendingMessages", () => mocks.pendingMessagesMock());
vi.mock("../../src/platform/desktop/pushToTalk", () => mocks.desktopPushToTalkMock());
vi.mock("@lib/logPersistence", () => mocks.logPersistenceMock());
vi.mock("@lib/net/credentials", () => mocks.netCredentialsMock());
vi.mock("@lib/prefs/windowState", () => mocks.prefsWindowStateMock());
vi.mock("@tauri-apps/plugin-deep-link", () => mocks.deepLinkMock());
vi.mock("@lib/nav/messageNavigation", () => mocks.navMessageNavigationMock());
vi.mock("@components/CertMismatchModal", () => mocks.certMismatchModalMock());
vi.mock("@lib/net/certReconnect", () => mocks.netCertReconnectMock());
vi.mock("@lib/presence/profiles", (importOriginal) => mocks.presenceProfilesMock(importOriginal));
vi.mock("@lib/net/updater", () => mocks.netUpdaterMock());
vi.mock("@lib/api", (importOriginal) => mocks.apiMock(importOriginal));
vi.mock("@pages/ConnectPage", () => mocks.pagesConnectPageMock());
vi.mock("@lib/dispatcher", () => mocks.dispatcherMock());

const { mockLogin, capturedConnectCallbacks } = mocks;

// MainPage.ts pulls in the whole chat/voice UI stack. OC-0028 needs a real
// "main" -> "connect" round trip through the router (the router only navigates
// away from "connect" via the connected overlay's onReady -> router.navigate
// ("main") callback), but doesn't care what MainPage renders, so stand in
// with the same lightweight shape the mainPage/ tests' own mocks return.
// A factory that throws makes the dynamic `import("@pages/MainPage")` reject,
// which is what a chunk that fails to load does.
vi.mock("@pages/MainPage", () => {
  throw new Error("chunk failed to load");
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
