/**
 * B7-13 / BPR-034: one live connection, a complete teardown on a profile
 * switch, and a switch that keeps each server's saved sign-in.
 *
 * Drives the real main.ts, ws.ts and stores through main.test.ts's harness,
 * counting transports at the mocked ws_connect / ws_disconnect seam rather
 * than instrumenting ws.ts. Credentials stay keyed by host; there is one
 * profile per host (main.ts ensureProfileExists), so the isolation proven here
 * is between servers, and between sequential accounts on one host through the
 * store and cache resets.
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
vi.mock("@lib/connectionDiagnostics", () => ({ configureConnectionDiagnostics: vi.fn() }));
vi.mock("@lib/pendingMessages", () => ({ deactivatePendingMessages: vi.fn() }));
vi.mock("../../src/platform/desktop/pushToTalk", () => ({
  pushToTalk: { init: vi.fn().mockResolvedValue(undefined) },
}));
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
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  register: vi.fn().mockResolvedValue(undefined),
  getCurrent: vi.fn().mockResolvedValue(null),
  onOpenUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@lib/message-navigation", () => ({ jumpToMessage: vi.fn() }));
vi.mock("@components/CertMismatchModal", () => ({
  createCertMismatchModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
  createCertFirstUseModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));
vi.mock("@lib/cert-reconnect", () => ({ reconnectAfterCertAccept: vi.fn() }));
const PROFILES = [
  {
    id: "p-a",
    name: "Server A",
    host: "a.example:8443",
    username: "alex",
    autoConnect: false,
    rememberPassword: true,
    color: "#5865F2",
  },
  {
    id: "p-b",
    name: "Server B",
    host: "b.example:8443",
    username: "alex",
    autoConnect: false,
    rememberPassword: true,
    color: "#5865F2",
  },
];
vi.mock("@lib/profiles", () => ({
  createTauriBackend: vi.fn(() => ({})),
  createProfileManager: vi.fn(() => ({
    loadProfiles: vi.fn().mockResolvedValue(undefined),
    saveProfiles: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn(() => PROFILES),
    addProfile: vi.fn((data: unknown) => ({ id: "profile-1", ...(data as object) })),
    updateProfile: vi.fn(() => null),
    removeProfile: vi.fn(() => true),
    getAutoConnectProfile: vi.fn(() => null),
    setAutoLogin: vi.fn(),
    setLastConnected: vi.fn(),
  })),
}));

// The media session is its own suite (session-isolation-media.test.ts); here
// only the switch's call into it is observed.
vi.mock("@lib/livekitSession", () => ({ leaveVoice: vi.fn() }));
vi.mock("@lib/notificationSound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/notificationSound")>()),
  cleanupNotificationAudio: vi.fn(),
}));

// api.ts — only login() is exercised (it drives wirePostAuth); nothing else
// in this flow touches the REST client. getConfig()/setConfig() track a real
// host so OC-0028's test can reproduce the isAuthenticated subscriber's
// `api.getConfig().host` read (main.ts:776) after a login sets it via
// `api.setConfig({ host })` (main.ts:515).
const mockLogin = vi.fn();
const HEALTHY = { version: null, online_users: null };
const mockGetHealth = vi.fn();
const mockApiLogout = vi.fn().mockResolvedValue(undefined);
// UpdateNotifier (mounted on the connect page after a protocol-epoch refusal)
// calls checkForUpdate; stub the Tauri-backed updater so the test observes the
// call instead of an invoke() into nothing.
const mockCheckForUpdate = vi.fn();
vi.mock("@lib/updater", () => ({
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  downloadAndInstallUpdate: vi.fn(),
  subscribeToUpdateInstall: vi.fn((listener: (state: { status: "idle" }) => void) => {
    listener({ status: "idle" });
    return vi.fn();
  }),
}));
const mockApiState = { host: "" };
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
        logout: mockApiLogout,
        getHealth: (...args: unknown[]) => mockGetHealth(...args),
      };
    }),
  };
});

// ConnectPage — captures the real onLogin callback main.ts wires up so the
// test can drive wirePostAuth exactly the way a real login does, without
// building the actual login form DOM.
const capturedConnectCallbacks: {
  onLogin?: (host: string, username: string, password: string) => Promise<void>;
  onDeleteProfile?: (profileId: string) => void;
  onAutoLoginCancel?: () => void;
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
      showServerWait: vi.fn(),
      hideServerWait: vi.fn(),
      showError: vi.fn(),
      resetToIdle: vi.fn(),
      updateHealthStatus: vi.fn(),
      updateCompatibility: vi.fn(),
      showIncompatible: vi.fn(),
      getRememberPassword: vi.fn(() => true),
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

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { expectConsole } from "../helpers/console";
import { authStore, clearAuth } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { messagesStore } from "@stores/messages.store";
import { channelsStore } from "@stores/channels.store";
import { blocksStore } from "@stores/blocks.store";
import { voiceStore } from "@stores/voice.store";
import { currentUserPermissions } from "@lib/permissions";
import { cleanupNotificationAudio } from "@lib/notificationSound";
import { leaveVoice } from "@lib/livekitSession";
import { deleteCredential, loadCredential } from "@lib/credentials";
import { PREAUTH_CONNECT_TIMEOUT_MS } from "@lib/ws";
import { createProfileManager } from "@lib/profiles";
import { createConnectPage } from "@pages/ConnectPage";

const A = "a.example:8443";
const B = "b.example:8443";

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../../src/main");
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockReset().mockResolvedValue(undefined);
  mockLogin.mockReset();
  mockGetHealth.mockReset().mockResolvedValue(HEALTHY);
  mockApiLogout.mockClear();
  vi.mocked(deleteCredential).mockReset().mockResolvedValue(true);
  vi.mocked(loadCredential).mockReset().mockResolvedValue(null);
  sessionStorage.clear();
  clearAuth();
});

afterEach(async () => {
  clearAuth();
  await vi.advanceTimersByTimeAsync(10);
  sessionStorage.clear();
});

/** Each ws_connect / ws_disconnect the socket seam saw, in order. */
function transportLog(): string[] {
  return mockInvoke.mock.calls
    .map(([cmd, args]) =>
      cmd === "ws_connect" ? `connect ${String((args as { url: string }).url)}` : String(cmd),
    )
    .filter((entry) => entry.startsWith("connect ") || entry === "ws_disconnect");
}

