import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/mainMocks";
import { mockInvoke, eventHandlers, emitTauriEvent } from "../helpers/ws-mocks";
import { PREAUTH_CONNECT_TIMEOUT_MS } from "@lib/ws";
import { expectConsole } from "../../helpers/console";
import { clearAuth } from "@stores/auth.store";
import { deactivatePendingMessages } from "@lib/pendingMessages";
import { setMarkReadSender } from "@lib/readState";
import type { ReadyChannel } from "@lib/types";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { loadUserStatus, loadUserStatusOrigin } from "@lib/presence/userStatus";
import { createMainPage } from "@pages/MainPage";
import { createCertFirstUseModal, createCertMismatchModal } from "@components/CertMismatchModal";
import { reconnectAfterCertAccept } from "@lib/net/certReconnect";
import { setActivePresenceSender, type PresenceSender } from "@lib/presence/presence";
import { startupInvokes } from "../../helpers/mainMocks";
import {
  latestConnectPage,
  startupApiClient,
  loginAndReachAuthOk,
  useMainHarness,
} from "../../helpers/mainHarness";
import { resetChannelsState } from "../../helpers/storeSeeds";

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

const { mockPrefetchMainPage, mockLogin, capturedConnectCallbacks } = mocks;

useMainHarness();

describe("main.ts startup", () => {
  it("tells the native host once that the first page rendered", () => {
    expect(startupInvokes.filter((cmd) => cmd === "frontend_ready")).toHaveLength(1);
  });
});

describe("main.ts beforeunload", () => {
  const readChannel: ReadyChannel = {
    id: 5,
    name: "general",
    type: "text",
    category: null,
    position: 0,
    unread_count: 0,
    mention_count: 0,
  };

  let hasFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    hasFocus.mockRestore();
    setMarkReadSender(null);
    resetChannelsState();
  });

  it("marks the active channel read, so messages read live do not return as unread", () => {
    const sendMarkRead = vi.fn<(channelId: number) => void>();
    setMarkReadSender(sendMarkRead);
    setChannels([readChannel]);
    setActiveChannel(5);

    window.dispatchEvent(new Event("beforeunload"));

    expect(sendMarkRead).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("sends no mark_read when no channel is active", () => {
    const sendMarkRead = vi.fn<(channelId: number) => void>();
    setMarkReadSender(sendMarkRead);
    setChannels([readChannel]);

    window.dispatchEvent(new Event("beforeunload"));

    expect(sendMarkRead).not.toHaveBeenCalled();
  });

  it("still runs the existing teardown", () => {
    window.dispatchEvent(new Event("beforeunload"));

    expect(deactivatePendingMessages).toHaveBeenCalled();
  });
});

