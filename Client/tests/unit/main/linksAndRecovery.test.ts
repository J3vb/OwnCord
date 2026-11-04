import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/mainMocks";
import { mockInvoke, emitTauriEvent } from "../helpers/ws-mocks";
import { expectConsole } from "../../helpers/console";
import { authStore, clearAuth } from "@stores/auth.store";
import { ApiClientError } from "@lib/api";
import { deactivatePendingMessages } from "@lib/pendingMessages";
import { deleteCredential } from "@lib/net/credentials";
import { uiStore, setUpdateRequiredHost } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import { createMainPage } from "@pages/MainPage";
import { createConnectPage } from "@pages/ConnectPage";
import {
  latestConnectPage,
  startupApiClient,
  loginAndReachAuthOk,
  signedInWithDeepLinkHandler,
  dialogShows,
  dialogEl,
  clickDialog,
  useMainHarness,
} from "../../helpers/mainHarness";

vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("@lib/prefs/appearance", () => mocks.prefsAppearanceMock());
vi.mock("@lib/net/connectionDiagnostics", () => mocks.netConnectionDiagnosticsMock());
vi.mock("@pages/mainPagePrefetch", () => mocks.pagesMainPagePrefetchMock());
vi.mock("@lib/pendingMessages", () => mocks.pendingMessagesMock());
vi.mock("../../../src/platform/desktop/pushToTalk", () => mocks.desktopPushToTalkMock());
vi.mock("@lib/logPersistence", () => mocks.logPersistenceMock());
vi.mock("@lib/net/credentials", () => mocks.netCredentialsMock());
vi.mock("@lib/prefs/windowState", () => mocks.prefsWindowStateMock());
vi.mock("@tauri-apps/plugin-deep-link", () => mocks.deepLinkMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/nav/messageNavigation", () => mocks.navMessageNavigationMock());
vi.mock("@components/CertMismatchModal", () => mocks.certMismatchModalMock());
vi.mock("@lib/net/certReconnect", () => mocks.netCertReconnectMock());
vi.mock("@lib/presence/profiles", (importOriginal) => mocks.presenceProfilesMock(importOriginal));
vi.mock("@lib/net/updater", () => mocks.netUpdaterMock());
vi.mock("@lib/api", (importOriginal) => mocks.apiMock(importOriginal));
vi.mock("@pages/ConnectPage", () => mocks.pagesConnectPageMock());
vi.mock("@pages/MainPage", () => mocks.pagesMainPageMock());
vi.mock("@lib/dispatcher", () => mocks.dispatcherMock());

const {
  mockOnOpenUrl,
  mockLeaveVoice,
  mockLogin,
  mockRecoverAccount,
  mockVerifyTotp,
  mockRegister,
  mockCheckForUpdate,
  mockServerInfo,
  mockHealthFails,
  mockHealthError,
  capturedConnectCallbacks,
} = mocks;

useMainHarness();

describe("main.ts invite deep link keeps the current server's credential (F7)", () => {
  afterEach(() => {
    document.querySelectorAll('[data-testid="invite-join-dialog"]').forEach((el) => el.remove());
    mockOnOpenUrl.mockClear();
    vi.mocked(deleteCredential).mockClear();
  });

  it("does not delete the signed-in server's credential when an invite link arrives", async () => {
    // An invite link is not a logout: signing in on server A and clicking an
    // invite link must not silently lose A's remembered password.
    const handler = await signedInWithDeepLinkHandler("server-a.example:8443", "Server A");

    vi.mocked(deleteCredential).mockClear();

    // The deep-link plugin hands the app the invite while the session is live.
    handler(["owncord://invite/ABC123"]);
    await dialogShows("Open this invite?");
    // The link now asks first; the user confirms.
    clickDialog("confirm");

    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(deleteCredential)).not.toHaveBeenCalled();
  });
});