/** The most transports the log ever had open at once. */
function peakLiveTransports(): number {
  let live = 0;
  let peak = 0;
  for (const entry of transportLog()) {
    live = entry === "ws_disconnect" ? 0 : live + 1;
    peak = Math.max(peak, live);
  }
  return peak;
}

function latestConnectPage() {
  return vi.mocked(createConnectPage).mock.results.at(-1)!.value as {
    selectServer: ReturnType<typeof vi.fn>;
    showAutoConnecting: ReturnType<typeof vi.fn>;
    showServerWait: ReturnType<typeof vi.fn>;
    hideServerWait: ReturnType<typeof vi.fn>;
  };
}

/** The server side of a session: socket open, auth_ok, ready, main page. */
async function completeHandshake(userId: number, serverName: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(10);
  emitTauriEvent("ws-state", "open");
  emitTauriEvent(
    "ws-message",
    JSON.stringify({
      type: "auth_ok",
      payload: {
        user: { id: userId, username: "alex", avatar: null, role: "admin" },
        server_name: serverName,
        motd: "",
      },
    }),
  );
  emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
  await vi.advanceTimersByTimeAsync(800);
}

async function loginWithPassword(host: string, userId: number): Promise<void> {
  mockLogin.mockResolvedValueOnce({ token: `password-token-${host}`, requires_2fa: false });
  await capturedConnectCallbacks.onLogin!(host, "alex", "hunter2");
  await completeHandshake(userId, host);
}

/** SidebarArea's quick-switch overlay: name the target, end the session. */
async function quickSwitchTo(host: string): Promise<void> {
  sessionStorage.setItem("owncord:quick-switch-target", host);
  clearAuth("server_switch");
  await vi.advanceTimersByTimeAsync(10);
}

