/**
 * Tests for src/app/connectRoute.ts (WP 7.4h): the connect route moved out of
 * main.ts. renderConnect() gets a fake API, an in-memory profile manager and a
 * stand-in connect page whose callbacks are captured, so each callback is
 * driven directly. The collaborators the route wires together (auto-login,
 * profiles, health checks, session start) are stand-ins that record calls.
 *
 * The two edge cases the move must keep: a rejected TOTP code keeps the
 * partial token for the retry while a success clears it; and an epoch refusal
 * on an already mounted connect page still offers the update, but only when
 * the server is newer than the client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@lib/api";
import type { ProfileManager } from "@lib/presence/profiles";
import type { RenderRecovery } from "@lib/text/safeRender";

const hoisted = vi.hoisted(() => ({
  callbacks: null as Record<string, (...args: never[]) => unknown> | null,
  page: {} as Record<string, ReturnType<typeof vi.fn>>,
  notifiers: [] as Array<{ mount: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
  startSession: vi.fn(),
  runHealthChecks: vi.fn(),
  ensureProfileExists: vi.fn(),
  persistProfiles: vi.fn(),
  startAutoLogin: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: hoisted.logError,
  }),
}));
vi.mock("@lib/text/safeRender", () => ({ safeMount: vi.fn() }));
vi.mock("@lib/net/credentials", () => ({
  deleteCredential: vi.fn(),
  loginWithSavedPassword: vi.fn(),
  parseRelayedLogin: vi.fn(),
}));
vi.mock("@lib/pendingMessages", () => ({ deactivatePendingMessages: vi.fn() }));
vi.mock("@pages/ConnectPage", () => ({
  createConnectPage: (callbacks: Record<string, (...args: never[]) => unknown>) => {
    hoisted.callbacks = callbacks;
    return hoisted.page;
  },
}));
vi.mock("@components/UpdateNotifier", () => ({
  createUpdateNotifier: () => {
    const entry = { mount: vi.fn(), destroy: vi.fn() };
    hoisted.notifiers.push(entry);
    return entry;
  },
}));
vi.mock("../../src/app/autoLogin", () => ({
  createAutoLogin: () => [hoisted.startAutoLogin, vi.fn(), vi.fn()],
}));
vi.mock("../../src/app/connectProfiles", () => ({
  createConnectProfiles: () => [
    () => [{ id: "listed" }],
    hoisted.persistProfiles,
    vi.fn(),
    hoisted.ensureProfileExists,
  ],
}));
vi.mock("../../src/app/serverHealth", () => ({
  probeServerInfo: vi.fn(),
  runHealthChecks: hoisted.runHealthChecks,
  serverInfoFor: vi.fn(),
  serverInfoProbing: vi.fn(),
}));
vi.mock("../../src/app/session", () => ({
  abandonInFlight: vi.fn(),
  startSession: hoisted.startSession,
}));

import { setUpdateRequiredHost, uiStore } from "@stores/ui.store";
import { renderConnect } from "../../src/app/connectRoute";

const PAGE_METHODS = [
  "showTotp",
  "showNotice",
  "showIncompatible",
  "refreshProfiles",
  "applyInviteLink",
  "getRememberPassword",
  "getAutoConnect",
  "getPassword",
  "destroy",
];

const api = {
  endSession: vi.fn(),
  setConfig: vi.fn(),
  getSession: vi.fn(),
  login: vi.fn(),
  verifyTotp: vi.fn(),
};
const profileManager = { addProfile: vi.fn() };
const appEl = document.createElement("div");
const recovery = {} as RenderRecovery;

type Callback = (...args: unknown[]) => unknown;
function cb(name: string): Callback {
  const fn = hoisted.callbacks?.[name];
  if (!fn) throw new Error(`no ${name} callback`);
  return fn as Callback;
}

// Every mounted route is destroyed after its test: its health interval and its
// ui-store subscription would otherwise outlive it and answer the next test.
// The ui store notifies its subscribers on a microtask.
const flushStore = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const mounted: Array<{ destroy(): void }> = [];

function mount(takePendingInvite: () => { code: string; host?: string } | null = () => null) {
  const route = renderConnect(
    api as unknown as ApiClient,
    profileManager as unknown as ProfileManager,
    appEl,
    recovery,
    vi.fn(),
    takePendingInvite,
  );
  mounted.push(route[0]);
  return route;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.notifiers.length = 0;
  hoisted.callbacks = null;
  for (const name of PAGE_METHODS) hoisted.page[name] = vi.fn();
  hoisted.page["getRememberPassword"]!.mockReturnValue(false);
  hoisted.page["getAutoConnect"]!.mockReturnValue(false);
  api.getSession.mockReturnValue({ assertCurrent: vi.fn() });
  setUpdateRequiredHost(null);
});

afterEach(() => {
  for (const page of mounted.splice(0)) page.destroy();
  vi.useRealTimers();
  setUpdateRequiredHost(null);
});

describe("renderConnect", () => {
  it("onAddProfile adds, persists, refreshes and re-checks health for the new profile", () => {
    mount();
    cb("onAddProfile")("Home", "home.example");
    expect(profileManager.addProfile).toHaveBeenCalledWith({
      name: "Home",
      host: "home.example",
      username: "",
      autoConnect: false,
      rememberPassword: false,
      color: "#5865F2",
    });
    expect(hoisted.persistProfiles).toHaveBeenCalledTimes(1);
    expect(hoisted.page["refreshProfiles"]).toHaveBeenCalledWith([{ id: "listed" }]);
    expect(hoisted.runHealthChecks).toHaveBeenCalledWith(
      hoisted.page,
      [{ id: "listed" }],
      expect.anything(),
    );
  });

  describe("TOTP", () => {
    async function challenge(): Promise<void> {
      api.login.mockResolvedValue({ requires_2fa: true, partial_token: "partial-1" });
      await cb("onLogin")("host.example", "ann", "pw");
    }

    it("a success clears the partial token, so a later submit logs an error and does not verify", async () => {
      mount();
      await challenge();
      api.verifyTotp.mockResolvedValue({ token: "session-token" });
      await cb("onTotpSubmit")("123456");
      expect(api.verifyTotp).toHaveBeenCalledWith("123456", "partial-1");
      expect(hoisted.startSession).toHaveBeenCalledTimes(1);

      await cb("onTotpSubmit")("654321");
      expect(api.verifyTotp).toHaveBeenCalledTimes(1);
      expect(hoisted.logError).toHaveBeenCalledWith("TOTP submit without pending partial token");
      expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    });

    it("a submit with no pending challenge logs an error and does not verify", async () => {
      mount();
      await cb("onTotpSubmit")("123456");
      expect(hoisted.logError).toHaveBeenCalledWith("TOTP submit without pending partial token");
      expect(api.verifyTotp).not.toHaveBeenCalled();
    });

    it("a rejected code keeps the partial token for the retry", async () => {
      mount();
      await challenge();
      api.verifyTotp.mockRejectedValueOnce(new Error("bad code"));
      await expect(cb("onTotpSubmit")("000000")).rejects.toThrow("bad code");
      api.verifyTotp.mockResolvedValueOnce({ token: "session-token" });
      await cb("onTotpSubmit")("123456");
      expect(api.verifyTotp).toHaveBeenLastCalledWith("123456", "partial-1");
      expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    });

    it("a code verified after the page was left starts no session", async () => {
      const [page] = mount();
      await challenge();
      let resolveVerify: (value: { token: string }) => void = () => {};
      api.verifyTotp.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveVerify = resolve;
        }),
      );
      const submitted = cb("onTotpSubmit")("123456");
      page.destroy();
      resolveVerify({ token: "session-token" });
      await expect(submitted).rejects.toThrow();
      expect(hoisted.startSession).not.toHaveBeenCalled();
    });

    it("a response without a token starts no session and keeps the challenge", async () => {
      mount();
      await challenge();
      api.verifyTotp.mockResolvedValueOnce({});
      await cb("onTotpSubmit")("111111");
      expect(hoisted.startSession).not.toHaveBeenCalled();
      api.verifyTotp.mockResolvedValueOnce({ token: "t" });
      await cb("onTotpSubmit")("222222");
      expect(hoisted.startSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("health interval", () => {
    it("re-checks every 15 s and stops once the route is destroyed", () => {
      vi.useFakeTimers();
      const [page] = mount();
      vi.advanceTimersByTime(15_000);
      expect(hoisted.runHealthChecks).toHaveBeenCalledTimes(1);
      page.destroy();
      vi.advanceTimersByTime(60_000);
      expect(hoisted.runHealthChecks).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(hoisted.page["destroy"]).toHaveBeenCalledTimes(1);
    });

    it("rerunHealth checks the listed profiles on demand", () => {
      const [, rerunHealth] = mount();
      rerunHealth();
      expect(hoisted.runHealthChecks).toHaveBeenCalledWith(
        hoisted.page,
        [{ id: "listed" }],
        expect.anything(),
      );
    });
  });

  describe("invite", () => {
    it("applies a link taken from before the mount, once, before auto-login starts", () => {
      const take = vi
        .fn<() => { code: string; host?: string } | null>()
        .mockReturnValueOnce({ code: "abc", host: "h.example" })
        .mockReturnValue(null);
      mount(take);
      expect(take).toHaveBeenCalledTimes(1);
      expect(hoisted.page["applyInviteLink"]).toHaveBeenCalledWith("abc", "h.example");
      expect(hoisted.startAutoLogin).toHaveBeenCalledTimes(1);
      expect(hoisted.page["applyInviteLink"]!.mock.invocationCallOrder[0]).toBeLessThan(
        hoisted.startAutoLogin.mock.invocationCallOrder[0]!,
      );
    });

    it("applies nothing when no link is pending, and applyInvite reaches the page", () => {
      const [, , applyInvite] = mount();
      expect(hoisted.page["applyInviteLink"]).not.toHaveBeenCalled();
      applyInvite("xyz", undefined);
      expect(hoisted.page["applyInviteLink"]).toHaveBeenCalledWith("xyz", undefined);
    });
  });

  describe("update required", () => {
    it("offers the update for a newer server, also when the refusal arrives after mount", async () => {
      mount();
      expect(hoisted.notifiers).toHaveLength(0);
      setUpdateRequiredHost({ host: "s.example", serverEpoch: 5, clientEpoch: 3 });
      await flushStore();
      expect(hoisted.page["showIncompatible"]).toHaveBeenCalledWith("s.example", 5, 3);
      expect(hoisted.notifiers).toHaveLength(1);
      expect(uiStore.getState().updateRequiredHost).toBeNull();
    });

    it("destroys the update notifier along with the route", async () => {
      const [page] = mount();
      setUpdateRequiredHost({ host: "s.example", serverEpoch: 5, clientEpoch: 3 });
      await flushStore();
      expect(hoisted.notifiers).toHaveLength(1);
      expect(hoisted.notifiers[0]!.destroy).not.toHaveBeenCalled();
      page.destroy();
      expect(hoisted.notifiers[0]!.destroy).toHaveBeenCalledTimes(1);
    });

    it("offers a refusal that was recorded before mount", () => {
      setUpdateRequiredHost({ host: "s.example", serverEpoch: 5, clientEpoch: 3 });
      mount();
      expect(hoisted.notifiers).toHaveLength(1);
      expect(uiStore.getState().updateRequiredHost).toBeNull();
    });

    it("states the refusal without an update offer for an older server", async () => {
      mount();
      setUpdateRequiredHost({ host: "s.example", serverEpoch: 2, clientEpoch: 3 });
      await flushStore();
      expect(hoisted.page["showIncompatible"]).toHaveBeenCalledWith("s.example", 2, 3);
      expect(hoisted.notifiers).toHaveLength(0);
    });
  });
});
