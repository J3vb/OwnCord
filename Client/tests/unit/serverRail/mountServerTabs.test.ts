/**
 * Loading the server tabs into the Deck top bar: the row is reserved at once,
 * the tabs are built on demand and attached last, their refit triggers belong
 * to one child of the frame's owner, and a failed load leaves the bar as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Disposable } from "@lib/disposable";
import { savePref } from "@lib/prefs/preferences";
import { mountServerTabs } from "../../../src/features/server-rail/mountServerTabs";
import { createRailController } from "../../../src/features/server-rail/railController";
import {
  createServerTabs,
  type ServerTabs,
} from "../../../src/features/server-rail/serverTabsRenderer";
import type { RailController } from "../../../src/features/server-rail/railController";
import type { ServerSwitcherDeps } from "../../../src/features/server-rail/switcherOptions";
import { fitTabs } from "../../../src/features/server-rail/tabFit";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@lib/logger", async () => {
  const { loggerMock } = await import("../../helpers/loggerMock");
  return loggerMock({ buffer: true, createLogger: () => log });
});

vi.mock(import("../../../src/features/server-rail/railController"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createRailController: vi.fn(actual.createRailController) };
});
vi.mock(import("../../../src/features/server-rail/serverTabsRenderer"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createServerTabs: vi.fn(actual.createServerTabs) };
});
vi.mock(import("../../../src/features/server-rail/tabFit"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fitTabs: vi.fn(actual.fitTabs) };
});
vi.mock(import("../../../src/features/server-rail/switchServer"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadSavedServers: () => Promise.resolve([]) };
});

function deps(over: Partial<ServerSwitcherDeps> = {}): ServerSwitcherDeps {
  return {
    host: "h.example",
    isTornDown: () => false,
    onOpenDm: vi.fn(),
    onShowServer: vi.fn(),
    own: vi.fn(),
    ...over,
  };
}

/** A renderer that records what is done to it; `order` collects destroy calls. */
function fakeTabs(order: string[]): ServerTabs {
  return {
    nav: document.createElement("nav"),
    servers: document.createElement("button"),
    render: vi.fn(),
    fit: vi.fn(),
    closeMenu: vi.fn(),
    focusFallback: vi.fn(() => null),
    destroy: vi.fn(() => order.push("tabs")),
  };
}

function fakeController(order: string[], start: () => void = () => {}): RailController {
  return {
    destroy: vi.fn(() => order.push("ctl")),
    start: vi.fn(start),
  } as unknown as RailController;
}

interface ObserverProbe {
  readonly observed: Element[];
  readonly disconnect: Mock<() => void>;
  readonly callbacks: Array<() => void>;
}

function stubObserver(): ObserverProbe {
  const probe: ObserverProbe = { observed: [], disconnect: vi.fn<() => void>(), callbacks: [] };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        probe.callbacks.push(cb);
      }
      observe(target: Element): void {
        probe.observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        probe.disconnect();
      }
    },
  );
  return probe;
}

/** A FontFaceSet stand-in: jsdom has none. */
function stubFonts(): EventTarget {
  const fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
  return fonts;
}

let bar: HTMLDivElement;
let owner: Disposable;

/** Row 1 of the bar as the frame builds it, with the Direct button last. */
function buildBar(withDirect = true): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "deck-top-bar has-deck-direct";
  for (const cls of ["deck-top-name", "deck-search", "deck-connection"]) {
    const child = document.createElement("div");
    child.className = cls;
    el.appendChild(child);
  }
  if (withDirect) {
    const direct = document.createElement("button");
    direct.className = "deck-direct";
    el.appendChild(direct);
  }
  document.body.appendChild(el);
  return el;
}

async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Mounts with a fake controller and renderer; returns them. */
async function mountFakes(over: Partial<ServerSwitcherDeps> = {}) {
  const order: string[] = [];
  const tabs = fakeTabs(order);
  const ctl = fakeController(order);
  vi.mocked(createRailController).mockImplementationOnce(() => ctl);
  vi.mocked(createServerTabs).mockImplementationOnce(() => tabs);
  mountServerTabs(deps(over), bar, owner);
  await settle();
  return { tabs, ctl, order };
}