describe("one live connection across a profile switch (B7-13)", () => {
  it("never holds two transports and closes A's before B's opens", async () => {
    await loginWithPassword(A, 1);
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(peakLiveTransports()).toBe(1);

    await quickSwitchTo(B);
    expect(authStore.getState().isAuthenticated).toBe(false);
    expect(transportLog().at(-1)).toBe("ws_disconnect");

    await loginWithPassword(B, 2);

    const log = transportLog();
    const connectA = log.findIndex((e) => e.startsWith("connect") && e.includes("a.example"));
    const connectB = log.findIndex((e) => e.startsWith("connect") && e.includes("b.example"));
    expect(connectA).toBeGreaterThanOrEqual(0);
    expect(connectB).toBeGreaterThan(connectA);
    expect(log.slice(connectA + 1, connectB)).toContain("ws_disconnect");
    expect(log.filter((e) => e.startsWith("connect"))).toHaveLength(2);
    expect(peakLiveTransports()).toBe(1);
  });
});

describe("profile switch teardown (B7-13)", () => {
  it("resets the domain stores, permissions, voice and notification audio", async () => {
    await loginWithPassword(A, 1);
    // What A's `ready` would have delivered: its role list and active channel.
    channelsStore.setState((s) => ({
      ...s,
      activeChannelId: 42,
      roles: [{ id: 1, name: "admin", color: null, permissions: 0xff, position: 1 }] as never,
    }));
    expect(currentUserPermissions()).toBe(0xff);
    messagesStore.setState((s) => ({ ...s, detachedChannels: new Set([42]) }));
    blocksStore.setState((s) => ({ ...s, blockedByMe: new Set([5]) }));
    voiceStore.setState((s) => ({ ...s, currentChannelId: 3, voiceStatus: "connected" }));
    vi.mocked(cleanupNotificationAudio).mockClear();

    await quickSwitchTo(B);

    expect(channelsStore.getState().activeChannelId).toBeNull();
    expect(messagesStore.getState().detachedChannels.size).toBe(0);
    expect(blocksStore.getState().blockedByMe.size).toBe(0);
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(leaveVoice).toHaveBeenCalled();
    expect(cleanupNotificationAudio).toHaveBeenCalled();
    expect(currentUserPermissions()).toBe(0);
    expect(authStore.getState().token).toBeNull();
  });
});

describe("quick switch keeps each server's saved sign-in (B7-13)", () => {
  it("keeps the departed credential and does not revoke its session", async () => {
    await loginWithPassword(A, 1);

    await quickSwitchTo(B);

    expect(deleteCredential).not.toHaveBeenCalled();
    expect(mockApiLogout).not.toHaveBeenCalled();
  });

  it("resumes with the stored token when switching back, without a password", async () => {
    vi.mocked(loadCredential).mockImplementation(async (host: string) =>
      host === A ? { username: "alex", token: "stored-token-a", hasPassword: true } : null,
    );
    await loginWithPassword(A, 1);
    await quickSwitchTo(B);
    // B has no stored credential: the prefilled form waits for a password.
    expect(authStore.getState().token).toBeNull();
    await loginWithPassword(B, 2);
    const passwordLogins = mockLogin.mock.calls.length;

    await quickSwitchTo(A);
    expect(latestConnectPage().showAutoConnecting).toHaveBeenCalledWith("Server A");
    await completeHandshake(1, A);

    expect(mockLogin.mock.calls.length).toBe(passwordLogins);
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(authStore.getState().token).toBe("stored-token-a");
    expect(transportLog().at(-1)).toContain("a.example");
    expect(peakLiveTransports()).toBe(1);
  });

  it("times out a resume to an offline server, returning to the form with an error", async () => {
    vi.mocked(loadCredential).mockImplementation(async (host: string) =>
      host === A ? { username: "alex", token: "stored-token-a", hasPassword: true } : null,
    );
    await loginWithPassword(A, 1);

    await quickSwitchTo(A);
    await vi.advanceTimersByTimeAsync(10);
    const page = latestConnectPage();
    // The resume reached the transport with the stored token...
    expect(page.showAutoConnecting).toHaveBeenCalledWith("Server A");

    // ...but the offline server never answers, so the pre-auth deadline must
    // end the infinite "Auto-connecting…" screen rather than retry forever.
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);

    expectConsole("warn", /Pre-auth connection timed out/);
    // The connect page reads this store and paints it over the overlay.
    expect(uiStore.getState().transientError).toContain("offline");
    expect(transportLog().at(-1)).toBe("ws_disconnect");
  });

  it("keeps A's sign-in through Add server, so switching back skips the password", async () => {
    vi.mocked(loadCredential).mockImplementation(async (host: string) =>
      host === A ? { username: "alex", token: "stored-token-a", hasPassword: true } : null,
    );
    await loginWithPassword(A, 1);

    // SidebarArea's Add server: end the session with no switch target.
    clearAuth("server_switch");
    await vi.advanceTimersByTimeAsync(10);
    expect(deleteCredential).not.toHaveBeenCalled();

    await loginWithPassword(B, 2);
    const passwordLogins = mockLogin.mock.calls.length;

    await quickSwitchTo(A);
    await completeHandshake(1, A);

    expect(mockLogin.mock.calls.length).toBe(passwordLogins);
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(authStore.getState().token).toBe("stored-token-a");
    expect(peakLiveTransports()).toBe(1);
  });

  it("keeps a host's credential until its last saved profile is deleted", () => {
    const shared = "shared.example:8443";
    const saved = PROFILES.length;
    PROFILES.push(
      { ...PROFILES[0]!, id: "p-main", host: shared },
      { ...PROFILES[0]!, id: "p-alt", host: shared },
    );
    const manager = vi.mocked(createProfileManager).mock.results[0]!.value as {
      removeProfile: ReturnType<typeof vi.fn>;
    };
    manager.removeProfile.mockImplementation((id: string) => {
      PROFILES.splice(
        PROFILES.findIndex((p) => p.id === id),
        1,
      );
      return true;
    });
    try {
      capturedConnectCallbacks.onDeleteProfile!("p-main");
      expect(deleteCredential).not.toHaveBeenCalled();

      capturedConnectCallbacks.onDeleteProfile!("p-alt");
      expect(deleteCredential).toHaveBeenCalledWith(shared);
    } finally {
      PROFILES.splice(saved);
      manager.removeProfile.mockImplementation(() => true);
    }
  });

  it("still deletes the credential on an explicit logout", async () => {
    await loginWithPassword(A, 1);

    clearAuth("user");
    await vi.advanceTimersByTimeAsync(10);

    expect(deleteCredential).toHaveBeenCalledWith(A);
  });
});