describe("main.ts external invite link asks before leaving the signed-in server (4.12)", () => {
  afterEach(() => {
    document.querySelectorAll('[data-testid="invite-join-dialog"]').forEach((el) => el.remove());
    mockOnOpenUrl.mockClear();
  });

  const signedIn = () => signedInWithDeepLinkHandler("server-a.example:8443", "Server A");

  it("does not end the session until the user confirms, then runs the old path", async () => {
    const handler = await signedIn();
    const connect = vi.mocked(createConnectPage);
    connect.mockClear();

    handler(["owncord://invite/ABC123?host=other.example"]);
    await dialogShows("Open invite for other.example?");

    expect(dialogEl()!.textContent).toContain("You'll leave Server A.");
    expect(dialogEl()!.textContent).not.toContain("your call");
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(connect).not.toHaveBeenCalled();

    clickDialog("confirm");
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(authStore.getState().isAuthenticated).toBe(false);
    expect(authStore.getState().logoutReason).toBe("server_switch");
    expect(connect).toHaveBeenCalled();
    expect(dialogEl()).toBeNull();
  });

  it("Cancel leaves the session as it is and drops the invite", async () => {
    const handler = await signedIn();
    const connect = vi.mocked(createConnectPage);
    connect.mockClear();

    handler(["owncord://invite/ABC123"]);
    await dialogShows("Open this invite?");
    clickDialog("cancel");
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(dialogEl()).toBeNull();
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(connect).not.toHaveBeenCalled();

    // Nothing was left pending: a later trip to the connect page carries no invite.
    clearAuth();
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const page = connect.mock.results.at(-1)!.value as {
      applyInviteLink: ReturnType<typeof vi.fn>;
    };
    expect(page.applyInviteLink).not.toHaveBeenCalled();
  });

  it("a second link while the dialog is open replaces the first, in one dialog", async () => {
    const handler = await signedIn();

    handler(["owncord://invite/FIRST?host=first.example"]);
    await dialogShows("first.example");
    handler(["owncord://invite/SECOND?host=second.example"]);
    await dialogShows("second.example");

    expect(document.querySelectorAll('[data-testid="invite-join-dialog"]')).toHaveLength(1);
    expect(dialogEl()!.textContent).toContain("second.example");
    expect(dialogEl()!.textContent).not.toContain("first.example");

    clickDialog("confirm");
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    const page = latestConnectPage() as {
      applyInviteLink: ReturnType<typeof vi.fn>;
    };
    expect(page.applyInviteLink).toHaveBeenCalledTimes(1);
    expect(page.applyInviteLink).toHaveBeenCalledWith("SECOND", "second.example");
  });

  it("also asks while the connected overlay is up, before the main page mounts", async () => {
    const handler = await signedIn();
    // Back to the connect page, then sign in again and stop at auth_ok: the
    // session is live but the router is still on the connect page.
    clearAuth();
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    mockLogin.mockResolvedValue({ token: "t2", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("server-b.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "alex", avatar: null, role: "member" },
          server_name: "Server B",
          motd: "",
        },
      }),
    );
    expect(authStore.getState().isAuthenticated).toBe(true);
    const connect = vi.mocked(createConnectPage);
    connect.mockClear();

    handler(["owncord://invite/ABC123?host=other.example"]);
    await dialogShows("You'll leave Server B.");
    expect(authStore.getState().isAuthenticated).toBe(true);

    clickDialog("cancel");
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expectConsole("warn", /\[main\] Credential delete failed/);
  });

  it("closes a dialog left open when the session ends, so its confirm cannot fire", async () => {
    const handler = await signedIn();
    handler(["owncord://invite/ABC123?host=other.example"]);
    await dialogShows("other.example");
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="invite-join-confirm"]',
    )!;

    clearAuth();
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(dialogEl()).toBeNull();
    // Even a click on the detached button does nothing.
    const page = latestConnectPage() as {
      applyInviteLink: ReturnType<typeof vi.fn>;
    };
    page.applyInviteLink.mockClear();
    confirm.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(page.applyInviteLink).not.toHaveBeenCalled();
    expect(authStore.getState().logoutReason).not.toBe("server_switch");
  });

  it("returns focus to Cancel when a second link rewrites the dialog", async () => {
    const handler = await signedIn();
    handler(["owncord://invite/FIRST?host=first.example"]);
    await dialogShows("first.example");
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="invite-join-confirm"]',
    )!;
    confirm.focus();
    expect(document.activeElement).toBe(confirm);

    handler(["owncord://invite/SECOND?host=second.example"]);
    await dialogShows("second.example");

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="invite-join-cancel"]'),
    );
    clickDialog("cancel");
  });

  it("says the call ends too when the user is in voice", async () => {
    const handler = await signedIn();
    voiceStore.setState((s) => ({ ...s, currentChannelId: 9 }));

    handler(["owncord://invite/ABC123?host=other.example"]);
    await dialogShows("You'll leave Server A and your call.");

    clickDialog("cancel");
    voiceStore.setState((s) => ({ ...s, currentChannelId: null }));
  });
});