describe("main.ts tray status-change listener", () => {
  it("persists a tray-selected status through saveUserStatus, not just the wire", async () => {
    expect(eventHandlers.has("status-change")).toBe(true);

    emitTauriEvent("status-change", "dnd");

    // This is the crux of OC-0037: the tray path must agree with the
    // client's own documented "single source of truth" for the selected
    // status (lib/presence/userStatus.ts), the same way UserBar's StatusPicker does.
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

describe("main.ts notification-click opens the message (U1d)", () => {
  it("routes a clicked message notification through the shared jumper", async () => {
    const { jumpToMessage } = await import("@lib/nav/messageNavigation");
    // Let the notifier's subscription register (the event API resolves async).
    await Promise.resolve();
    await Promise.resolve();

    const { setChannelMutesHost } = await import("@lib/prefs/channelMutes");
    setChannelMutesHost("a.example");
    vi.mocked(jumpToMessage).mockClear();

    emitTauriEvent("notification-click", { host: "a.example", channelId: 7, messageId: 42 });

    // The cross-server guard lives in the real jumpToMessage (F6 buffers until
    // the host and jumper are live); this mocked seam only checks forwarding.
    expect(vi.mocked(jumpToMessage)).toHaveBeenCalledWith(7, 42, "a.example");
    setChannelMutesHost(null);
  });

  it("routes a clicked call notification (no message id) to the jumper, to open the DM", async () => {
    const { jumpToMessage } = await import("@lib/nav/messageNavigation");
    await Promise.resolve();
    await Promise.resolve();
    const { setChannelMutesHost } = await import("@lib/prefs/channelMutes");
    setChannelMutesHost("a.example");
    vi.mocked(jumpToMessage).mockClear();

    emitTauriEvent("notification-click", { host: "a.example", channelId: 7 });

    expect(vi.mocked(jumpToMessage)).toHaveBeenCalledWith(7, undefined, "a.example");
    setChannelMutesHost(null);
  });

  it("forwards a cross-server click to the jumper, which applies the guard (F6)", async () => {
    const { jumpToMessage } = await import("@lib/nav/messageNavigation");
    await Promise.resolve();
    await Promise.resolve();
    const { setChannelMutesHost } = await import("@lib/prefs/channelMutes");
    setChannelMutesHost("b.example");
    vi.mocked(jumpToMessage).mockClear();

    emitTauriEvent("notification-click", { host: "a.example", channelId: 7, messageId: 42 });

    // The guard is inside the real jumpToMessage; the mocked jumper is still
    // the forwarding target, with the host attached so the real one can drop it.
    expect(vi.mocked(jumpToMessage)).toHaveBeenCalledWith(7, 42, "a.example");
    setChannelMutesHost(null);
  });
});

describe("main.ts clears the per-server notification scope on logout (F13)", () => {
  it("drops the host so Settings stops showing a dead server's override", async () => {
    await loginAndReachAuthOk("scope.example:8443", "alice", {
      user: { id: 9, username: "alice", avatar: null, role: "member" },
      server_name: "Scope Co",
      motd: "",
    });
    const { getChannelMutesHost, setChannelMutesHost } = await import("@lib/prefs/channelMutes");
    // MainPage sets this on mount; stand in for that here.
    setChannelMutesHost("scope.example:8443");

    clearAuth();
    await Promise.resolve();
    await Promise.resolve();

    // This standalone login stores a credential the mocked store cannot keep,
    // so the teardown's delete warns.
    expectConsole("warn", /Credential delete failed/);
    expect(getChannelMutesHost()).toBeNull();
  });
});

describe("main.ts tray status-change routes through the shared PresenceSender", () => {
  afterEach(() => {
    setActivePresenceSender(null);
  });

  it("sends the tray's chosen status through the session's registered PresenceSender, not a raw ws.send", () => {
    // Stand in for the one PresenceSender MainPage.ts registers for the
    // session (via setActivePresenceSender) — the shared limiter token, the
    // coalescing retry, and the optimistic update all live inside it.
    const fakeSender: PresenceSender = {
      send: vi.fn(),
      rollbackRefused: vi.fn(),
      destroy: vi.fn(),
    };
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

describe("main.ts MainPage prefetch", () => {
  it("starts the MainPage chunk load when the login is accepted, before the socket connects", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    mockPrefetchMainPage.mockClear();

    await capturedConnectCallbacks.onLogin!("prefetch.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);

    // The offline server has not answered: the socket is not connected, yet
    // the prefetch is already under way.
    expect(mockPrefetchMainPage).toHaveBeenCalledTimes(1);
    expect(createMainPage).not.toHaveBeenCalled();

    // Drain the pre-auth deadline this attempt leaves behind.
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expectConsole("warn", /Pre-auth connection timed out/);
    expectConsole("warn", /\[main\] Credential delete failed/);
    clearAuth();
  });
});

describe("main.ts pre-auth connection deadline", () => {
  it("returns to the form with an error when a manual login never reaches auth_ok", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("offline.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);
    const attempt = startupApiClient().getSession();

    // The socket was asked to open, but the offline server never answers — so
    // the deadline must give up rather than leave the spinner running forever.
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expectConsole("warn", /Pre-auth connection timed out/);
    expectConsole("warn", /\[main\] Credential delete failed/);
    expect(uiStore.getState().transientError).toContain("offline");
    // Ended like a cancelled auto-login: the dead attempt's scope is no longer live.
    expect(attempt.isCurrent()).toBe(false);

    clearAuth();
  });

  // DP-54 follow-up: the pre-auth deadline must name a certificate failure
  // rather than call an unreachable server. The transport reports the distinct
  // code on the rejected connect (a failed TLS handshake), which the deadline
  // reads to choose its copy.
  it("shows the certificate copy when the pre-auth dial fails on TLS", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    // Fail the current dial on the certificate just before the deadline. The
    // failure clears into a reconnect whose backoff (>= 500ms) lands after the
    // deadline, so the code the transport reported is still the current
    // attempt's when the deadline reads it — a fresh dial would clear it.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd !== "ws_connect") return Promise.resolve(undefined);
      return new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              JSON.stringify({
                error: "TLS_CERT_UNVERIFIED",
                message: "the server's certificate could not be verified",
              }),
            ),
          PREAUTH_CONNECT_TIMEOUT_MS - 100,
        );
      });
    });

    await capturedConnectCallbacks.onLogin!("badcert.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expectConsole("error", /\[ws\] ws_connect failed/);
    expectConsole("warn", /Pre-auth connection timed out/);
    expectConsole("warn", /\[main\] Credential delete failed/);
    expect(uiStore.getState().transientError).toContain("certificate couldn't be verified");
    expect(uiStore.getState().transientError ?? "").not.toContain("offline");

    clearAuth();
  });

  it("does not tear down a session re-dialled after a certificate mismatch", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("rotated.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);

    emitTauriEvent("cert-tofu", {
      host: "rotated.example:8443",
      fingerprint: "sha256:CHANGED",
      status: "mismatch",
      message: "Stored: sha256:ORIGINAL",
    });
    expectConsole("error", /\[ws\] Certificate fingerprint mismatch/);
    expectConsole("warn", /\[main\] Credential delete failed/);

    // The user reads the fingerprint in the mismatch modal for a while, then
    // accepts: the re-dial must still have its host and token to resume with.
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS / 2);
    const { reconnectAfterCertAccept: realReconnect } =
      await vi.importActual<typeof import("@lib/net/certReconnect")>("@lib/net/certReconnect");
    vi.mocked(reconnectAfterCertAccept).mockImplementationOnce(realReconnect);
    vi.mocked(createCertMismatchModal).mock.lastCall![0].onAccept();
    await vi.advanceTimersByTimeAsync(10);
    expect(reconnectAfterCertAccept).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "rotated.example:8443",
      "test-token",
    );

    emitTauriEvent("ws-state", "open");
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "alex", avatar: null, role: "member" },
          server_name: "Rotated",
          motd: "",
        },
      }),
    );
    mockInvoke.mockClear();

    // Past the original deadline, the re-dialled session is live: nothing may
    // tear it down or claim the server is offline.
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS);
    expect(mockInvoke).not.toHaveBeenCalledWith("ws_disconnect");
    expect(uiStore.getState().transientError ?? "").not.toContain("offline");

    clearAuth();
  });

  it("does not time out while the user answers a first-use certificate prompt", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("unpinned.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);

    emitTauriEvent("cert-tofu", {
      host: "unpinned.example:8443",
      fingerprint: "sha256:NEW",
      status: "first_use",
    });
    expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
    expectConsole("warn", /\[main\] Credential delete failed/);
    mockInvoke.mockClear();

    // The server answered; the user is reading the fingerprint past the deadline.
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expect(mockInvoke).not.toHaveBeenCalledWith("ws_disconnect");
    expect(uiStore.getState().transientError ?? "").not.toContain("offline");

    // Accept still resumes this login against the same host.
    vi.mocked(createCertFirstUseModal).mock.lastCall![0].onAccept();
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInvoke).toHaveBeenCalledWith("ws_connect", expect.anything());
    expect(latestConnectPage().resubmitAfterCertAccept).toHaveBeenCalledWith(
      "unpinned.example:8443",
    );

    clearAuth();
  });
});