describe("keeps retrying a server that was down at launch (P2-T7)", () => {
  const storedA = async (host: string) =>
    host === A ? { username: "alex", token: "stored-token-a", hasPassword: true } : null;

  /** Stored-token connects to A so far. */
  const connectsToA = (): number =>
    transportLog().filter((e) => e.startsWith("connect") && e.includes("a.example")).length;

  /** Health probes of `host` so far. */
  const probesOf = (host: string): number =>
    mockGetHealth.mock.calls.filter(([probed]) => probed === host).length;

  /** A down server fails every probe, and each failure logs; claim them all. */
  function claimHealthWarnings(): void {
    for (;;) {
      try {
        expectConsole("warn", /health check failed/);
      } catch {
        return;
      }
    }
  }

  /** Resume A's stored token while A is down, and let the pre-auth deadline lapse. */
  async function resumeAgainstDownServer(): Promise<void> {
    vi.mocked(loadCredential).mockImplementation(storedA);
    await loginWithPassword(A, 1);
    mockGetHealth.mockImplementation(async (host: string) => {
      if (host === A) throw new Error("connection refused");
      return HEALTHY;
    });
    await quickSwitchTo(A);
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expectConsole("warn", /Pre-auth connection timed out/);
    expect(latestConnectPage().showServerWait).toHaveBeenCalledWith("Server A", A);
  }

  afterEach(() => {
    claimHealthWarnings();
  });

  it("resumes the stored token exactly once when the server comes back", async () => {
    await resumeAgainstDownServer();
    const before = connectsToA();

    // Still down at the first probe (5 s): nothing is resumed.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connectsToA()).toBe(before);

    // Back up by the next probe (backoff: 10 s later).
    mockGetHealth.mockResolvedValue(HEALTHY);
    await vi.advanceTimersByTimeAsync(10_000 + 100);
    expect(connectsToA()).toBe(before + 1);
    expect(latestConnectPage().showAutoConnecting).toHaveBeenLastCalledWith("Server A");

    await completeHandshake(1, A);
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(authStore.getState().token).toBe("stored-token-a");

    // Signed in: the wait is over, and nothing resumes a second time. (Past
    // the 30 s probe cap, short of ws.ts's 60 s liveness redial of a quiet
    // session, which would add a reconnect of its own.)
    await vi.advanceTimersByTimeAsync(40_000);
    expect(connectsToA()).toBe(before + 1);
    expect(peakLiveTransports()).toBe(1);
  });

  it("resumes with the profile's auto-login as it is when the server comes back", async () => {
    const manager = vi.mocked(createProfileManager).mock.results[0]!.value as {
      setAutoLogin: ReturnType<typeof vi.fn>;
    };
    const original = PROFILES[0]!;
    await resumeAgainstDownServer();
    // The user turns auto-login on for A while waiting.
    PROFILES[0] = { ...original, autoConnect: true };
    try {
      manager.setAutoLogin.mockClear();
      mockGetHealth.mockResolvedValue(HEALTHY);
      await vi.advanceTimersByTimeAsync(5_000 + 100);

      expect(latestConnectPage().showAutoConnecting).toHaveBeenLastCalledWith("Server A");
      expect(manager.setAutoLogin).not.toHaveBeenCalledWith(null);
      expect(manager.setAutoLogin).toHaveBeenCalledWith("p-a");
    } finally {
      PROFILES[0] = original;
    }
  });

  it("ends the wait without resuming once the profile is deleted", async () => {
    const original = PROFILES[0]!;
    await resumeAgainstDownServer();
    const before = connectsToA();
    PROFILES.splice(0, 1);
    try {
      mockGetHealth.mockResolvedValue(HEALTHY);
      await vi.advanceTimersByTimeAsync(40_000);

      expect(latestConnectPage().hideServerWait).toHaveBeenCalled();
      expect(connectsToA()).toBe(before);
      expect(authStore.getState().isAuthenticated).toBe(false);
    } finally {
      PROFILES.unshift(original);
    }
  });

  it("backs off from 5 s to 30 s between probes", async () => {
    await resumeAgainstDownServer();
    // Only the wait probes A more often than B: the page's own 15 s check
    // probes both, so the difference is the wait's probes alone.
    const waitProbes = (): number => probesOf(A) - probesOf(B);
    const start = waitProbes();
    const probeTimes: number[] = [];
    for (let s = 1; s <= 130; s++) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (waitProbes() > start + probeTimes.length) probeTimes.push(s);
    }
    expect(probeTimes).toEqual([5, 15, 35, 65, 95, 125]);
  });

  it("stops probing and never resumes once the user cancels the wait", async () => {
    await resumeAgainstDownServer();
    const before = connectsToA();

    capturedConnectCallbacks.onAutoLoginCancel!();
    expect(latestConnectPage().hideServerWait).toHaveBeenCalled();
    mockGetHealth.mockResolvedValue(HEALTHY);
    const [probesA, probesB] = [probesOf(A), probesOf(B)];
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connectsToA()).toBe(before);
    expect(authStore.getState().isAuthenticated).toBe(false);
    // Only the page's own health check still runs, and it probes both alike.
    expect(probesOf(A) - probesA).toBe(probesOf(B) - probesB);
  });

  it("is superseded by a manual login started during the wait", async () => {
    await resumeAgainstDownServer();
    const before = connectsToA();

    await loginWithPassword(B, 2);
    expect(latestConnectPage().hideServerWait).toHaveBeenCalled();
    mockGetHealth.mockResolvedValue(HEALTHY);
    await vi.advanceTimersByTimeAsync(40_000);

    expect(connectsToA()).toBe(before);
    expect(authStore.getState().token).toBe(`password-token-${B}`);
    expect(peakLiveTransports()).toBe(1);
  });

  it("still never resumes after an explicit logout (skip-auto-login)", async () => {
    const manager = vi.mocked(createProfileManager).mock.results[0]!.value as {
      getAutoConnectProfile: ReturnType<typeof vi.fn>;
    };
    manager.getAutoConnectProfile.mockReturnValue({ ...PROFILES[0]!, autoConnect: true });
    try {
      // The logout's credential delete loses the race: the read still finds it.
      vi.mocked(loadCredential).mockImplementation(storedA);
      await loginWithPassword(A, 1);
      const before = connectsToA();

      clearAuth("user");
      await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 60_000);

      expect(connectsToA()).toBe(before);
      expect(latestConnectPage().showAutoConnecting).not.toHaveBeenCalled();
      expect(latestConnectPage().showServerWait).not.toHaveBeenCalled();
      expect(authStore.getState().isAuthenticated).toBe(false);
    } finally {
      manager.getAutoConnectProfile.mockReturnValue(null);
    }
  });
});
