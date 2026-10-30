/**
 * How src/main.ts wires the router (WP 7.4k), through the real modules: the
 * real router, session controller and certificate prompts, with only
 * ./app/connectRoute mocked (three recording slots) and the certificate modals
 * captured. main-connectRoute-wiring.test.ts pins the tuple slots with the
 * certificate prompts mocked; this file covers what that mocking hides:
 *  - a first-use certificate accept re-runs the connect page's health checks
 *    through the router's slot;
 *  - an owncord:// invite arriving while the main page is showing signs out
 *    for a server switch, and the connect page the logout navigates to takes
 *    the link once.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));
vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));
const { mockOnOpenUrl } = vi.hoisted(() => ({
  mockOnOpenUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  register: vi.fn().mockResolvedValue(undefined),
  getCurrent: vi.fn().mockResolvedValue(null),
  onOpenUrl: (...args: unknown[]) => mockOnOpenUrl(...args),
}));
vi.mock("@lib/prefs/appearance", () => ({ applyStoredAppearance: vi.fn() }));
vi.mock("@lib/net/connectionDiagnostics", () => ({ configureConnectionDiagnostics: vi.fn() }));
vi.mock("@lib/pendingMessages", () => ({ deactivatePendingMessages: vi.fn() }));
vi.mock("../../src/platform/desktop/pushToTalk", () => ({
  pushToTalk: { init: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@lib/logPersistence", () => ({
  initLogPersistence: vi.fn().mockResolvedValue(undefined),
  flushLogs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@lib/prefs/windowState", () => ({
  initWindowState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@lib/presence/profiles", () => ({
  createTauriBackend: vi.fn(() => ({})),
  createProfileManager: vi.fn(() => ({})),
}));
vi.mock("@pages/MainPage", () => ({
  createMainPage: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));
vi.mock("@pages/mainPagePrefetch", () => ({ prefetchMainPage: vi.fn() }));
vi.mock("@lib/dispatcher", () => ({ wireConnectionStatus: vi.fn(() => () => {}) }));

type PendingInvite = { code: string; host?: string } | null;

const hoisted = vi.hoisted(() => ({
  rerunHealth: vi.fn(),
  applyInvite: vi.fn(),
  renderConnect: vi.fn(),
  firstUseModals: [] as Array<{ onAccept: () => void }>,
}));

vi.mock("../../src/app/connectRoute", () => ({
  renderConnect: (...args: unknown[]) => {
    hoisted.renderConnect(...args);
    return [{ destroy: vi.fn() }, hoisted.rerunHealth, hoisted.applyInvite];
  },
}));
vi.mock("@components/CertMismatchModal", () => ({
  createCertFirstUseModal: (opts: { onAccept: () => void }) => {
    hoisted.firstUseModals.push(opts);
    return { mount: vi.fn(), destroy: vi.fn() };
  },
  createCertMismatchModal: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));

import { emitTauriEvent } from "./helpers/ws-mocks";
import { setAuth } from "@stores/auth.store";
import { createMainPage } from "@pages/MainPage";
import { expectConsole } from "../helpers/console";

const lastTakePendingInvite = (): (() => PendingInvite) =>
  hoisted.renderConnect.mock.lastCall![5] as () => PendingInvite;

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../../src/main");
  await vi.waitFor(() => expect(mockOnOpenUrl).toHaveBeenCalled());
});

describe("main.ts wiring of the router", () => {
  it("a first-use certificate accept re-runs the connect page's health checks through the router's slot", async () => {
    emitTauriEvent("cert-tofu", {
      host: "unpinned.example:8443",
      fingerprint: "sha256:NEW",
      status: "first_use",
    });
    expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
    await vi.waitFor(() => expect(hoisted.firstUseModals).toHaveLength(1));
    hoisted.rerunHealth.mockClear();

    hoisted.firstUseModals[0]!.onAccept();
    await vi.waitFor(() => expect(hoisted.rerunHealth).toHaveBeenCalledTimes(1));
  });

  it("an invite arriving on the main page signs out for a server switch, and the next connect mount takes it once", async () => {
    // Sign in and reach the main page the way the connected overlay does.
    setAuth("tok", { id: 1, username: "alex", avatar: null, role: "member" }, "Srv", "");
    const { navigate } = await import("../../src/app/router");
    navigate("main");
    await vi.waitFor(() => expect(createMainPage).toHaveBeenCalledTimes(1));
    const mountsBefore = hoisted.renderConnect.mock.calls.length;
    hoisted.applyInvite.mockClear();

    // An in-chat invite chip goes straight in; an outside link would ask first.
    const { requestInviteJoin } = await import("@lib/nav/inviteNavigation");
    requestInviteJoin("ABC123", "h.example");

    // clearAuth("server_switch") fires the logout subscriber, which navigates
    // to connect; that mount, not a direct hook call, consumes the link.
    await vi.waitFor(() => expect(hoisted.renderConnect.mock.calls.length).toBe(mountsBefore + 1));
    expect(hoisted.applyInvite).not.toHaveBeenCalled();
    const take = lastTakePendingInvite();
    expect(take()).toEqual({ code: "ABC123", host: "h.example" });
    expect(take()).toBeNull();
  });
});
