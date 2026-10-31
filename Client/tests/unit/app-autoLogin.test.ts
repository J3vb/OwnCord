/**
 * Tests for src/app/autoLogin.ts (WP 7.4g): the connect page's auto-login,
 * moved out of main.ts. createAutoLogin() gets an in-memory profile manager, a
 * real SessionScope as the page owner and a fake API whose endSession() ends
 * the current session scope, as the real client does.
 *
 * The two edge cases the move must keep: the skip-auto-login flag is consumed
 * on every connect mount still current after the profile load, quick switch
 * included (OC-0028); and a manual login started while the profiles load is
 * never replaced by a resume, a server wait ending with its API session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as gate, type Deferred } from "../helpers/deferred";
import { SessionScope } from "@lib/net/sessionScope";
import type { ProfileManager } from "@lib/presence/profiles";

const hoisted = vi.hoisted(() => ({
  loadCredential: vi.fn(),
  startSession: vi.fn(),
  checkHealth: vi.fn(),
  runHealthChecks: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@lib/net/credentials", () => ({ loadCredential: hoisted.loadCredential }));
vi.mock("../../src/app/session", () => ({ startSession: hoisted.startSession }));
vi.mock("../../src/app/serverHealth", () => ({
  checkHealth: hoisted.checkHealth,
  runHealthChecks: hoisted.runHealthChecks,
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: hoisted.warn,
    error: vi.fn(),
  }),
}));

import { connectText } from "../../src/i18n/connect";
import { createAutoLogin } from "../../src/app/autoLogin";

interface P {
  id: string;
  name: string;
  host: string;
  username?: string;
  autoConnect: boolean;
  rememberPassword: boolean;
}

const SKIP = "owncord:skip-auto-login";
const SWITCH = "owncord:quick-switch-target";

const alpha: P = {
  id: "a",
  name: "Alpha",
  host: "alpha.example",
  username: "ann",
  autoConnect: true,
  rememberPassword: true,
};
const beta: P = {
  id: "b",
  name: "Beta",
  host: "beta.example",
  username: "bob",
  autoConnect: false,
  rememberPassword: true,
};

let profiles: P[];
let loadGate: Deferred<void>;
let loadProfiles: ReturnType<typeof vi.fn>;
let session: SessionScope;
let owner: SessionScope;
let api: {
  getSession: () => SessionScope;
  setConfig: ReturnType<typeof vi.fn>;
  endSession: () => void;
};
type PageMethod =
  | "selectServer"
  | "refreshProfiles"
  | "showAutoConnecting"
  | "showError"
  | "showServerWait"
  | "hideServerWait";
let page: Record<PageMethod, ReturnType<typeof vi.fn>>;
let ensureProfileExists: ReturnType<typeof vi.fn>;
let startup: () => void;
let cancel: () => void;
let forgetHost: (host: string) => void;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  sessionStorage.clear();
  for (const m of Object.values(hoisted)) m.mockReset();
  hoisted.loadCredential.mockResolvedValue({ username: "ann", token: "tok" });
  hoisted.checkHealth.mockResolvedValue(true);
  profiles = [alpha, beta];
  loadGate = gate();
  loadProfiles = vi.fn(() => loadGate.promise);
  session = new SessionScope({ host: "", generation: 0 });
  owner = new SessionScope({ host: "", generation: 0 });
  let generation = 0;
  api = {
    getSession: () => session,
    setConfig: vi.fn(),
    endSession: () => {
      session.dispose();
      session = new SessionScope({ host: "", generation: ++generation });
    },
  };
  page = {
    selectServer: vi.fn(),
    refreshProfiles: vi.fn(),
    showAutoConnecting: vi.fn(),
    showError: vi.fn(),
    showServerWait: vi.fn(),
    hideServerWait: vi.fn(),
  };
  ensureProfileExists = vi.fn();
  const manager = {
    loadProfiles,
    getAll: () => profiles,
    getAutoConnectProfile: () => profiles.find((p) => p.autoConnect),
  } as unknown as ProfileManager;
  [startup, cancel, forgetHost] = createAutoLogin(
    api as never,
    manager,
    owner,
    page as never,
    ensureProfileExists as never,
    () => profiles,
  );
});

afterEach(() => {
  vi.useRealTimers();
  owner.dispose();
});

describe("startup: skip flag", () => {
  it("consumes the flag and does not auto-login", async () => {
    sessionStorage.setItem(SKIP, "1");
    startup();
    loadGate.resolve();
    await flush();
    expect(sessionStorage.getItem(SKIP)).toBeNull();
    expect(hoisted.loadCredential).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("consumes the flag on a quick switch too, and the switch still resumes", async () => {
    sessionStorage.setItem(SKIP, "1");
    sessionStorage.setItem(SWITCH, "beta.example");
    hoisted.loadCredential.mockResolvedValue({ username: "bob", token: "btok" });
    startup();
    loadGate.resolve();
    await flush();
    expect(sessionStorage.getItem(SKIP)).toBeNull();
    expect(sessionStorage.getItem(SWITCH)).toBeNull();
    expect(page.selectServer).toHaveBeenCalledWith("beta.example", "bob", false, true);
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession.mock.calls[0]?.[0]).toBe("beta.example");
  });

  it("a quick switch does not fall through to the auto-connect profile", async () => {
    sessionStorage.setItem(SWITCH, "beta.example");
    hoisted.loadCredential.mockResolvedValue({ username: "bob", token: "btok" });
    startup();
    loadGate.resolve();
    await flush();
    expect(hoisted.loadCredential).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession.mock.calls[0]?.[0]).toBe("beta.example");
  });

  it("leaves the flag when the page is torn down during the profile load", async () => {
    sessionStorage.setItem(SKIP, "1");
    startup();
    owner.dispose();
    loadGate.resolve();
    await flush();
    expect(sessionStorage.getItem(SKIP)).toBe("1");
    expect(page.refreshProfiles).not.toHaveBeenCalled();
    expect(hoisted.runHealthChecks).not.toHaveBeenCalled();
  });

  it("leaves the flag when the profile load fails after the page was torn down", async () => {
    sessionStorage.setItem(SKIP, "1");
    startup();
    owner.dispose();
    loadGate.reject(new Error("disk"));
    await flush();
    expect(sessionStorage.getItem(SKIP)).toBe("1");
    expect(hoisted.warn).not.toHaveBeenCalled();
  });

  it("falls back to the default list when the load fails on a live page", async () => {
    startup();
    loadGate.reject(new Error("disk"));
    await flush();
    expect(hoisted.warn).toHaveBeenCalledWith(
      "Failed to load profiles, using defaults",
      expect.any(Error),
    );
    expect(hoisted.runHealthChecks).toHaveBeenCalledWith(page, profiles, owner);
    // the load failed, but auto-login still proceeds
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
  });

  it("refreshes the list and runs the health checks after a good load", async () => {
    startup();
    loadGate.resolve();
    await flush();
    expect(page.refreshProfiles).toHaveBeenCalledWith(profiles);
    expect(hoisted.runHealthChecks).toHaveBeenCalledWith(page, profiles, owner);
  });
});

describe("startup: a manual login started while the profiles load", () => {
  it("is not replaced by the auto-login profile resume", async () => {
    startup();
    api.endSession(); // the manual login supersedes the startup attempt
    loadGate.resolve();
    await flush();
    expect(hoisted.loadCredential).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("is not replaced by a quick-switch resume either, but the form is still prefilled", async () => {
    sessionStorage.setItem(SWITCH, "beta.example");
    startup();
    api.endSession();
    loadGate.resolve();
    await flush();
    expect(page.selectServer).toHaveBeenCalledTimes(1);
    expect(hoisted.loadCredential).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("captures the attempt before the first await", async () => {
    startup();
    // Ending the session after startup() returns, before any microtask runs,
    // must already count as superseding.
    api.endSession();
    loadGate.resolve();
    await flush();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("resumes the auto-connect profile when nothing intervenes", async () => {
    startup();
    loadGate.resolve();
    await flush();
    expect(page.selectServer).toHaveBeenCalledWith("alpha.example", "ann", true, true);
    expect(page.showAutoConnecting).toHaveBeenCalledWith("Alpha");
    expect(api.setConfig).toHaveBeenCalledWith({ host: "alpha.example" });
    expect(ensureProfileExists).toHaveBeenCalledWith("alpha.example", "ann", true, true);
    expect(hoisted.startSession).toHaveBeenCalledWith(
      "alpha.example",
      "tok",
      "ann",
      undefined,
      true,
      false,
      expect.any(Function),
      true,
    );
  });

  it("does nothing when no profile is set to auto-connect", async () => {
    profiles = [beta];
    startup();
    loadGate.resolve();
    await flush();
    expect(hoisted.loadCredential).not.toHaveBeenCalled();
  });
});

describe("resume guards", () => {
  it("does not read a credential for a profile that keeps neither sign-in flag", async () => {
    profiles = [{ ...alpha, autoConnect: false, rememberPassword: false }];
    sessionStorage.setItem(SWITCH, "alpha.example");
    startup();
    loadGate.resolve();
    await flush();
    expect(hoisted.loadCredential).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  async function startWithPendingCredential() {
    const cred = gate();
    hoisted.loadCredential.mockReturnValue(
      cred.promise.then(() => ({ username: "ann", token: "t" })),
    );
    startup();
    loadGate.resolve();
    await flush();
    return cred;
  }

  it("drops a credential that arrives after the page left", async () => {
    const cred = await startWithPendingCredential();
    owner.dispose();
    cred.resolve();
    await flush();
    expect(page.selectServer).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("drops a credential that arrives after a manual login superseded the attempt", async () => {
    const cred = await startWithPendingCredential();
    api.endSession();
    cred.resolve();
    await flush();
    expect(page.selectServer).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("does nothing for a host with no stored token", async () => {
    hoisted.loadCredential.mockResolvedValue(null);
    startup();
    loadGate.resolve();
    await flush();
    expect(page.selectServer).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("does nothing for a credential missing its token", async () => {
    hoisted.loadCredential.mockResolvedValue({ username: "ann" });
    startup();
    loadGate.resolve();
    await flush();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("does not sign in when Cancel arrived while the credential loaded", async () => {
    const cred = await startWithPendingCredential();
    cancel();
    cred.resolve();
    await flush();
    expect(page.selectServer).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("does not sign in when Cancel arrived while the server was being selected", async () => {
    page.selectServer.mockImplementation(() => cancel());
    startup();
    loadGate.resolve();
    await flush();
    expect(page.selectServer).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });
});

describe("resume failure", () => {
  it("shows the error and logs a warning when the credential read fails", async () => {
    hoisted.loadCredential.mockRejectedValue(new Error("keyring locked"));
    startup();
    loadGate.resolve();
    await flush();
    const message = "keyring locked";
    expect(hoisted.warn).toHaveBeenCalledWith("Auto-login failed", {
      host: "alpha.example",
      error: message,
    });
    expect(page.showError).toHaveBeenCalledWith(
      connectText("session.autoLoginFailedDetail", { message }),
    );
  });

  it("falls back to the generic text for a failure with no message", async () => {
    hoisted.loadCredential.mockRejectedValue(undefined);
    startup();
    loadGate.resolve();
    await flush();
    expect(page.showError).toHaveBeenCalledWith(
      connectText("session.autoLoginFailedDetail", {
        message: connectText("session.autoLoginFailed"),
      }),
    );
  });

  it("paints nothing over the login that superseded the attempt", async () => {
    const cred = gate();
    hoisted.loadCredential.mockReturnValue(cred.promise);
    startup();
    loadGate.resolve();
    await flush();
    api.endSession();
    cred.reject(new Error("late"));
    await flush();
    expect(page.showError).not.toHaveBeenCalled();
    expect(hoisted.warn).not.toHaveBeenCalled();
  });

  it("paints nothing after the page left", async () => {
    const cred = gate();
    hoisted.loadCredential.mockReturnValue(cred.promise);
    startup();
    loadGate.resolve();
    await flush();
    owner.dispose();
    cred.reject(new Error("late"));
    await flush();
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("paints nothing after Cancel", async () => {
    const cred = gate();
    hoisted.loadCredential.mockReturnValue(cred.promise);
    startup();
    loadGate.resolve();
    await flush();
    cancel();
    cred.reject(new Error("late"));
    await flush();
    expect(page.showError).not.toHaveBeenCalled();
  });
});

describe("server wait", () => {
  async function startWait(): Promise<void> {
    vi.useFakeTimers();
    startup();
    loadGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const onTimeout = hoisted.startSession.mock.calls[0]?.[6] as (() => void) | undefined;
    expect(onTimeout).toBeTypeOf("function");
    onTimeout?.();
  }

  it("shows the wait, probes at 5 s, doubles to a 30 s cap, then resumes once without waiting again", async () => {
    hoisted.checkHealth.mockResolvedValue(false);
    await startWait();
    expect(page.showServerWait).toHaveBeenCalledWith("Alpha", "alpha.example");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hoisted.checkHealth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(5);

    hoisted.checkHealth.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.hideServerWait).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession).toHaveBeenCalledTimes(2);
    // the resume the wait started does not wait again
    expect(hoisted.startSession.mock.calls[1]?.[6]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(6);
  });

  it("ends with its API session (a manual login)", async () => {
    hoisted.checkHealth.mockResolvedValue(false);
    await startWait();
    api.endSession();
    expect(page.hideServerWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hoisted.checkHealth).not.toHaveBeenCalled();
  });

  it("ends with the page", async () => {
    hoisted.checkHealth.mockResolvedValue(false);
    await startWait();
    owner.dispose();
    expect(page.hideServerWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hoisted.checkHealth).not.toHaveBeenCalled();
  });

  it("forgetHost ends the wait on that host only", async () => {
    hoisted.checkHealth.mockResolvedValue(false);
    await startWait();
    forgetHost("beta.example");
    expect(page.hideServerWait).not.toHaveBeenCalled();
    forgetHost("alpha.example");
    expect(page.hideServerWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hoisted.checkHealth).not.toHaveBeenCalled();
  });

  it("forgetHost with no wait running does nothing", () => {
    expect(() => forgetHost("alpha.example")).not.toThrow();
    expect(page.hideServerWait).not.toHaveBeenCalled();
  });

  it("does not resume on a probe answer that arrives after the wait ended", async () => {
    const probe = gate();
    hoisted.checkHealth.mockReturnValue(probe.promise.then(() => true));
    await startWait();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(1);
    forgetHost("alpha.example");
    probe.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
  });

  it("ends when the profile is deleted while the server is down", async () => {
    hoisted.checkHealth.mockResolvedValue(false);
    await startWait();
    profiles = [beta];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.hideServerWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hoisted.checkHealth).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
  });
});

describe("cancel", () => {
  it("suppresses a later resume on this page", async () => {
    startup();
    cancel();
    loadGate.resolve();
    await flush();
    expect(hoisted.loadCredential).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });
});
