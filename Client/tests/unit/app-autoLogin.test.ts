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
  resumeSavedSession: vi.fn(),
  startSession: vi.fn(),
  checkHealth: vi.fn(),
  runHealthChecks: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@lib/net/credentials", () => ({ resumeSavedSession: hoisted.resumeSavedSession }));
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

import { TransportError } from "@lib/api";
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
  | "resetToIdle"
  | "showError"
  | "showServerWait"
  | "hideServerWait";
let page: Record<PageMethod, ReturnType<typeof vi.fn>>;
let ensureProfileExists: ReturnType<typeof vi.fn>;
let startup: () => void;
let cancel: () => void;
let forgetHost: (host: string) => void;
let certAccepted: (host: string) => void;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  sessionStorage.clear();
  for (const m of Object.values(hoisted)) m.mockReset();
  hoisted.resumeSavedSession.mockResolvedValue({
    outcome: "resumed",
    username: "ann",
    token: "tok",
  });
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
    resetToIdle: vi.fn(),
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
  [startup, cancel, forgetHost, certAccepted] = createAutoLogin(
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
    expect(hoisted.resumeSavedSession).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("consumes the flag on a quick switch too, and the switch still resumes", async () => {
    sessionStorage.setItem(SKIP, "1");
    sessionStorage.setItem(SWITCH, "beta.example");
    hoisted.resumeSavedSession.mockResolvedValue({
      outcome: "resumed",
      username: "bob",
      token: "btok",
    });
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
    hoisted.resumeSavedSession.mockResolvedValue({
      outcome: "resumed",
      username: "bob",
      token: "btok",
    });
    startup();
    loadGate.resolve();
    await flush();
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
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
    expect(hoisted.resumeSavedSession).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("is not replaced by a quick-switch resume either, but the form is still prefilled", async () => {
    sessionStorage.setItem(SWITCH, "beta.example");
    startup();
    api.endSession();
    loadGate.resolve();
    await flush();
    expect(page.selectServer).toHaveBeenCalledTimes(1);
    expect(hoisted.resumeSavedSession).not.toHaveBeenCalled();
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
    expect(hoisted.resumeSavedSession).not.toHaveBeenCalled();
  });
});

describe("resume guards", () => {
  it("does not read a credential for a profile that keeps neither sign-in flag", async () => {
    profiles = [{ ...alpha, autoConnect: false, rememberPassword: false }];
    sessionStorage.setItem(SWITCH, "alpha.example");
    startup();
    loadGate.resolve();
    await flush();
    expect(hoisted.resumeSavedSession).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  async function startWithPendingCredential() {
    const cred = gate();
    hoisted.resumeSavedSession.mockReturnValue(
      cred.promise.then(() => ({ outcome: "resumed", username: "ann", token: "t" })),
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
    hoisted.resumeSavedSession.mockResolvedValue(null);
    startup();
    loadGate.resolve();
    await flush();
    expect(page.selectServer).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("does nothing for a credential missing its token", async () => {
    hoisted.resumeSavedSession.mockResolvedValue({
      outcome: "resumed",
      username: "ann",
      token: "",
    });
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
    hoisted.resumeSavedSession.mockRejectedValue(new Error("keyring locked"));
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
    hoisted.resumeSavedSession.mockRejectedValue(undefined);
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
    hoisted.resumeSavedSession.mockReturnValue(cred.promise);
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
    hoisted.resumeSavedSession.mockReturnValue(cred.promise);
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
    hoisted.resumeSavedSession.mockReturnValue(cred.promise);
    startup();
    loadGate.resolve();
    await flush();
    cancel();
    cred.reject(new Error("late"));
    await flush();
    expect(page.showError).not.toHaveBeenCalled();
  });
});

describe("a saved server not signed in to yet during this app run", () => {
  // The backend asks that server before it hands the token over, so a resume
  // has more answers than a stored token: the server refused it, its
  // certificate has to be confirmed first, it could not be asked, or another
  // session is still active.
  function switchToBeta(): void {
    sessionStorage.setItem(SWITCH, "beta.example");
    startup();
    loadGate.resolve();
  }

  it("signs in once the server accepted the saved sign-in", async () => {
    hoisted.resumeSavedSession.mockResolvedValue({
      outcome: "resumed",
      username: "bob",
      token: "btok",
    });
    switchToBeta();
    await flush();
    expect(hoisted.resumeSavedSession).toHaveBeenCalledWith("beta.example");
    expect(page.showAutoConnecting).toHaveBeenCalledWith("Beta");
    expect(hoisted.startSession.mock.calls[0]?.slice(0, 3)).toEqual([
      "beta.example",
      "btok",
      "bob",
    ]);
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("leaves the sign-in form up, and says why, when the server refuses the saved sign-in", async () => {
    hoisted.resumeSavedSession.mockResolvedValue({ outcome: "sign_in_needed" });
    switchToBeta();
    await flush();
    // The switch target is still selected and prefilled; nothing signs in.
    expect(page.selectServer).toHaveBeenCalledTimes(1);
    expect(page.selectServer).toHaveBeenCalledWith("beta.example", "bob", false, true);
    expect(page.showAutoConnecting).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).toHaveBeenCalledTimes(1);
    expect(page.showError).toHaveBeenCalledWith(connectText("error.unauthorized"));
    expect(page.showServerWait).not.toHaveBeenCalled();
  });

  it("asks once more when the backend still holds the server it is leaving", async () => {
    vi.useFakeTimers();
    hoisted.resumeSavedSession
      .mockResolvedValueOnce({ outcome: "refused" })
      .mockResolvedValueOnce({ outcome: "resumed", username: "bob", token: "btok" });
    switchToBeta();
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
    expect(page.showError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(2);
    expect(hoisted.startSession.mock.calls[0]?.slice(0, 3)).toEqual([
      "beta.example",
      "btok",
      "bob",
    ]);
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("says the sign-in failed, in the app's own words, when the backend refuses twice", async () => {
    vi.useFakeTimers();
    hoisted.resumeSavedSession.mockResolvedValue({ outcome: "refused" });
    switchToBeta();
    await vi.advanceTimersByTimeAsync(300);
    expect(page.selectServer).toHaveBeenCalledWith("beta.example", "bob", false, true);
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).toHaveBeenCalledTimes(1);
    expect(page.showError).toHaveBeenCalledWith(connectText("session.autoLoginFailed"));
    expect(hoisted.warn).toHaveBeenCalledWith(
      "Saved sign-in not resumed: another session is active",
      { host: "beta.example" },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(2);
  });

  it("does not ask again once another sign-in took over", async () => {
    vi.useFakeTimers();
    hoisted.resumeSavedSession.mockResolvedValue({ outcome: "refused" });
    switchToBeta();
    await vi.advanceTimersByTimeAsync(0);
    api.endSession();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
    expect(page.showError).not.toHaveBeenCalled();
  });

  describe("a certificate that has to be confirmed first", () => {
    async function heldUp(): Promise<void> {
      hoisted.resumeSavedSession.mockResolvedValueOnce({ outcome: "certificate_unverified" });
      switchToBeta();
      await flush();
    }

    it("names the certificate and does not wait for an offline server", async () => {
      await heldUp();
      expect(hoisted.startSession).not.toHaveBeenCalled();
      expect(page.showError).toHaveBeenCalledTimes(1);
      expect(page.showError).toHaveBeenCalledWith(connectText("error.tlsFailed"));
      expect(page.showServerWait).not.toHaveBeenCalled();
    });

    it("carries on once that server's certificate is accepted", async () => {
      await heldUp();
      hoisted.resumeSavedSession.mockResolvedValue({
        outcome: "resumed",
        username: "bob",
        token: "btok",
      });
      certAccepted("other.example");
      await flush();
      expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
      certAccepted("beta.example");
      await flush();
      expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(2);
      expect(hoisted.startSession.mock.calls[0]?.slice(0, 3)).toEqual([
        "beta.example",
        "btok",
        "bob",
      ]);
      // Once: a second accept for the same server starts nothing.
      certAccepted("beta.example");
      await flush();
      expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(2);
    });

    it("stays put when another sign-in took over before the accept", async () => {
      await heldUp();
      api.endSession();
      certAccepted("beta.example");
      await flush();
      expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
      expect(hoisted.startSession).not.toHaveBeenCalled();
    });

    it("stays put after Cancel", async () => {
      await heldUp();
      cancel();
      certAccepted("beta.example");
      await flush();
      expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("progress while the server is asked", () => {
    type Answer = { outcome: string; username?: string; token?: string } | null;
    async function pendingFor(ms: number): Promise<Deferred<Answer>> {
      vi.useFakeTimers();
      const answer = gate<Answer>();
      hoisted.resumeSavedSession.mockReturnValue(answer.promise);
      switchToBeta();
      await vi.advanceTimersByTimeAsync(ms);
      return answer;
    }

    it("shows nothing for an answer that comes at once", async () => {
      const answer = await pendingFor(399);
      expect(page.showAutoConnecting).not.toHaveBeenCalled();
      answer.resolve({ outcome: "sign_in_needed" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(page.showAutoConnecting).not.toHaveBeenCalled();
      expect(page.resetToIdle).not.toHaveBeenCalled();
    });

    it("shows it is busy after a moment and keeps that up into the sign-in", async () => {
      const answer = await pendingFor(400);
      expect(page.showAutoConnecting).toHaveBeenCalledTimes(1);
      expect(page.showAutoConnecting).toHaveBeenCalledWith("Beta");
      answer.resolve({ outcome: "resumed", username: "bob", token: "btok" });
      await vi.advanceTimersByTimeAsync(0);
      expect(page.resetToIdle).not.toHaveBeenCalled();
      expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    });

    it("takes the progress down before it says the saved sign-in was refused", async () => {
      const answer = await pendingFor(400);
      answer.resolve({ outcome: "sign_in_needed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(page.resetToIdle).toHaveBeenCalledTimes(1);
      expect(page.showError).toHaveBeenCalledWith(connectText("error.unauthorized"));
      expect(page.resetToIdle.mock.invocationCallOrder[0]).toBeLessThan(
        page.showError.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("takes the progress down when nothing usable is stored", async () => {
      const answer = await pendingFor(400);
      answer.resolve({ outcome: "resumed", username: "bob", token: "" });
      await vi.advanceTimersByTimeAsync(0);
      expect(page.resetToIdle).toHaveBeenCalledTimes(1);
      expect(hoisted.startSession).not.toHaveBeenCalled();
      expect(page.showError).not.toHaveBeenCalled();
    });

    it("leaves the form alone when Cancel ended the attempt meanwhile", async () => {
      const answer = await pendingFor(400);
      cancel();
      api.endSession();
      answer.resolve({ outcome: "sign_in_needed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(page.resetToIdle).not.toHaveBeenCalled();
      expect(page.showError).not.toHaveBeenCalled();
    });

    it("does not come up after another sign-in took over", async () => {
      await pendingFor(100);
      api.endSession();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(page.showAutoConnecting).not.toHaveBeenCalled();
    });
  });

  it("says the server cannot be reached and waits for it when the check cannot run", async () => {
    vi.useFakeTimers();
    hoisted.resumeSavedSession.mockRejectedValueOnce(
      new TransportError("saved sign-in check: connect failed: refused"),
    );
    hoisted.checkHealth.mockResolvedValue(false);
    switchToBeta();
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).toHaveBeenCalledTimes(1);
    expect(page.showError).toHaveBeenCalledWith(connectText("session.connectTimeout"));
    expect(page.showServerWait).toHaveBeenCalledWith("Beta", "beta.example");
    expect(hoisted.warn).toHaveBeenCalledWith("Saved sign-in could not be checked", {
      host: "beta.example",
      error: "saved sign-in check: connect failed: refused",
    });

    // The server comes back: the wait resumes once, with the token the
    // backend now hands over.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
    hoisted.checkHealth.mockResolvedValue(true);
    hoisted.resumeSavedSession.mockResolvedValue({
      outcome: "resumed",
      username: "bob",
      token: "btok",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.hideServerWait).toHaveBeenCalledTimes(1);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(2);
    expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession.mock.calls[0]?.[1]).toBe("btok");
    // the resume the wait started does not wait again
    expect(hoisted.startSession.mock.calls[0]?.[6]).toBeUndefined();
  });

  it("does not wait a second time when the check fails again after the wait", async () => {
    vi.useFakeTimers();
    hoisted.resumeSavedSession.mockRejectedValue(
      new TransportError("saved sign-in check timed out"),
    );
    switchToBeta();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.showServerWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(2);
    expect(page.showError).toHaveBeenCalledTimes(2);
    expect(page.showServerWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(2);
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after another sign-in took over", async () => {
    const answer = gate<{ outcome: "resumed"; username: string; token: string }>();
    hoisted.resumeSavedSession.mockReturnValue(answer.promise);
    switchToBeta();
    await flush();
    api.endSession(); // the user picked another server and signed in there
    page.selectServer.mockClear();
    answer.resolve({ outcome: "resumed", username: "bob", token: "btok" });
    await flush();
    expect(page.selectServer).not.toHaveBeenCalled();
    expect(page.showAutoConnecting).not.toHaveBeenCalled();
    expect(hoisted.startSession).not.toHaveBeenCalled();
    expect(page.showError).not.toHaveBeenCalled();
  });

  it("drops a failed check that arrives after another sign-in took over", async () => {
    const answer = gate();
    hoisted.resumeSavedSession.mockReturnValue(answer.promise);
    switchToBeta();
    await flush();
    api.endSession();
    answer.reject(new TransportError("saved sign-in check timed out"));
    await flush();
    expect(page.showError).not.toHaveBeenCalled();
    expect(page.showServerWait).not.toHaveBeenCalled();
    expect(hoisted.warn).not.toHaveBeenCalled();
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
    expect(hoisted.resumeSavedSession).toHaveBeenCalledTimes(1);
    expect(hoisted.startSession).not.toHaveBeenCalled();
  });
});