describe("main.ts native certificate-dialog decline", () => {
  // The native command rejects with this exact string when the user picks No
  // (ws_proxy.rs); every other invoke in these flows resolves.
  function declineAcceptFingerprint(): void {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "accept_cert_fingerprint"
        ? Promise.reject("certificate not accepted")
        : Promise.resolve(undefined),
    );
  }

  it("runs the reject teardown with a notice on the first-use path", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("declined-first.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("warn", /\[main\] Credential delete failed/);

    emitTauriEvent("cert-tofu", {
      host: "declined-first.example:8443",
      fingerprint: "sha256:NEW",
      status: "first_use",
    });
    expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
    await vi.advanceTimersByTimeAsync(10); // the modal chunk loads on demand
    const modalCallsBefore = vi.mocked(createCertFirstUseModal).mock.calls.length;

    declineAcceptFingerprint();
    mockInvoke.mockClear();
    vi.mocked(createCertFirstUseModal).mock.lastCall![0].onAccept();
    await vi.advanceTimersByTimeAsync(10);

    // The connection stays closed: no resume dial after the decline.
    expect(mockInvoke).not.toHaveBeenCalledWith("ws_connect", expect.anything());
    expect(uiStore.getState().transientError).toContain("not accepted");

    // The reject teardown released the modal guard, so a retry can prompt again.
    emitTauriEvent("cert-tofu", {
      host: "declined-first.example:8443",
      fingerprint: "sha256:NEW",
      status: "first_use",
    });
    expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(createCertFirstUseModal).mock.calls.length).toBe(modalCallsBefore + 1);
    vi.mocked(createCertFirstUseModal).mock.lastCall![0].onReject();

    clearAuth();
  });

  it("runs the reject teardown with a notice on the mismatch path", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("declined-mismatch.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("warn", /\[main\] Credential delete failed/);

    emitTauriEvent("cert-tofu", {
      host: "declined-mismatch.example:8443",
      fingerprint: "sha256:CHANGED",
      status: "mismatch",
      message: "Stored: sha256:ORIGINAL",
    });
    expectConsole("error", /Certificate fingerprint mismatch/);
    await vi.advanceTimersByTimeAsync(10); // the modal chunk loads on demand

    declineAcceptFingerprint();
    vi.mocked(reconnectAfterCertAccept).mockClear();
    mockInvoke.mockClear();
    vi.mocked(createCertMismatchModal).mock.lastCall![0].onAccept();
    await vi.advanceTimersByTimeAsync(10);

    // The mismatch must not resume, and the live session is dropped rather
    // than left permanently blocked on the mismatch latch.
    expect(reconnectAfterCertAccept).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("ws_disconnect");
    expect(uiStore.getState().transientError).toContain("not accepted");

    clearAuth();
  });

  it("fails closed when the mismatch modal cannot open", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("modal-load.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("warn", /\[main\] Credential delete failed/);

    vi.mocked(createCertMismatchModal).mockImplementationOnce(() => {
      throw new Error("chunk load failed");
    });
    mockInvoke.mockClear();
    emitTauriEvent("cert-tofu", {
      host: "modal-load.example:8443",
      fingerprint: "sha256:CHANGED",
      status: "mismatch",
      message: "Stored: sha256:ORIGINAL",
    });
    expectConsole("error", /Certificate fingerprint mismatch/);
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("error", /Failed to open certificate modal/);

    // The mismatch latch is set and no modal will answer it, so the session
    // drops rather than sitting on stale authenticated UI.
    expect(mockInvoke).toHaveBeenCalledWith("ws_disconnect");

    clearAuth();
  });

  it("mounts no second trust modal while the native dialog is still open", async () => {
    mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
    await capturedConnectCallbacks.onLogin!("pending-native.example:8443", "alex", "hunter2");
    await vi.advanceTimersByTimeAsync(10);
    expectConsole("warn", /\[main\] Credential delete failed/);

    const firstUse = {
      host: "pending-native.example:8443",
      fingerprint: "sha256:NEW",
      status: "first_use",
    };
    emitTauriEvent("cert-tofu", firstUse);
    expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
    await vi.advanceTimersByTimeAsync(10); // the modal chunk loads on demand

    // The native dialog stays open until the test answers it.
    let answerNative!: (value: unknown) => void;
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "accept_cert_fingerprint"
        ? new Promise((resolve, reject) => {
            answerNative = (v) => (v === "no" ? reject("certificate not accepted") : resolve(v));
          })
        : Promise.resolve(undefined),
    );
    vi.mocked(createCertFirstUseModal).mock.lastCall![0].onAccept();
    await vi.advanceTimersByTimeAsync(10);
    const firstUseCalls = vi.mocked(createCertFirstUseModal).mock.calls.length;
    const mismatchCalls = vi.mocked(createCertMismatchModal).mock.calls.length;

    // A repeated health check re-raises both kinds of event meanwhile.
    emitTauriEvent("cert-tofu", firstUse);
    expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
    emitTauriEvent("cert-tofu", {
      ...firstUse,
      status: "mismatch",
      message: "Stored: sha256:ORIGINAL",
    });
    expectConsole("error", /Certificate fingerprint mismatch/);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(createCertFirstUseModal).mock.calls.length).toBe(firstUseCalls);
    expect(vi.mocked(createCertMismatchModal).mock.calls.length).toBe(mismatchCalls);

    // Once the native dialog is answered, a later event can prompt again.
    answerNative("no");
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("cert-tofu", firstUse);
    expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(createCertFirstUseModal).mock.calls.length).toBe(firstUseCalls + 1);
    vi.mocked(createCertFirstUseModal).mock.lastCall![0].onReject();

    clearAuth();
  });
});

describe("main.ts connected overlay", () => {
  it("shows the auth_ok payload's server_name and motd, not the pre-handshake authStore snapshot", async () => {
    await loginAndReachAuthOk("192.168.1.10:8443", "alex", {
      user: { id: 1, username: "alex", avatar: null, role: "member" },
      server_name: "My Guild",
      motd: "Welcome to My Guild!",
    });
    expectConsole("warn", /\[main\] Credential delete failed/);

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
