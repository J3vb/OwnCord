/**
 * Tests for src/app/router.ts (WP 7.4k). The router is driven directly:
 * configureRouter() gets stand-ins for the services, ./connectRoute is mocked
 * to hand back three recording slots and to write a marker into #app, and
 * @pages/MainPage is mocked behind a gate the test releases, so the slow chunk
 * load is observable.
 *
 * Edge cases pinned here:
 *  - E1: a navigation generation supersedes a slow MainPage load. The stale
 *    mount, and the stale fallback, are dropped.
 *  - E2: an invite link and the connect page's invite hook. A link is applied
 *    straight to a mounted connect page, left pending when none is mounted,
 *    and handed to the next connect mount exactly once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loggerMock } from "../helpers/loggerMock";
import type { ApiClient } from "@lib/api";
import type { ProfileManager } from "@lib/presence/profiles";
import type { WsClient } from "@lib/ws";
import { connectText } from "../../src/i18n/connect";

type PendingInvite = { code: string; host?: string } | null;
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

const hoisted = vi.hoisted(() => {
  const makeGate = (): Deferred => {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  return {
    makeGate,
    gate: makeGate(),
    connectDestroy: vi.fn(),
    rerunHealth: vi.fn(),
    applyInvite: vi.fn(),
    renderConnect: vi.fn(),
    connectThrows: false,
    mainDestroy: vi.fn(),
    createMainPage: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@lib/logger", () => loggerMock({ error: hoisted.logError }));
vi.mock("../../src/app/serverHealth", () => ({ serverInfoFor: vi.fn(() => undefined) }));
vi.mock("../../src/app/connectRoute", () => ({
  renderConnect: (...args: unknown[]) => {
    hoisted.renderConnect(...args);
    if (hoisted.connectThrows) throw new Error("connect render failed");
    (args[2] as HTMLElement).append(Object.assign(document.createElement("p"), { id: "connect" }));
    return [{ destroy: hoisted.connectDestroy }, hoisted.rerunHealth, hoisted.applyInvite];
  },
}));
// Registered per test (vi.doMock): a mock factory's result is cached, and the
// gate is new each time. The factory waits on the gate: releasing it resolves
// the dynamic import, rejecting it fails the chunk load.
function mockMainPage(): void {
  vi.doMock("@pages/MainPage", async () => {
    await hoisted.gate.promise;
    return {
      createMainPage: (...args: unknown[]) => {
        hoisted.createMainPage(...args);
        return {
          mount: (el: HTMLElement) =>
            el.append(Object.assign(document.createElement("p"), { id: "main" })),
          destroy: hoisted.mainDestroy,
        };
      },
    };
  });
}

type Router = typeof import("../../src/app/router");
let router: Router;
// Imported after each vi.resetModules(), so it is the instance router.ts sees.
let setAuth: typeof import("@stores/auth.store").setAuth;
let appEl: HTMLElement;
const unauthorized = vi.fn();

/** Lets a released gate's dynamic import and the code after it run. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const FALLBACK_TEXT = connectText("app.renderFailed");
const lastTakePendingInvite = (): (() => PendingInvite) =>
  hoisted.renderConnect.mock.lastCall![5] as () => PendingInvite;

beforeEach(async () => {
  vi.clearAllMocks();
  // A fresh module per test: the page, the slots and the generation are module state.
  vi.resetModules();
  hoisted.gate = hoisted.makeGate();
  mockMainPage();
  hoisted.connectThrows = false;
  document.body.innerHTML = '<div id="app"></div>';
  appEl = document.getElementById("app")!;
  ({ setAuth } = await import("@stores/auth.store"));
  router = await import("../../src/app/router");
  router.configureRouter(
    {} as ApiClient,
    {} as WsClient,
    appEl,
    {} as ProfileManager,
    unauthorized,
  );
});

describe("the page id", () => {
  it("starts on connect, and navigating to the same page does not re-render", async () => {
    expect(router.activePageId()).toBe("connect");
    await router.renderActive();
    expect(hoisted.renderConnect).toHaveBeenCalledTimes(1);
    router.navigate("connect");
    expect(hoisted.renderConnect).toHaveBeenCalledTimes(1);
  });

  it("hands the connect route the services, the recovery and the 401 handler", async () => {
    await router.renderActive();
    const args = hoisted.renderConnect.mock.lastCall!;
    expect(args[2]).toBe(appEl);
    expect(args[3]).toBe(router.renderRecovery);
    expect(args[4]).toBe(unauthorized);
    expect(args).toHaveLength(6);
  });
});

describe("E1: a navigation generation supersedes a slow MainPage load", () => {
  it("drops the stale mount when a newer navigation rendered a page meanwhile", async () => {
    await router.renderActive();
    router.navigate("main");
    router.navigate("connect");
    hoisted.gate.resolve();
    await settle();

    expect(hoisted.createMainPage).not.toHaveBeenCalled();
    expect(appEl.querySelector("#main")).toBeNull();
    expect(appEl.querySelector("#connect")).not.toBeNull();
    expect(router.activePageId()).toBe("connect");
  });

  it("drops the stale failure fallback too, and leaves the newer page showing", async () => {
    await router.renderActive();
    router.navigate("main");
    router.navigate("connect");
    hoisted.gate.reject(new Error("chunk 404"));
    await settle();

    // The failure is still logged; it just must not overwrite the newer page.
    expect(hoisted.logError).toHaveBeenCalledWith("Main page failed to load", expect.any(Error));
    expect(appEl.textContent).not.toContain(FALLBACK_TEXT);
    expect(appEl.querySelector("#connect")).not.toBeNull();
  });

  it("mounts the page when nothing superseded it", async () => {
    await router.renderActive();
    router.navigate("main");
    hoisted.gate.resolve();
    await settle();

    expect(hoisted.createMainPage).toHaveBeenCalledTimes(1);
    expect(appEl.querySelector("#main")).not.toBeNull();
  });

  it("shows the fallback when the load fails and nothing superseded it", async () => {
    await router.renderActive();
    router.navigate("main");
    hoisted.gate.reject(new Error("chunk 404"));
    await settle();

    expect(appEl.textContent).toContain(FALLBACK_TEXT);
    expect(appEl.querySelector("#connect")).toBeNull();
  });

  it("destroys the previous page and clears the window before the chunk arrives", async () => {
    await router.renderActive();
    router.navigate("main");

    // The gate is still closed: the slow load has not finished.
    expect(hoisted.connectDestroy).toHaveBeenCalledTimes(1);
    expect(appEl.querySelector("#connect")).toBeNull();
    expect(hoisted.createMainPage).not.toHaveBeenCalled();
    hoisted.gate.resolve();
    await settle();
  });

  it("destroys the mounted main page when a later navigation leaves it", async () => {
    await router.renderActive();
    router.navigate("main");
    hoisted.gate.resolve();
    await settle();
    router.navigate("connect");

    expect(hoisted.mainDestroy).toHaveBeenCalledTimes(1);
    expect(appEl.querySelector("#main")).toBeNull();
  });
});

describe("E2: the invite link and the connect page's hook", () => {
  it("applies a pending invite straight to a mounted connect page and clears it", async () => {
    await router.renderActive();
    router.queuePendingInvite({ code: "ABC", host: "h.example" });

    expect(router.applyInviteNow("ABC", "h.example")).toBe(true);
    expect(hoisted.applyInvite).toHaveBeenCalledTimes(1);
    expect(hoisted.applyInvite).toHaveBeenCalledWith("ABC", "h.example");
    // Applied directly, so nothing is left for the next connect mount.
    expect(lastTakePendingInvite()()).toBeNull();
  });

  it("does not apply when no invite is pending", async () => {
    await router.renderActive();
    expect(router.applyInviteNow("ABC")).toBe(false);
    expect(hoisted.applyInvite).not.toHaveBeenCalled();
  });

  it("leaves the invite pending when the connect page is not mounted, for the next mount to take once", async () => {
    await router.renderActive();
    router.navigate("main");
    hoisted.gate.resolve();
    await settle();
    router.queuePendingInvite({ code: "XYZ", host: "h.example" });

    // The hook belongs to the destroyed connect page: it must not be called.
    expect(router.applyInviteNow("XYZ", "h.example")).toBe(false);
    expect(hoisted.applyInvite).not.toHaveBeenCalled();

    router.navigate("connect");
    expect(hoisted.renderConnect).toHaveBeenCalledTimes(2);
    const take = lastTakePendingInvite();
    expect(take()).toEqual({ code: "XYZ", host: "h.example" });
    // Taken once: a later mount must not replay it.
    expect(take()).toBeNull();
  });

  it("tests the hook, not the page id: a connect render that threw leaves a pending link and no hook", async () => {
    hoisted.connectThrows = true;
    await expect(router.renderActive()).rejects.toThrow("connect render failed");
    expect(router.activePageId()).toBe("connect");
    router.queuePendingInvite({ code: "ABC" });

    expect(() => router.applyInviteNow("ABC")).not.toThrow();
    expect(router.applyInviteNow("ABC")).toBe(false);
    expect(hoisted.applyInvite).not.toHaveBeenCalled();
    expect(lastTakePendingInvite()()).toEqual({ code: "ABC" });
  });

  it("queuePendingInvite(null) clears a pending link", async () => {
    await router.renderActive();
    router.queuePendingInvite({ code: "ABC" });
    router.queuePendingInvite(null);
    expect(lastTakePendingInvite()()).toBeNull();
  });
});

describe("the connect page's health refresh", () => {
  it("runs the mounted page's slot, and nothing once the page is left", async () => {
    await router.renderActive();
    router.rerunHealth();
    expect(hoisted.rerunHealth).toHaveBeenCalledTimes(1);

    router.navigate("main");
    router.rerunHealth();
    expect(hoisted.rerunHealth).toHaveBeenCalledTimes(1);
    hoisted.gate.resolve();
    await settle();
  });
});

describe("render recovery sign out", () => {
  it("re-renders connect in place for a session that never authenticated", async () => {
    await router.renderActive();
    router.renderRecovery.signOut();
    expect(hoisted.renderConnect).toHaveBeenCalledTimes(2);
  });

  it("navigates to connect when the router is on main and nobody was signed in", async () => {
    await router.renderActive();
    router.navigate("main");
    hoisted.gate.resolve();
    await settle();
    router.renderRecovery.signOut();
    expect(router.activePageId()).toBe("connect");
    expect(hoisted.renderConnect).toHaveBeenCalledTimes(2);
  });
});

describe("render recovery sign out after a sign-in", () => {
  it("leaves the navigation to the logout subscriber: nothing renders or navigates here", async () => {
    await router.renderActive();
    setAuth("tok", { id: 1, username: "alex", avatar: null, role: "member" }, "Srv", "");
    hoisted.renderConnect.mockClear();

    router.renderRecovery.signOut();

    expect(hoisted.renderConnect).not.toHaveBeenCalled();
    expect(router.activePageId()).toBe("connect");
  });
});

describe("E1 with E2: an invite arrives while the MainPage chunk is still loading", () => {
  it("drops the stale main mount, and the connect mount takes the link exactly once", async () => {
    await router.renderActive();
    router.navigate("main");
    // The chunk is still loading (the gate is closed). The invite handler
    // queues the link and signs out; the logout subscriber navigates to connect.
    router.queuePendingInvite({ code: "ABC123", host: "h.example" });
    router.navigate("connect");
    hoisted.gate.resolve();
    await settle();

    expect(hoisted.createMainPage).not.toHaveBeenCalled();
    expect(appEl.querySelector("#main")).toBeNull();
    expect(appEl.querySelector("#connect")).not.toBeNull();
    // Initial mount plus the one the navigation made; the link went to the latter.
    expect(hoisted.renderConnect).toHaveBeenCalledTimes(2);
    const take = lastTakePendingInvite();
    expect(take()).toEqual({ code: "ABC123", host: "h.example" });
    expect(take()).toBeNull();
    // The page that took it is the mounted one: its hook is live, nothing is pending.
    expect(router.applyInviteNow("ABC123")).toBe(false);
    expect(hoisted.applyInvite).not.toHaveBeenCalled();
  });
});
