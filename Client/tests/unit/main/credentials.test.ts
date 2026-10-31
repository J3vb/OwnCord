import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/mainMocks";
import { emitTauriEvent } from "../helpers/ws-mocks";
import { expectConsole } from "../../helpers/console";
import { authStore, clearAuth } from "@stores/auth.store";
import { deleteCredential, loadCredential, saveCredential } from "@lib/net/credentials";
import { createMainPage } from "@pages/MainPage";
import { latestConnectPage, loginAndReachAuthOk, useMainHarness } from "../../helpers/mainHarness";

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

const { mockProfileManager, mockLogin, mockApiState, capturedConnectCallbacks } = mocks;

useMainHarness();

describe("main.ts remember-password opt-out delete", () => {
  afterEach(() => {
    vi.mocked(loadCredential).mockReset().mockResolvedValue(null);
    vi.mocked(deleteCredential).mockReset().mockResolvedValue(false);
  });

  it("deletes the stored credential unconditionally, regardless of what the stored username was", async () => {
    // The store is keyed by host alone (one credential per host), and
    // save_credential already overwrites it with no username check. The
    // stored username is a stale copy, not an account identity, so the
    // delete must not depend on comparing it to the login username — this
    // stubs loadCredential to return a DIFFERENT username than the one
    // logging in, the case that used to make the delete skip.
    vi.mocked(loadCredential).mockResolvedValue({
      username: "Bob",
      token: "tok",
      hasPassword: true,
    });
    vi.mocked(deleteCredential).mockResolvedValue(true);

    await loginAndReachAuthOk("case-fold.example:8443", "alice", {
      user: { id: 9, username: "alice", avatar: null, role: "member" },
      server_name: "Case Fold Co",
      motd: "",
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(deleteCredential).toHaveBeenCalledWith("case-fold.example:8443");
  });
});

describe("main.ts stay-signed-in storage split", () => {
  const host = "split.example:8443";
  const authOk = {
    user: { id: 9, username: "alice", avatar: null, role: "member" },
    server_name: "Split Co",
    motd: "",
  };
  const page = () =>
    latestConnectPage() as {
      getRememberPassword: ReturnType<typeof vi.fn>;
      getAutoConnect: ReturnType<typeof vi.fn>;
    };

  beforeEach(() => {
    vi.mocked(saveCredential).mockClear();
    vi.mocked(deleteCredential).mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    page().getRememberPassword.mockReturnValue(false);
    page().getAutoConnect.mockReturnValue(false);
  });

  it("Auto connect alone saves the token but not the password, and clears any older password", async () => {
    page().getAutoConnect.mockReturnValue(true);
    page().getRememberPassword.mockReturnValue(false);
    await loginAndReachAuthOk(host, "alice", authOk);
    await vi.advanceTimersByTimeAsync(50);
    expect(saveCredential).toHaveBeenCalledTimes(1);
    expect(saveCredential).toHaveBeenCalledWith(host, "alice", "test-token", undefined, true);
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("Auto connect and Remember together save the token and the password", async () => {
    page().getAutoConnect.mockReturnValue(true);
    page().getRememberPassword.mockReturnValue(true);
    await loginAndReachAuthOk(host, "alice", authOk);
    await vi.advanceTimersByTimeAsync(50);
    expect(saveCredential).toHaveBeenCalledWith(host, "alice", "test-token", "hunter2", false);
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("Remember alone saves the token and the password as before", async () => {
    page().getAutoConnect.mockReturnValue(false);
    page().getRememberPassword.mockReturnValue(true);
    await loginAndReachAuthOk(host, "alice", authOk);
    await vi.advanceTimersByTimeAsync(50);
    expect(saveCredential).toHaveBeenCalledWith(host, "alice", "test-token", "hunter2", false);
  });

  it("neither box ticked deletes the credential and saves nothing", async () => {
    await loginAndReachAuthOk(host, "alice", authOk);
    await vi.advanceTimersByTimeAsync(50);
    expect(saveCredential).not.toHaveBeenCalled();
    expect(deleteCredential).toHaveBeenCalledWith(host);
  });
});

describe("main.ts drops an orphaned stay-signed-in token", () => {
  type P = {
    id: string;
    name: string;
    host: string;
    autoConnect: boolean;
    rememberPassword: boolean;
  };
  const mk = (id: string, autoConnect: boolean, rememberPassword: boolean): P => ({
    id,
    name: id,
    host: `${id}.example:8443`,
    autoConnect,
    rememberPassword,
  });
  let profiles: P[] = [];

  beforeEach(() => {
    vi.mocked(deleteCredential).mockReset().mockResolvedValue(true);
    mockProfileManager.getAll.mockImplementation((() => profiles) as never);
    mockProfileManager.setAutoLogin.mockImplementation(((id: string | null) => {
      profiles = profiles.map((p) => ({ ...p, autoConnect: p.id === id }));
    }) as never);
  });
  afterEach(() => {
    profiles = [];
    mockProfileManager.getAll.mockReset().mockReturnValue([]);
    mockProfileManager.setAutoLogin.mockReset();
  });

  it("deletes the token when the panel toggles Auto connect off an auto-connect-only profile", () => {
    profiles = [mk("a", true, false)];
    capturedConnectCallbacks.onToggleAutoLogin!("a", false);
    expect(deleteCredential).toHaveBeenCalledWith("a.example:8443");
  });

  it("keeps the credential when the profile also remembers its password", () => {
    profiles = [mk("a", true, true)];
    capturedConnectCallbacks.onToggleAutoLogin!("a", false);
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("keeps the credential while another profile on the host still holds a flag", () => {
    profiles = [mk("a", true, false), { ...mk("a", false, true), id: "a2" }];
    capturedConnectCallbacks.onToggleAutoLogin!("a", false);
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("deletes the previous holder's token when a second server claims auto-connect", async () => {
    profiles = [mk("a", true, false), mk("b", false, false)];
    const page = latestConnectPage() as {
      getAutoConnect: ReturnType<typeof vi.fn>;
    };
    page.getAutoConnect.mockReturnValue(true);
    try {
      await loginAndReachAuthOk("b.example:8443", "alice", {
        user: { id: 9, username: "alice", avatar: null, role: "member" },
        server_name: "B",
        motd: "",
      });
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      page.getAutoConnect.mockReturnValue(false);
    }
    expect(deleteCredential).toHaveBeenCalledWith("a.example:8443");
    expect(deleteCredential).not.toHaveBeenCalledWith("b.example:8443");
  });
});

describe("main.ts startup resume of the stored token", () => {
  const host = "resume.example:8443";
  const autoProfile = {
    id: "p-r",
    name: "Resume Co",
    host,
    username: "alex",
    autoConnect: true,
    rememberPassword: false,
  };

  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(deleteCredential).mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    sessionStorage.clear();
    mockProfileManager.getAll.mockReturnValue([]);
    mockProfileManager.getAutoConnectProfile.mockReturnValue(null);
    vi.mocked(loadCredential).mockReset().mockResolvedValue(null);
  });

  /** Re-enter the connect page the way a fresh launch does: no skip flag. */
  async function relaunch(): Promise<void> {
    await loginAndReachAuthOk("elsewhere.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Elsewhere",
      motd: "",
    });
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);
    vi.mocked(createMainPage).mockClear();
    // A fresh launch has no logout behind it, so the skip flag a session end
    // would leave in sessionStorage must not exist when the page mounts.
    const realSet = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key !== "owncord:skip-auto-login") realSet.call(this, key, value);
    });
    clearAuth("server_switch");
    await vi.advanceTimersByTimeAsync(50);
    setItem.mockRestore();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  const lastPage = () =>
    latestConnectPage() as {
      showAutoConnecting: ReturnType<typeof vi.fn>;
    };

  it("resumes the auto-connect profile on a token alone (no remembered password)", async () => {
    mockProfileManager.getAll.mockReturnValue([autoProfile]);
    mockProfileManager.getAutoConnectProfile.mockReturnValue(autoProfile as never);
    vi.mocked(loadCredential).mockResolvedValue({
      username: "alex",
      token: "stored-token",
      hasPassword: false,
    });
    await relaunch();
    expect(lastPage().showAutoConnecting).toHaveBeenCalledWith("Resume Co");
  });

  it("lands on the login form, not the main page, when the stored token is rejected", async () => {
    mockProfileManager.getAll.mockReturnValue([autoProfile]);
    mockProfileManager.getAutoConnectProfile.mockReturnValue(autoProfile as never);
    vi.mocked(loadCredential).mockResolvedValue({
      username: "alex",
      token: "expired-token",
      hasPassword: false,
    });
    await relaunch();
    expect(lastPage().showAutoConnecting).toHaveBeenCalled();
    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({ type: "auth_error", payload: { message: "Invalid or expired token" } }),
    );
    await vi.advanceTimersByTimeAsync(800);
    expectConsole("error", /\[ws\] Authentication failed/);
    expect(authStore.getState().isAuthenticated).toBe(false);
    expect(createMainPage).not.toHaveBeenCalled();
  });

  it("resumes nothing when the profile was deleted", async () => {
    mockProfileManager.getAll.mockReturnValue([]);
    mockProfileManager.getAutoConnectProfile.mockReturnValue(null);
    vi.mocked(loadCredential).mockResolvedValue({
      username: "alex",
      token: "stale-token",
      hasPassword: false,
    });
    await relaunch();
    expect(lastPage().showAutoConnecting).not.toHaveBeenCalled();
  });
});

describe("main.ts profile deletion clears the saved credential (F11)", () => {
  afterEach(() => {
    vi.mocked(deleteCredential).mockReset().mockResolvedValue(false);
    mockProfileManager.removeProfile.mockReset().mockReturnValue(true);
    mockProfileManager.getAll.mockReset().mockReturnValue([]);
  });

  it("deletes the removed profile's host credential so re-adding it cannot resume the old password", async () => {
    // The first read finds the profile; after removal no profile is left on
    // that host, so its credential goes too.
    mockProfileManager.getAll.mockReturnValueOnce([
      { id: "p1", name: "Home", host: "gone.example:8443" },
    ]);
    vi.mocked(deleteCredential).mockResolvedValue(true);

    capturedConnectCallbacks.onDeleteProfile!("p1");
    await Promise.resolve();

    expect(mockProfileManager.removeProfile).toHaveBeenCalledWith("p1");
    expect(deleteCredential).toHaveBeenCalledWith("gone.example:8443");
  });
});

describe("main.ts connected overlay teardown on mid-handshake session end", () => {
  it('destroys the connected overlay when auth clears before the router leaves "connect"', async () => {
    await loginAndReachAuthOk("mid-handshake.example:8443", "casey", {
      user: { id: 7, username: "casey", avatar: null, role: "member" },
      server_name: "Mid Handshake Co",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);

    // auth_ok landed: the overlay is mounted over #app while the router is
    // still "connect" — it only moves to "main" from the overlay's own
    // onReady, once the `ready` event arrives.
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

  it("cancels the overlay's armed onReady hand-off when the session ends right after `ready`", async () => {
    const mainPageCallsBefore = vi.mocked(createMainPage).mock.calls.length;

    await loginAndReachAuthOk("wide-window.example:8443", "riley", {
      user: { id: 8, username: "riley", avatar: null, role: "member" },
      server_name: "Wide Window Co",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);

    // `ready` arrives and arms the overlay's onReady hand-off (which would
    // otherwise call router.navigate("main") on its own on the next task).
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));

    // A queued ban/shutdown task lands before the hand-off task runs.
    clearAuth();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('[data-testid="connected-overlay"]')).toBeNull();

    // Let the hand-off's deadline pass. Without the subscriber's
    // connectedOverlay.destroy() (its AbortController is what cancels the
    // pending setTimeout — see ConnectedOverlay.ts), the already-armed timer
    // still fires onReady() -> router.navigate("main"), mounting MainPage on a
    // cleared authStore and a disconnected socket.
    await vi.advanceTimersByTimeAsync(800);

    expect(vi.mocked(createMainPage).mock.calls.length).toBe(mainPageCallsBefore);
  });
});

describe("main.ts connect-page skip-auto-login flag", () => {
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
    expectConsole("warn", /\[main\] Credential delete failed/);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    // ConnectedOverlay.markReady() hands off on the next task, which starts
    // router.navigate("main") — main.ts's only route away from "connect",
    // needed so a later navigate("connect") is a real transition and not a
    // same-page no-op. The advance flushes both that task and the dynamic
    // MainPage import the navigation awaits.
    await vi.advanceTimersByTimeAsync(800);

    // Quick-switch overlay's flow (SidebarArea.ts:756-760): stash the target
    // host, then log out via a bare clearAuth() (reason defaults to "user").
    // The isAuthenticated subscriber below (main.ts:750-788) turns that into
    // a stored "owncord:skip-auto-login" flag, since host is set.
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
    // would go on to suppress a later, unrelated auto-login.
    expect(sessionStorage.getItem("owncord:skip-auto-login")).toBeNull();
  });
});

describe("main.ts quick-switch resume", () => {
  const target = "server-b.example:8443";
  const profile = {
    id: "p-b",
    name: "Server B",
    host: target,
    username: "alex",
    autoConnect: false,
    rememberPassword: true,
  };

  afterEach(() => {
    sessionStorage.clear();
    mockProfileManager.getAll.mockReturnValue([]);
    vi.mocked(loadCredential).mockResolvedValue(null);
    mockProfileManager.loadProfiles.mockResolvedValue(undefined);
  });

  /** Sign in on server A, then leave it the way the quick-switch overlay does. */
  async function quickSwitchAway(profiles: Array<typeof profile>): Promise<void> {
    await loginAndReachAuthOk("server-a.example:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "Server A",
      motd: "",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);
    emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
    await vi.advanceTimersByTimeAsync(800);
    mockProfileManager.getAll.mockReturnValue(profiles);
    vi.mocked(loadCredential).mockResolvedValue({
      username: "alex",
      token: "stored-token",
      hasPassword: false,
    });
    sessionStorage.setItem("owncord:quick-switch-target", target);
    clearAuth();
  }
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const lastPage = () =>
    latestConnectPage() as {
      showAutoConnecting: ReturnType<typeof vi.fn>;
    };

  it("resumes a profile that remembers its sign-in", async () => {
    await quickSwitchAway([profile]);
    await flush();
    expect(lastPage().showAutoConnecting).toHaveBeenCalledWith("Server B");
  });

  it("does not resume a profile whose remember-password is off", async () => {
    await quickSwitchAway([{ ...profile, rememberPassword: false }]);
    await flush();
    expect(lastPage().showAutoConnecting).not.toHaveBeenCalled();
  });

  it("is not replaced by a resume once a manual login started while profiles load", async () => {
    let release!: () => void;
    mockProfileManager.loadProfiles.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await quickSwitchAway([profile]);
    await flush();
    mockLogin.mockResolvedValue({ token: "manual-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!(target, "alex", "hunter2");
    expectConsole("warn", /\[main\] Credential delete failed/);
    vi.mocked(loadCredential).mockClear();
    release();
    await flush();
    expect(loadCredential).not.toHaveBeenCalled();
    expect(lastPage().showAutoConnecting).not.toHaveBeenCalled();
  });
});
