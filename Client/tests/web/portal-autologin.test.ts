/**
 * The portal's resume (WP 6.13e1): a reload resumes from the stored token,
 * including a session-only one; a sign-out stops the next mount resuming; an
 * auth_error on a resume deletes the stored token, an epoch refusal keeps it.
 * The credential store is the real browser adapter over jsdom's Web Storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubGlobal("isSecureContext", true);
});

const hoisted = vi.hoisted(() => ({
  startSession: vi.fn(),
  checkHealth: vi.fn(),
  runHealthChecks: vi.fn(),
}));
vi.mock("../../src/app/serverHealth", () => ({
  checkHealth: hoisted.checkHealth,
  runHealthChecks: hoisted.runHealthChecks,
}));
vi.mock("../../src/app/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/session")>()),
  startSession: hoisted.startSession,
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@pages/mainPagePrefetch", () => ({ prefetchMainPage: vi.fn() }));

import { SessionScope } from "@lib/net/sessionScope";
import type { ProfileManager } from "@lib/presence/profiles";
import type { WsClient } from "@lib/ws";
import { authStore, clearAuth } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { handleAuthError } from "../../src/features/connection/wsHandlers";
import { createAutoLogin } from "../../src/app/autoLogin";
import { configureSession, installLogoutTeardown } from "../../src/app/session";

const HOST = location.host;
const KEY = `owncord:credential:${HOST}`;
const SKIP = "owncord:skip-auto-login";
const CRED = JSON.stringify({ username: "casey", token: "tok" });

interface Profile {
  id: string;
  name: string;
  host: string;
  username?: string;
  autoConnect: boolean;
  rememberPassword: boolean;
}

let profiles: Profile[];
let owner: SessionScope;
let session: SessionScope;
let page: Record<string, ReturnType<typeof vi.fn>>;
let startup: () => void;
let ensureProfileExists: ReturnType<typeof vi.fn>;

const api = {
  getSession: () => session,
  setConfig: vi.fn(),
  // Mirrors the real client: getConfig redacts the token.
  getConfig: () => ({ host: HOST, token: "[redacted]" }),
  endSession: vi.fn(),
};

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const m of Object.values(hoisted)) m.mockReset();
  profiles = [];
  ensureProfileExists = vi.fn();
  owner = new SessionScope({ host: "", generation: 0 });
  session = new SessionScope({ host: "", generation: 0 });
  page = {
    selectServer: vi.fn(),
    refreshProfiles: vi.fn(),
    showAutoConnecting: vi.fn(),
    showError: vi.fn(),
    showServerWait: vi.fn(),
    hideServerWait: vi.fn(),
  };
  const manager = {
    loadProfiles: vi.fn(async () => undefined),
    getAll: () => profiles,
    getAutoConnectProfile: () => profiles.find((p) => p.autoConnect),
  } as unknown as ProfileManager;
  [startup] = createAutoLogin(
    api as never,
    manager,
    owner,
    page as never,
    ensureProfileExists as never,
    () => profiles,
  );
});

afterEach(() => {
  owner.dispose();
  clearAuth();
  vi.restoreAllMocks();
});

describe("portal resume", () => {
  it("resumes session-only token after reload", async () => {
    // An unticked login leaves no auto-connect profile, only the session copy.
    sessionStorage.setItem(KEY, CRED);
    startup();
    await flush();
    expect(page.selectServer).toHaveBeenCalledWith(HOST, "casey", false, false);
    expect(page.showAutoConnecting).toHaveBeenCalled();
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    const args = hoisted.startSession.mock.calls[0]!;
    expect(args.slice(0, 6)).toEqual([HOST, "tok", "casey", undefined, false, false]);
  });

  it("a stand-in resume does not persist stay-signed-in", async () => {
    // The user unticked the box, so only a session-only token exists and no
    // profile does. Resuming it must not write "autoConnect: true" anywhere.
    sessionStorage.setItem(KEY, CRED);
    startup();
    await flush();
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession.mock.calls[0]?.[7]).toBe(false);
    for (const call of ensureProfileExists.mock.calls) expect(call[3]).toBe(false);
  });

  it("resumes a saved profile whose flags are both off", async () => {
    profiles = [
      {
        id: "p",
        name: "chat",
        host: HOST,
        username: "casey",
        autoConnect: false,
        rememberPassword: false,
      },
    ];
    localStorage.setItem(KEY, CRED);
    startup();
    await flush();
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession.mock.calls[0]?.[0]).toBe(HOST);
    expect(hoisted.startSession.mock.calls[0]?.[7]).toBe(false);
  });

  it("ignores a profile for another host and starts nothing without a token", async () => {
    profiles = [
      {
        id: "o",
        name: "other",
        host: "other.example",
        autoConnect: true,
        rememberPassword: true,
      },
    ];
    startup();
    await flush();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.selectServer).not.toHaveBeenCalled();
  });

  it("skip flag after sign out prevents resume", async () => {
    // Sign in, then sign out through the real logout teardown.
    const navigate = vi.fn();
    const ws = { disconnect: vi.fn(), send: vi.fn() } as unknown as WsClient;
    configureSession(api as never, ws, document.createElement("div"), () => "main", navigate);
    installLogoutTeardown();
    localStorage.setItem(KEY, CRED);
    sessionStorage.setItem(KEY, CRED);
    authStore.setState((prev) => ({ ...prev, isAuthenticated: true }));
    await flush();
    clearAuth();
    await flush();

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(SKIP)).toBe("1");
    expect(navigate).toHaveBeenCalledWith("connect");

    // Even a token that came back (a second tab signed in) is not resumed.
    sessionStorage.setItem(KEY, CRED);
    startup();
    await flush();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SKIP)).toBeNull();
  });
});

describe("portal auth_error on a resume", () => {
  it("a sign-out or auth_error in one tab leaves a different token stored by another tab", async () => {
    // This tab's attempt sent T1 (session-only); another tab has since kept T2.
    authStore.setState((prev) => ({ ...prev, token: "T1" }));
    sessionStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "T1" }));
    localStorage.setItem(KEY, JSON.stringify({ username: "casey", token: "T2" }));
    handleAuthError(api as never, { message: "invalid token" });
    await flush();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY)!).token).toBe("T2");
  });

  it("auth_error on resume deletes both copies", async () => {
    authStore.setState((prev) => ({ ...prev, token: "tok" }));
    localStorage.setItem(KEY, CRED);
    sessionStorage.setItem(KEY, CRED);
    handleAuthError(api as never, { message: "invalid token" });
    await flush();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(uiStore.getState().transientError).toBe("invalid token");
  });

  it("epoch refusal keeps token", async () => {
    localStorage.setItem(KEY, CRED);
    sessionStorage.setItem(KEY, CRED);
    handleAuthError(api as never, {
      message: "update required",
      code: "protocol_epoch_unsupported",
      server_epoch: 9,
    });
    await flush();
    expect(localStorage.getItem(KEY)).toBe(CRED);
    expect(sessionStorage.getItem(KEY)).toBe(CRED);
  });
});
