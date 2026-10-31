/**
 * How src/main.ts wires the tuple renderConnect() returns (WP 7.4h review).
 * connectRoute.test.ts drives the route itself; this file pins the three
 * slots main.ts takes from it, with ./app/connectRoute mocked to hand back
 * three distinct spies and ./app/certPrompts mocked to capture the callbacks
 * main.ts gives it:
 *  - the page handle becomes currentPage, so leaving the connect page destroys it;
 *  - the health-refresh slot is what the certificate prompts re-run;
 *  - the invite slot is what an owncord:// invite calls while connect is
 *    mounted, and the pending link is handed to the route once, then cleared.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../helpers/mainMocks";

vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("@tauri-apps/plugin-deep-link", () => mocks.deepLinkMock());
vi.mock("@lib/prefs/appearance", () => mocks.prefsAppearanceMock());
vi.mock("@lib/net/connectionDiagnostics", () => mocks.netConnectionDiagnosticsMock());
vi.mock("@lib/pendingMessages", () => mocks.pendingMessagesMock());
vi.mock("../../src/platform/desktop/pushToTalk", () => mocks.desktopPushToTalkMock());
vi.mock("@lib/logPersistence", () => mocks.logPersistenceMock());
vi.mock("@lib/prefs/windowState", () => mocks.prefsWindowStateMock());
// The deep-link listener and the startup connect mount happen once, before the
// per-test mock clear, so what they hand over is kept outside the mocks.
const { deepLink } = mocks;
vi.mock("@lib/presence/profiles", () => ({
  createTauriBackend: vi.fn(() => ({})),
  createProfileManager: vi.fn(() => ({})),
}));
vi.mock("@pages/MainPage", () => mocks.pagesMainPageMock());
vi.mock("@lib/dispatcher", () => ({ wireConnectionStatus: vi.fn(() => () => {}) }));

type PendingInvite = { code: string; host?: string } | null;

const hoisted = vi.hoisted(() => ({
  destroy: vi.fn(),
  rerunHealth: vi.fn(),
  applyInvite: vi.fn(),
  renderConnectCalls: [] as unknown[][],
  installCertPrompts: vi.fn(),
}));

vi.mock("../../src/app/connectRoute", () => ({
  renderConnect: (...args: unknown[]) => {
    hoisted.renderConnectCalls.push(args);
    return [{ destroy: hoisted.destroy }, hoisted.rerunHealth, hoisted.applyInvite];
  },
}));
vi.mock("../../src/app/certPrompts", () => ({
  installCertPrompts: (...args: unknown[]) => hoisted.installCertPrompts(...args),
}));

let getPage: () => string;
let navigate: (page: string) => void;
let rerunHealth: () => void;

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../../src/main");
  await Promise.resolve();
  await Promise.resolve();
  [, getPage, navigate, rerunHealth] = hoisted.installCertPrompts.mock.calls[0] as [
    unknown,
    () => string,
    (page: string) => void,
    () => void,
  ];
});

beforeEach(() => {
  hoisted.destroy.mockClear();
  hoisted.rerunHealth.mockClear();
  hoisted.applyInvite.mockClear();
});

/** The take-once accessor main.ts gave the most recent renderConnect call. */
const lastTakePendingInvite = (): (() => PendingInvite) =>
  hoisted.renderConnectCalls.at(-1)![5] as () => PendingInvite;

describe("main.ts wiring of the connect route", () => {
  it("mounts the connect page at startup", () => {
    expect(getPage()).toBe("connect");
    expect(hoisted.renderConnectCalls).toHaveLength(1);
  });

  it("gives the certificate prompts a health refresh that runs the route's second slot", () => {
    rerunHealth();
    expect(hoisted.rerunHealth).toHaveBeenCalledTimes(1);
  });

  it("applies an invite through the route's third slot and clears the pending link", async () => {
    // The native deep-link listener registers asynchronously.
    await vi.waitFor(() => expect(deepLink.handler).toBeTypeOf("function"));
    const deepLinkHandler = deepLink.handler!;
    deepLinkHandler(["owncord://invite/ABC123?host=h.example"]);
    expect(hoisted.applyInvite).toHaveBeenCalledTimes(1);
    expect(hoisted.applyInvite).toHaveBeenCalledWith("ABC123", "h.example");
    // Applied directly, so nothing is left for the next connect mount to take.
    expect(lastTakePendingInvite()()).toBeNull();
  });

  it("destroys the route's handle when the page changes, and stops re-running its health refresh", async () => {
    navigate("main");
    expect(hoisted.destroy).toHaveBeenCalledTimes(1);
    // The refresh and invite hooks are only valid while connect is mounted.
    rerunHealth();
    expect(hoisted.rerunHealth).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getPage()).toBe("main"));
  });
});
