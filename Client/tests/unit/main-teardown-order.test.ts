/**
 * Characterization tests for src/main.ts's session teardown ORDER (WP 7.4a).
 *
 * The teardown sequence (dispatcher unsubscribe, session unsubscribe,
 * connected-overlay destroy, ws.disconnect, credential delete) is written out
 * five times in main.ts, in two orders (design note 7.4, section 1 and its
 * correction section): order A puts the explicit cleanups before
 * ws.disconnect() (onAutoLoginCancel, handleInviteDeepLink, the
 * isAuthenticated subscriber); order B puts ws.disconnect() first (the
 * pre-auth deadline).
 *
 * The real invariant: on every path api.endSession() (or the session reset
 * clearAuth runs) disposes the owner scope BEFORE ws.disconnect(). That scope
 * already holds the dispatcher unsubscribe, the session unsubscribe and the
 * overlay destroy, so the dispatcher's onStateChange listeners never see the
 * "disconnected" transition, in A or in B. A and B differ only in where the
 * now-redundant explicit cleanups sit relative to ws.disconnect().
 *
 * Those redundant calls are pinned on purpose, so a verbatim move keeps them.
 * A later PR that dedupes them is not a behaviour change and should update
 * the affected entries here. ws.ts, authStore and the overlay are real; only
 * the dispatcher stand-in and a recording wrapper around the ws client's
 * disconnect/send/onServerBusy are added.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

/** Everything the session teardown does, in the order it did it. */
const { events, wsClients } = vi.hoisted(() => ({
  events: [] as string[],
  wsClients: [] as Array<{
    onStateChange: (cb: (state: string) => void) => () => void;
    disconnect: () => void;
  }>,
}));

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
vi.mock("@pages/mainPagePrefetch", () => ({ prefetchMainPage: vi.fn() }));
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
  deleteCredential: vi.fn(async (_host: string) => {
    events.push("credential-delete");
    return true;
  }),
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
// The Reload recovery leaves a call through this lazily imported module.
const { mockLeaveVoice } = vi.hoisted(() => ({
  mockLeaveVoice: vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve()),
}));
vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    leaveVoice: (...args: unknown[]) => mockLeaveVoice(...args),
  }),
);
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