beforeEach(() => {
  bar = buildBar();
  owner = new Disposable();
  log.warn.mockClear();
});

afterEach(() => {
  owner.destroy();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
  vi.mocked(createRailController).mockClear();
  vi.mocked(createServerTabs).mockClear();
  vi.mocked(fitTabs).mockClear();
});

describe("mountServerTabs", () => {
  it("reserves the row before the tabs load", async () => {
    const before = Array.from(bar.children);
    mountServerTabs(deps(), bar, owner);
    expect(bar.classList.contains("has-tabs-row")).toBe(true);
    expect(bar.classList.contains("has-server-tabs")).toBe(false);
    expect(Array.from(bar.children)).toEqual(before);
    await settle();
  });

  it("torn down while loading: nothing is built and the reserve is removed", async () => {
    let tornDown = false;
    mountServerTabs(deps({ isTornDown: () => tornDown }), bar, owner);
    tornDown = true;
    await settle();
    expect(createRailController).not.toHaveBeenCalled();
    expect(createServerTabs).not.toHaveBeenCalled();
    expect(bar.classList.contains("has-tabs-row")).toBe(false);
  });

  it("owner destroyed while loading: nothing is built", async () => {
    mountServerTabs(deps(), bar, owner);
    owner.destroy();
    expect(bar.classList.contains("has-tabs-row")).toBe(false);
    await settle();
    expect(createRailController).not.toHaveBeenCalled();
    expect(bar.querySelector("nav")).toBeNull();
  });

  it("a build that throws destroys the renderer, then the controller, releases the triggers registered before the throw, leaves the bar as it was and logs once", async () => {
    const probe = stubObserver();
    const fonts = stubFonts();
    vi.spyOn(fonts, "addEventListener").mockImplementation(() => {
      throw new Error("no fonts");
    });
    const before = Array.from(bar.children);
    const { tabs, order } = await mountFakes();
    expect(probe.observed).toEqual([tabs.nav]);
    expect(probe.disconnect).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["tabs", "ctl"]);
    expect(Array.from(bar.children)).toEqual(before);
    expect(bar.className).toBe("deck-top-bar has-deck-direct");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toBe("Server tabs failed to load");
    window.dispatchEvent(new Event("resize"));
    expect(tabs.closeMenu).not.toHaveBeenCalled();
  });

  it("a controller that throws on start leaves the bar as it was and logs once", async () => {
    const order: string[] = [];
    const tabs = fakeTabs(order);
    vi.mocked(createRailController).mockImplementationOnce(() =>
      fakeController(order, () => {
        throw new Error("start");
      }),
    );
    vi.mocked(createServerTabs).mockImplementationOnce(() => tabs);
    mountServerTabs(deps(), bar, owner);
    await settle();
    expect(order).toEqual(["tabs", "ctl"]);
    expect(tabs.nav.isConnected).toBe(false);
    expect(bar.classList.contains("has-tabs-row")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("a teardown that throws after a failed start still logs the failure first, then the cleanup", async () => {
    const order: string[] = [];
    const tabs: ServerTabs = {
      ...fakeTabs(order),
      destroy: vi.fn(() => {
        throw new Error("teardown");
      }),
    };
    vi.mocked(createRailController).mockImplementationOnce(() =>
      fakeController(order, () => {
        throw new Error("start");
      }),
    );
    vi.mocked(createServerTabs).mockImplementationOnce(() => tabs);
    mountServerTabs(deps(), bar, owner);
    await settle();
    expect(log.warn.mock.calls.map((c) => c[0])).toEqual([
      "Server tabs failed to load",
      "Server tabs cleanup failed",
    ]);
  });

  it("mounts the Servers button first and the nav before the Direct button, and adds has-server-tabs", async () => {
    const { tabs } = await mountFakes();
    expect(bar.firstElementChild).toBe(tabs.servers);
    expect(tabs.nav.nextElementSibling?.className).toBe("deck-direct");
    expect(bar.classList.contains("has-server-tabs")).toBe(true);
    expect(bar.classList.contains("has-tabs-row")).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();

    owner.destroy();
    owner = new Disposable();
    bar.remove();
    bar = buildBar(false);
    const second = await mountFakes();
    expect(bar.lastElementChild).toBe(second.tabs.nav);
  });

  it("without ResizeObserver or document.fonts it still mounts", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { tabs } = await mountFakes();
    expect(tabs.nav.isConnected).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("resize"));
    expect(tabs.closeMenu).toHaveBeenCalledTimes(1);
  });

  it("fits once after attaching, without ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const order: string[] = [];
    const tabs = fakeTabs(order);
    vi.mocked(tabs.fit).mockImplementation(() => {
      order.push(tabs.nav.isConnected ? "fit attached" : "fit detached");
    });
    vi.mocked(createRailController).mockImplementationOnce(() => fakeController(order));
    vi.mocked(createServerTabs).mockImplementationOnce(() => tabs);
    mountServerTabs(deps(), bar, owner);
    await settle();
    expect(order).toEqual(["fit attached"]);
  });

  it("a ResizeObserver on the nav refits", async () => {
    const probe = stubObserver();
    const { tabs } = await mountFakes();
    expect(probe.observed).toEqual([tabs.nav]);
    vi.mocked(tabs.fit).mockClear();
    probe.callbacks[0]?.();
    expect(tabs.fit).toHaveBeenCalledTimes(1);
  });

  it("a fonts loadingdone event refits", async () => {
    const fonts = stubFonts();
    const { tabs } = await mountFakes();
    vi.mocked(tabs.fit).mockClear();
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(tabs.fit).toHaveBeenCalledTimes(1);
  });

  it("a fontSize or largeFont change refits after the size is applied", async () => {
    const { tabs } = await mountFakes();
    for (const pref of ["fontSize", "largeFont"]) {
      vi.mocked(tabs.fit).mockClear();
      savePref(pref, pref === "fontSize" ? 18 : true);
      expect(tabs.fit).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(tabs.fit).toHaveBeenCalledTimes(1);
    }
    savePref("theme", "dark");
    await Promise.resolve();
    expect(tabs.fit).toHaveBeenCalledTimes(1);
  });

  it("a fontSize change while a menu is open refits once, after the menu closes", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    mountServerTabs(deps(), bar, owner);
    await settle();
    const nav = bar.querySelector<HTMLElement>("[data-testid='server-tabs']")!;
    Object.defineProperty(nav, "clientWidth", { get: () => 800 });
    const add = nav.querySelector<HTMLElement>("[data-testid='server-tabs-add']")!;
    add.click();
    const menu = document.querySelector<HTMLElement>(".server-tabs-menu")!;
    vi.mocked(fitTabs).mockClear();
    savePref("fontSize", 18);
    await settle();
    expect(fitTabs).not.toHaveBeenCalled();
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(fitTabs).toHaveBeenCalledTimes(1);
  });

  it("a window resize closes an open menu", async () => {
    const { tabs } = await mountFakes();
    window.dispatchEvent(new Event("resize"));
    expect(tabs.closeMenu).toHaveBeenCalledTimes(1);
  });

  it("start receives the renderer's focus fallback", async () => {
    const { tabs, ctl } = await mountFakes();
    expect(ctl.start).toHaveBeenCalledExactlyOnceWith(tabs.render, tabs.focusFallback);
    expect(createServerTabs).toHaveBeenCalledExactlyOnceWith(ctl);
    expect(createRailController).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ currentHost: "h.example" }),
    );
  });

  it("the frame owner's destroy destroys the child owner, which removes both, both classes, the observer and every listener (a dispatched loadingdone, pref change and resize after it do nothing)", async () => {
    const probe = stubObserver();
    const fonts = stubFonts();
    const { tabs, order } = await mountFakes();
    owner.destroy();
    expect(order).toEqual(["tabs", "ctl"]);
    expect(tabs.nav.isConnected).toBe(false);
    expect(tabs.servers.isConnected).toBe(false);
    expect(bar.className).toBe("deck-top-bar has-deck-direct");
    expect(probe.disconnect).toHaveBeenCalledTimes(1);
    vi.mocked(tabs.fit).mockClear();
    fonts.dispatchEvent(new Event("loadingdone"));
    savePref("fontSize", 20);
    window.dispatchEvent(new Event("resize"));
    await Promise.resolve();
    expect(tabs.fit).not.toHaveBeenCalled();
    expect(tabs.closeMenu).not.toHaveBeenCalled();
  });
});