function failNextMainPageMount(): void {
  vi.mocked(createMainPage).mockImplementationOnce(
    () =>
      ({
        mount: () => {
          throw new Error("mount blew up");
        },
        destroy: vi.fn(),
      }) as never,
  );
}

function holdVoiceLeave(): () => void {
  let finishLeave!: () => void;
  mockLeaveVoice.mockReturnValue(
    new Promise<void>((resolve) => {
      finishLeave = resolve;
    }),
  );
  return finishLeave;
}

describe("main.ts render failure recovery (4.12)", () => {
  it("shows Reload and Sign out when the main page's mount throws", async () => {
    failNextMainPageMount();
    await signedInWithDeepLinkHandler("server-a.example:8443", "Server A");

    const app = document.getElementById("app")!;
    expect(app.textContent).toContain("Something went wrong");
    expect(app.textContent).toContain("mount blew up");
    expect(app.querySelector('[data-testid="render-fallback-reload"]')?.textContent).toBe("Reload");
    expectConsole("error", "Component mount failed");

    const signOut = app.querySelector<HTMLButtonElement>(
      '[data-testid="render-fallback-sign-out"]',
    );
    expect(signOut?.textContent).toBe("Sign out");
    expect(authStore.getState().isAuthenticated).toBe(true);
    vi.mocked(createConnectPage).mockClear();
    signOut!.click();
    expect(authStore.getState().isAuthenticated).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // The connect page is back and the fallback is gone.
    expect(createConnectPage).toHaveBeenCalled();
    expect(app.querySelector('[data-testid="render-fallback-sign-out"]')).toBeNull();
    expect(app.textContent).not.toContain("Something went wrong");
  });

  describe("Reload", () => {
    const reload = vi.fn();
    beforeEach(() => {
      reload.mockReset();
      mockLeaveVoice.mockReset().mockResolvedValue(undefined);
      vi.stubGlobal("location", { ...window.location, reload });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      voiceStore.setState((s) => ({ ...s, currentChannelId: null }));
    });

    async function failedMainPage(): Promise<HTMLButtonElement> {
      failNextMainPageMount();
      await signedInWithDeepLinkHandler("server-a.example:8443", "Server A");
      expectConsole("error", "Component mount failed");
      voiceStore.setState((s) => ({ ...s, currentChannelId: 9 }));
      return document.querySelector<HTMLButtonElement>('[data-testid="render-fallback-reload"]')!;
    }

    it("waits for the voice leave to finish before reloading", async () => {
      const finishLeave = holdVoiceLeave();
      const button = await failedMainPage();
      button.click();
      await vi.advanceTimersByTimeAsync(100);

      expect(mockLeaveVoice).toHaveBeenCalledWith(false);
      expect(reload).not.toHaveBeenCalled();
      finishLeave();
      await vi.advanceTimersByTimeAsync(10);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("a second click while the leave is pending waits for it too", async () => {
      const finishLeave = holdVoiceLeave();
      const button = await failedMainPage();
      button.click();
      await vi.advanceTimersByTimeAsync(100);
      button.click();
      await vi.advanceTimersByTimeAsync(100);

      expect(reload).not.toHaveBeenCalled();
      expect(mockLeaveVoice).toHaveBeenCalledTimes(1);
      finishLeave();
      await vi.advanceTimersByTimeAsync(10);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads anyway when the voice leave hangs", async () => {
      mockLeaveVoice.mockReturnValue(new Promise<void>(() => {}));
      const button = await failedMainPage();
      button.click();
      await vi.advanceTimersByTimeAsync(1900);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads anyway when the voice leave throws", async () => {
      mockLeaveVoice.mockRejectedValue(new Error("native gone"));
      const button = await failedMainPage();
      button.click();
      await vi.advanceTimersByTimeAsync(100);
      expectConsole("warn", /Failed to leave voice before reload/);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads at once, with no voice leave, when not in a call", async () => {
      const button = await failedMainPage();
      voiceStore.setState((s) => ({ ...s, currentChannelId: null }));
      button.click();
      await vi.advanceTimersByTimeAsync(10);
      expect(mockLeaveVoice).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});

describe("main.ts connect page after a protocol-epoch refusal", () => {
  it("mounts the update notifier on the connect page so a refused client can update in place", async () => {
    await loginAndReachAuthOk("server-a.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Server A",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);

    // The real dispatcher's auth_error handler records the host when the
    // server says this client's epoch is too old (dispatcher/core.test.ts covers
    // that); the dispatcher is stubbed here, so set what it would have set,
    // then end the session the way auth_error does.
    mockCheckForUpdate.mockResolvedValue({ available: false, version: null, body: null });
    setUpdateRequiredHost({ host: "server-a.example:8443", serverEpoch: 2, clientEpoch: 1 });
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

  it("offers the update when the refusal lands on an already-mounted connect page (first login / startup auto-login)", async () => {
    // No session, no overlay: the connect page rendered at startup is the
    // one the refusal arrives on, and nothing re-renders it (Codex P1). The
    // dispatcher is stubbed here; set what its auth_error handler sets.
    mockCheckForUpdate.mockClear();
    mockCheckForUpdate.mockResolvedValue({ available: false, version: null, body: null });
    setUpdateRequiredHost({ host: "server-c.example:8443", serverEpoch: 2, clientEpoch: 1 });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockCheckForUpdate).toHaveBeenCalledWith("https://server-c.example:8443");
    expect(uiStore.getState().updateRequiredHost).toBeNull();
  });

  it("shows the server-older notice without offering a client update when the refused server is older", async () => {
    mockCheckForUpdate.mockClear();
    const page = latestConnectPage() as {
      showIncompatible: ReturnType<typeof vi.fn>;
    };
    page.showIncompatible.mockClear();
    setUpdateRequiredHost({ host: "old.example:8443", serverEpoch: 1, clientEpoch: 2 });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(3000);
    expect(page.showIncompatible).toHaveBeenCalledWith("old.example:8443", 1, 2);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
    expect(uiStore.getState().updateRequiredHost).toBeNull();
  });

  it.each([
    ["2001:db8::1", "https://[2001:db8::1]"],
    ["::1", "https://[::1]"],
    ["[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
  ])("offers a usable update URL after a protocol refusal from %s", async (host, expectedUrl) => {
    mockCheckForUpdate.mockClear();
    mockCheckForUpdate.mockResolvedValue({ available: false, version: null, body: null });
    setUpdateRequiredHost({ host, serverEpoch: 2, clientEpoch: 1 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockCheckForUpdate).toHaveBeenCalledWith(expectedUrl);
    expect(new URL(expectedUrl).protocol).toBe("https:");
    expect(uiStore.getState().updateRequiredHost).toBeNull();
  });

  it("keeps the stored credential on a protocol-epoch refusal, unlike an ordinary auth_error", async () => {
    await loginAndReachAuthOk("server-d.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Server D",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);

    vi.mocked(deleteCredential).mockClear();
    // What the dispatcher does on protocol_epoch_unsupported (Codex P2).
    clearAuth("protocol_epoch");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The token is still valid: the credential stays so the update can
    // relaunch into auto-login. (The skip-auto-login flag is set on the same
    // path, but the connect page consumes it on mount, so it cannot be read
    // back here — the quick-switch test above covers that consumption.)
    expect(deleteCredential).not.toHaveBeenCalled();

    // Contrast: the same logout for an ordinary reason removes it.
    await loginAndReachAuthOk("server-d.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Server D",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);
    clearAuth("user");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteCredential).toHaveBeenCalledWith("server-d.example:8443");
  });
});

describe("main.ts session ownership", () => {
  it("invalidates API work synchronously on logout before deferred store notifications", () => {
    const api = startupApiClient();
    const owner = api.getSession();
    const cleanup = vi.fn();
    owner.addCleanup(cleanup);
    clearAuth();
    // No await: a queued HTTP completion must already be unable to publish.
    expect(owner.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(api.getConfig().token).toBeUndefined();
    expect(deactivatePendingMessages).toHaveBeenLastCalledWith({ discard: true });
  });

  it("retains pending messages on a deliberate server switch", () => {
    sessionStorage.setItem("owncord:quick-switch-target", "next.example");
    try {
      clearAuth();
      expect(deactivatePendingMessages).toHaveBeenLastCalledWith({ discard: false });
    } finally {
      sessionStorage.removeItem("owncord:quick-switch-target");
    }
  });

  it("reads the registration mode from the per-host server-info snapshot", async () => {
    // The startup health/health-check path fills serverInfoByHost; the connect
    // page's getRegistrationMode callback reads it. An unavailable snapshot
    // (fetch failed / older server) must yield null, never a widened mode.
    expect(capturedConnectCallbacks.getRegistrationMode).toBeTypeOf("function");
    expect(capturedConnectCallbacks.getRegistrationMode!("never-probed.example")).toBeNull();

    // Reach the main page so a later clearAuth() is a real transition back to
    // the connect page, which re-runs the health probe on mount.
    mockServerInfo.value = {
      name: "Test Server",
      protocol_epoch: 1,
      browser_client_enabled: false,
      registration_mode: "approval",
      retention: { messages_days: 30 },
    };
    await loginAndReachAuthOk("snapshot.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Snapshot Co",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);
    clearAuth();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(capturedConnectCallbacks.getRegistrationMode!("localhost:8443")).toBe("approval");
    // B7-15c: the same snapshot feeds the retention sentence at sign-up, and
    // the main page reads it for the signed-in host — null when unprobed.
    expect(capturedConnectCallbacks.getRetentionNotice!("localhost:8443")).toContain(
      "deletes messages after 30 days",
    );
    expect(capturedConnectCallbacks.getRetentionNotice!("never-probed.example")).toBeNull();
    const mainPageOptions = vi.mocked(createMainPage).mock.calls.at(-1)![0];
    expect(mainPageOptions.getRetentionNotice!()).toBeNull();

    // A failed health probe drops the snapshot and refreshes the form through
    // updateCompatibility, so the stale "approval" form cannot outlive it.
    const connectPage = latestConnectPage();
    connectPage.updateCompatibility.mockClear();
    mockHealthFails.value = true;
    await vi.advanceTimersByTimeAsync(15_000);
    mockHealthFails.value = false;
    expectConsole("warn", /health check failed/);
    expect(capturedConnectCallbacks.getRegistrationMode!("localhost:8443")).toBeNull();
    expect(connectPage.updateCompatibility).toHaveBeenCalledWith(
      "localhost:8443",
      "unreachable",
      null,
    );

    // An unrecognised mode string is unavailable, not "open".
    mockServerInfo.value = {
      name: "Test Server",
      protocol_epoch: 1,
      browser_client_enabled: false,
      registration_mode: "banana",
    };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(capturedConnectCallbacks.getRegistrationMode!("localhost:8443")).toBeNull();
  });

  it("a degraded (503) health still runs the server-info probe", async () => {
    // Round-trip through the main page so a fresh connect page (and its
    // health interval) is mounted, as the snapshot test above does.
    await loginAndReachAuthOk("localhost:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Local",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);
    clearAuth();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    const connectPage = latestConnectPage();
    connectPage.updateCompatibility.mockClear();
    mockHealthFails.value = true;
    mockHealthError.value = () => new ApiClientError(503, "DEGRADED", "degraded");
    mockServerInfo.value = {
      name: "Test Server",
      protocol_epoch: 999,
      browser_client_enabled: false,
      registration_mode: "open",
    };
    try {
      await vi.advanceTimersByTimeAsync(15_000);
    } finally {
      mockHealthFails.value = false;
      mockHealthError.value = null;
    }
    expectConsole("warn", /health check failed/);
    expect(connectPage.updateCompatibility).toHaveBeenCalledWith(
      "localhost:8443",
      "client-older",
      999,
    );
    expect(capturedConnectCallbacks.getRegistrationMode!("localhost:8443")).toBe("open");
    expect(connectPage.updateHealthStatus).toHaveBeenCalledWith(
      "localhost:8443",
      expect.objectContaining({ status: "offline" }),
    );
  });

  it("probes server-info for a typed host that is not a saved profile", async () => {
    const connectPage = latestConnectPage();
    connectPage.updateCompatibility.mockClear();
    mockServerInfo.value = {
      name: "Typed",
      protocol_epoch: 1,
      browser_client_enabled: false,
      registration_mode: "open",
    };
    expect(capturedConnectCallbacks.getRegistrationMode!("typed.example:8443")).toBeNull();
    capturedConnectCallbacks.onHostSettled!("typed.example:8443");
    await vi.advanceTimersByTimeAsync(50);
    expect(capturedConnectCallbacks.getRegistrationMode!("typed.example:8443")).toBe("open");
    expect(connectPage.updateCompatibility).toHaveBeenCalledWith(
      "typed.example:8443",
      expect.any(String),
      1,
    );
  });

  it("does not start a second server-info probe for a host already being probed", async () => {
    const api = startupApiClient();
    const calls = vi.mocked(api.getServerInfo).mock.calls.length;
    let release!: () => void;
    vi.mocked(api.getServerInfo).mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(mockServerInfo.value as never))),
    );
    capturedConnectCallbacks.onHostSettled!("slow.example:8443");
    capturedConnectCallbacks.onHostSettled!("slow.example:8443");
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(api.getServerInfo).mock.calls.length).toBe(calls + 1);
    release();
    await vi.advanceTimersByTimeAsync(10);
  });

  it("signs a recovered session in exactly as a login does", async () => {
    const api = startupApiClient();
    const secret = "K7QF-3M2X-9PLA-ZB5A-QW2E-TT7Y-AAAA-BBBB";
    mockRecoverAccount.mockResolvedValueOnce({ token: "recovered-token", requires_2fa: false });
    await capturedConnectCallbacks.onRecover!("recover.example", "alice", secret, "N3w-Str0ng!");
    expectConsole("warn", /\[main\] Credential delete failed/);
    expect(mockRecoverAccount).toHaveBeenCalledWith("alice", secret, "N3w-Str0ng!");
    // The same wirePostAuth tail a login reaches: the session is live.
    expect(api.getConfig().host).toBe("recover.example");
    expect(authStore.getState().token).toBe("recovered-token");
    clearAuth();
  });

  it("keeps the partial token across a wrong emergency recovery code", async () => {
    mockLogin.mockResolvedValueOnce({ partial_token: "partial-1", requires_2fa: true });
    await capturedConnectCallbacks.onLogin!("totp.example", "alice", "hunter22");
    mockVerifyTotp
      .mockRejectedValueOnce(new Error("invalid two-factor code"))
      .mockResolvedValueOnce({ token: "full-token", requires_2fa: false });
    await expect(capturedConnectCallbacks.onTotpSubmit!("ABCDE-FGHJK")).rejects.toThrow(
      "invalid two-factor code",
    );
    await capturedConnectCallbacks.onTotpSubmit!("abcde-fghjm");
    expectConsole("warn", /\[main\] Credential delete failed/);
    expect(mockVerifyTotp).toHaveBeenNthCalledWith(1, "ABCDE-FGHJK", "partial-1");
    expect(mockVerifyTotp).toHaveBeenNthCalledWith(2, "abcde-fghjm", "partial-1");
    clearAuth();
  });

  it("does not let an older same-host login overwrite the newer attempt", async () => {
    await Promise.resolve();
    let resolveOld!: (value: unknown) => void;
    mockLogin.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    mockLogin.mockResolvedValueOnce({ token: "new-account-token", requires_2fa: false });
    const old = capturedConnectCallbacks.onLogin!("same.example", "alice", "first-password");
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await capturedConnectCallbacks.onLogin!("same.example", "bob", "second-password");
    expectConsole("warn", /\[main\] Credential delete failed/);
    const api = startupApiClient();
    const current = api.getSession();
    resolveOld({ token: "old-account-token", requires_2fa: false });
    await rejected;
    expect(api.getSession()).toBe(current);
    expect(current.isCurrent()).toBe(true);
  });
});

describe("main.ts pending-approval notice", () => {
  it("shows registration pending approval as an info notice, not a red error", async () => {
    mockRegister.mockResolvedValueOnce({
      user: { id: 3, username: "newbie" },
      status: "pending_approval",
    });
    await capturedConnectCallbacks.onRegister!("approve.example:8443", "newbie", "hunter22", "");

    const page = latestConnectPage() as {
      showNotice: ReturnType<typeof vi.fn>;
      showError: ReturnType<typeof vi.fn>;
    };
    expect(page.showNotice).toHaveBeenCalledWith(
      "Registration received. An admin has to approve your account before you can sign in.",
    );
    // The info path, not the red error banner.
    expect(page.showError).not.toHaveBeenCalled();
  });
});

describe("main.ts external links (C16)", () => {
  // Links open through the `open_external_url` command (external_open.rs).
  const openedUrls = (): string[] =>
    mockInvoke.mock.calls
      .filter((call) => call[0] === "open_external_url")
      .map((call) => (call[1] as { url: string }).url);

  async function clickLink(attrs: { href: string; masked: boolean }): Promise<void> {
    const a = document.createElement("a");
    a.href = attrs.href;
    a.target = "_blank";
    a.className = attrs.masked ? "msg-link masked" : "msg-link";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // The masked-link dialog is a lazy chunk; wait for it to load and run.
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(10);
  }

  afterEach(() => {
    // Close through the modal's own Escape path so its document listener goes too.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.querySelectorAll('[data-testid="masked-link-dialog"]').forEach((el) => el.remove());
  });

  it("opens a plain link directly, with no dialog", async () => {
    mockInvoke.mockClear();

    await clickLink({ href: "https://example.com/a", masked: false });

    expect(openedUrls()).toEqual(["https://example.com/a"]);
    expect(document.querySelector('[data-testid="masked-link-dialog"]')).toBeNull();
  });

  it("holds a masked link behind the dialog until Go to site", async () => {
    mockInvoke.mockClear();

    await clickLink({ href: "https://masked.example/p", masked: true });

    expect(openedUrls()).toEqual([]);
    expect(document.querySelector('[data-testid="masked-link-url"]')?.textContent).toBe(
      "https://masked.example/p",
    );
    document.querySelector<HTMLButtonElement>('[data-testid="masked-link-go"]')!.click();
    expect(openedUrls()).toEqual(["https://masked.example/p"]);
  });

  it("opens a masked link to a trusted domain without the dialog", async () => {
    const { trustDomain } = await import("@lib/net/trustedDomains");
    mockInvoke.mockClear();
    trustDomain("trusted.example");

    await clickLink({ href: "https://trusted.example/x", masked: true });

    expect(openedUrls()).toEqual(["https://trusted.example/x"]);
    expect(document.querySelector('[data-testid="masked-link-dialog"]')).toBeNull();
  });
});