// api.ts — only login() is exercised (it drives wirePostAuth); the rest of the
// real client stays, so getConfig()/setConfig() track the host the logout
// subscriber reads when it deletes the stored credential.
const mockLogin = vi.fn();
// The updater is Tauri-backed; stub it so nothing invokes into the void.
vi.mock("@lib/net/updater", () => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  subscribeToUpdateInstall: vi.fn((listener: (state: { status: "idle" }) => void) => {
    listener({ status: "idle" });
    return vi.fn();
  }),
}));
vi.mock("@lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lib/api")>();
  return {
    ...actual,
    createApiClient: vi.fn(() => {
      const api = actual.createApiClient({ host: "" });
      return {
        ...api,
        login: (...args: unknown[]) => mockLogin(...args),
        getHealth: vi.fn(() => Promise.resolve({ version: null, online_users: null })),
        getServerInfo: vi.fn(() =>
          Promise.resolve({
            name: "Test Server",
            protocol_epoch: 1,
            browser_client_enabled: false,
          }),
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

// MainPage.ts pulls in the whole chat/voice UI stack. These tests need a real
// "connect" -> "main" -> "connect" round trip through the router (the router only
// navigates to "main" from the connected overlay's onReady callback), but do
// not care what MainPage renders, so stand in with a lightweight shape.
vi.mock("@pages/MainPage", () => ({
  createMainPage: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));

// dispatcher.ts pulls in nearly every store/service in the app. Stand in
// with a slim replacement that reproduces the one behavior these tests must
// stay faithful to: the real dispatcher's auth_ok handler calls setAuth() on
// the REAL authStore (imported below, not mocked) — so main.ts's own race
// against that write is exercised unmodified, not sidestepped.
// ws.ts stays real. Only disconnect, send and onServerBusy are wrapped so the
// teardown order is recorded: onServerBusy's unsubscribe is one of the
// session-scoped listeners (sessionUnsubs), so it stands for the session
// cleanup.
vi.mock("@lib/ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lib/ws")>();
  return {
    ...actual,
    createWsClient: (...args: Parameters<typeof actual.createWsClient>) => {
      const client = actual.createWsClient(...args);
      const wrapped = {
        ...client,
        disconnect: () => {
          events.push("ws-disconnect");
          client.disconnect();
        },
        send: (...sendArgs: Parameters<typeof client.send>) => {
          if (sendArgs[0].type === "voice_leave") events.push("voice-leave-sent");
          return client.send(...sendArgs);
        },
        onServerBusy: (...busyArgs: Parameters<typeof client.onServerBusy>) => {
          const unsub = client.onServerBusy(...busyArgs);
          return () => {
            events.push("session-unsub");
            unsub();
          };
        },
      };
      wsClients.push(wrapped);
      return wrapped;
    },
  };
});

// Dispatcher stand-in with the two behaviours the order depends on: it
// subscribes an onStateChange listener (as the real one does at
// lib/dispatcher.ts:281,338,348) that records the transitions it observes,
// and its returned unsubscribe records and removes it. Its auth_ok handler
// writes authStore like the real one, so the overlay flow is unchanged.
let dispatcherSeq = 0;
vi.mock("@lib/dispatcher", async () => {
  const { authStore, setAuth } = await import("@stores/auth.store");
  return {
    wireDispatcher: (ws: {
      on: (type: string, cb: (payload: unknown) => void) => () => void;
      onStateChange: (cb: (state: string) => void) => () => void;
    }) => {
      const id = ++dispatcherSeq;
      const unsubAuthOk = ws.on("auth_ok", (payload) => {
        const p = payload as { user: unknown; server_name: string; motd: string };
        setAuth(authStore.getState().token ?? "", p.user as never, p.server_name, p.motd);
      });
      const unsubState = ws.onStateChange((state) => events.push(`dispatcher-${id}-saw-${state}`));
      return () => {
        events.push(`dispatcher-${id}-unsub`);
        unsubAuthOk();
        unsubState();
      };
    },
    wireConnectionStatus: vi.fn(() => () => {}),
  };
});

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { PREAUTH_CONNECT_TIMEOUT_MS } from "@lib/ws";
import { expectConsole } from "../helpers/console";
import { authStore, clearAuth } from "@stores/auth.store";
import { deleteCredential } from "@lib/net/credentials";
import { joinVoiceChannel } from "@stores/voice.store";
import { createConnectPage } from "@pages/ConnectPage";
import { createMainPage } from "@pages/MainPage";
import { requestInviteJoin } from "@lib/nav/inviteNavigation";

let startupDone = false;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../../src/main");
  await Promise.resolve();
  await Promise.resolve();
  startupDone = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  clearAuth();
  events.length = 0;
  dispatcherSeq = 0;
});

afterEach(async () => {
  clearAuth();
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
});

const USER = { id: 7, username: "casey", avatar: null, role: "member" };

async function startLogin(host: string): Promise<void> {
  mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
  await capturedConnectCallbacks.onLogin!(host, "casey", "hunter2");
  await vi.advanceTimersByTimeAsync(10);
}
async function reachAuthOk(): Promise<void> {
  emitTauriEvent("ws-state", "open");
  emitTauriEvent(
    "ws-message",
    JSON.stringify({ type: "auth_ok", payload: { user: USER, server_name: "Srv", motd: "" } }),
  );
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(10);
};

const HOST = "a.example:8443";
const overlays = (): number =>
  document.querySelectorAll('[data-testid="connected-overlay"]').length;

describe("main.ts session teardown order", () => {
  it("starts from the real startup", () => {
    expect(startupDone).toBe(true);
  });

  // Order B: the pre-auth deadline calls ws.disconnect() before its explicit
  // cleanups. The first two entries are api.endSession() disposing the
  // owner scope, which runs the dispatcher and session cleanups registered on
  // it; the explicit cleanups session.ts then runs land AFTER ws.disconnect().
  it("pre-auth deadline: endSession, then ws.disconnect, then the explicit cleanups", async () => {
    await startLogin(HOST);
    events.length = 0;
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expectConsole("warn", /Pre-auth connection timed out/);

    expect(events).toEqual([
      "dispatcher-1-unsub",
      "session-unsub",
      "ws-disconnect",
      "dispatcher-1-unsub",
    ]);
    expect(events.lastIndexOf("dispatcher-1-unsub")).toBeGreaterThan(
      events.indexOf("ws-disconnect"),
    );
  });

  // Order A: the cleanups run first, ws.disconnect() last.
  describe("cancel and invite: endSession, then the explicit cleanups, then ws.disconnect", () => {
    const orderA = ["dispatcher-1-unsub", "session-unsub", "dispatcher-1-unsub", "ws-disconnect"];

    it("on auto-login Cancel", async () => {
      await startLogin(HOST);
      await reachAuthOk();
      expect(overlays()).toBe(1);
      events.length = 0;

      capturedConnectCallbacks.onAutoLoginCancel!();

      expect(events).toEqual(orderA);
      expect(events.lastIndexOf("dispatcher-1-unsub")).toBeLessThan(
        events.indexOf("ws-disconnect"),
      );
      expect(overlays()).toBe(0);
    });

    it("on an in-chat invite while a session is connecting", async () => {
      await startLogin(HOST);
      await reachAuthOk();
      events.length = 0;

      requestInviteJoin("ABC123");
      await flush();

      expect(events).toEqual(orderA);
      expect(events.lastIndexOf("dispatcher-1-unsub")).toBeLessThan(
        events.indexOf("ws-disconnect"),
      );
      expect(overlays()).toBe(0);
    });
  });

  // Pins the corollary that makes B and A look the same to a dispatcher: on
  // every path api.endSession() has already detached the dispatcher's
  // onStateChange listeners before the socket closes, so the "disconnected"
  // transition is observed by none of them. If a later change moves
  // ws.disconnect() ahead of the endSession, this goes red on purpose.
  describe("endSession before ws.disconnect: no teardown path lets the dispatcher observe the close", () => {
    it("positive control: a listener attached to the client does observe ws.disconnect()", async () => {
      await startLogin(HOST);
      await reachAuthOk();
      // Same client the tests above use (the wrapped one main.ts built): its
      // own listener, never detached by endSession, must record the close.
      const seen: string[] = [];
      const client = wsClients[0]!;
      const off = client.onStateChange((s) => seen.push(s));
      client.disconnect();
      off();
      expect(seen).toContain("disconnected");
      expect(events).toContain("ws-disconnect");
    });

    it("pre-auth deadline", async () => {
      await startLogin(HOST);
      await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
      expectConsole("warn", /Pre-auth connection timed out/);
      expect(events.filter((e) => e.includes("-saw-disconnected"))).toEqual([]);
    });

    it("auto-login Cancel", async () => {
      await startLogin(HOST);
      await reachAuthOk();
      capturedConnectCallbacks.onAutoLoginCancel!();
      expect(events.filter((e) => e.includes("-saw-disconnected"))).toEqual([]);
    });

    it("logout", async () => {
      await startLogin(HOST);
      await reachAuthOk();
      clearAuth();
      await flush();
      expect(events.filter((e) => e.includes("-saw-disconnected"))).toEqual([]);
    });
  });

  it("logout teardown leaves voice, then dispatcher, then session, then disconnect, then deletes the credential", async () => {
    await startLogin(HOST);
    await reachAuthOk();
    joinVoiceChannel(5);
    mockLeaveVoice.mockClear();
    events.length = 0;

    clearAuth();
    await flush();

    expect(authStore.getState().logoutWasInVoice).toBe(true);
    // Leading dispatcher/session entries: api.endSession() from the session
    // reset that clearAuth runs. Then the subscriber: voice_leave (after the
    // lazy leaveVoice(false) is requested), the explicit dispatcher cleanup
    // (the session cleanup is already drained, so it logs nothing), the
    // disconnect, and last the credential delete.
    expect(events).toEqual([
      "dispatcher-1-unsub",
      "session-unsub",
      "voice-leave-sent",
      "dispatcher-1-unsub",
      "ws-disconnect",
      "credential-delete",
    ]);
    expect(mockLeaveVoice).toHaveBeenCalledWith(false);
    expect(vi.mocked(deleteCredential)).toHaveBeenLastCalledWith(HOST);
  });

  it("a second login without logout destroys the first overlay and listeners", async () => {
    await startLogin(HOST);
    await reachAuthOk();
    expect(overlays()).toBe(1);
    events.length = 0;

    await startLogin(HOST);

    // The prelude tears the first session down without closing the socket
    // (the next ws.connect supersedes it): overlay gone, dispatcher 1 and its
    // session listeners unsubscribed, no ws.disconnect.
    expect(overlays()).toBe(0);
    expect(events).toEqual([
      "dispatcher-1-unsub",
      "session-unsub",
      "dispatcher-1-unsub",
      "credential-delete",
    ]);
    expect(events).not.toContain("ws-disconnect");

    await reachAuthOk();
    // Only the second dispatcher sees the new connection, and one overlay shows.
    expect(events.filter((e) => e.startsWith("dispatcher-1-saw"))).toEqual([]);
    expect(events).toContain("dispatcher-2-saw-connected");
    expect(overlays()).toBe(1);
  });

  // Edge case 2: the connect retry re-enters startSession (wirePostAuth) after
  // the first attempt timed out. The dead attempt's deadline and listeners are
  // gone, and the new attempt gets its own deadline and the same order B.
  it("a retry after the pre-auth deadline wires a fresh session whose deadline repeats the same sequence", async () => {
    await startLogin(HOST);
    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expectConsole("warn", /Pre-auth connection timed out/);
    events.length = 0;

    await startLogin(HOST);
    // Nothing of the dead attempt is torn down again, and nothing fires early.
    expect(events).toEqual(["credential-delete"]);

    await vi.advanceTimersByTimeAsync(PREAUTH_CONNECT_TIMEOUT_MS + 100);
    expectConsole("warn", /Pre-auth connection timed out/);
    expect(events.slice(1)).toEqual([
      "dispatcher-2-unsub",
      "session-unsub",
      "ws-disconnect",
      "dispatcher-2-unsub",
    ]);
    expect(events.filter((e) => e.startsWith("dispatcher-1"))).toEqual([]);
  });

  // The path a move is most likely to break: a signed-in user on the main page.
  describe("from the main page", () => {
    async function reachMainPage(): Promise<void> {
      await startLogin(HOST);
      await reachAuthOk();
      emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
      // The overlay's own timer hands off to navigate("main").
      await vi.advanceTimersByTimeAsync(800);
      expect(overlays()).toBe(0);
      expect(vi.mocked(createMainPage)).toHaveBeenCalled();
    }

    it("logout runs the full teardown and deletes the credential", async () => {
      await reachMainPage();
      vi.mocked(createConnectPage).mockClear();
      events.length = 0;

      clearAuth();
      await flush();

      expect(events).toEqual([
        "dispatcher-1-unsub",
        "session-unsub",
        "dispatcher-1-unsub",
        "ws-disconnect",
        "credential-delete",
      ]);
      expect(vi.mocked(deleteCredential)).toHaveBeenLastCalledWith(HOST);
      expect(vi.mocked(createConnectPage)).toHaveBeenCalled();
    });

    it("an invite link tears down through clearAuth(server_switch) and keeps the credential", async () => {
      await reachMainPage();
      vi.mocked(createConnectPage).mockClear();
      events.length = 0;

      requestInviteJoin("ABC123");
      await flush();

      expect(authStore.getState().logoutReason).toBe("server_switch");
      expect(events).toEqual([
        "dispatcher-1-unsub",
        "session-unsub",
        "dispatcher-1-unsub",
        "ws-disconnect",
      ]);
      expect(events).not.toContain("credential-delete");
      expect(vi.mocked(createConnectPage)).toHaveBeenCalled();
    });
  });
});
