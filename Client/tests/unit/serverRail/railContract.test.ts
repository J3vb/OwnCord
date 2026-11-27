/**
 * The server switcher's controller behaviours, run once per renderer. A row is
 * a driver of action functions, so a new renderer adds a row and no case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerRail } from "../../../src/features/server-rail/ServerRail";
import type { RailControllerOptions } from "../../../src/features/server-rail/railController";
import type { DropZone } from "../../../src/features/server-rail/serverRailParts";
import {
  createRailController,
  type RailController,
} from "../../../src/features/server-rail/railController";
import {
  createServerTabs,
  type ServerTabs,
} from "../../../src/features/server-rail/serverTabsRenderer";
import { serverRailText } from "../../../src/i18n/serverRail";
import { RAIL_LAYOUT_KEY } from "@lib/prefs/serverRailLayout";
import type { ServerProfile } from "@lib/presence/profiles";
import { setSidebarMode } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { usePhone } from "../../helpers/phoneMedia";

interface SwitcherDriver {
  readonly name: string;
  mount(options: RailControllerOptions): Promise<void>;
  clickServer(host: string): void | Promise<void>;
  /** Opens the server's menu where it is drawn and clicks the row with this test id. */
  clickMenuItem(host: string, testId: string): void;
  openAdd(): void | Promise<void>;
  openJoin(): void;
  /** Every server name as drawn text. */
  drawnNames(): string[];
  /** Drags `from`'s server onto `to`'s and drops it in `zone`, with the target's rect stubbed. */
  dropOn?(from: string, to: string, zone: DropZone): void;
  destroy(): void;
}

const byTestId = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

/** Where in a stubbed 100 px box each zone is, along the target's axis. */
const ZONE_AT: Readonly<Record<DropZone, number>> = { before: 10, into: 50, after: 90 };

/** Drags `source` onto `target` and drops it at `at`, as the browser's drag events do. */
function dragDrop(source: HTMLElement, target: HTMLElement, at: MouseEventInit): void {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  const fire = (el: HTMLElement, type: string): boolean =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...at }));
  fire(source, "dragstart");
  fire(target, "dragover");
  fire(target, "drop");
  if (source.isConnected) fire(source, "dragend");
}

function classicDriver(): SwitcherDriver {
  let rail: ReturnType<typeof createServerRail> | null = null;
  const serverBtn = (host: string): HTMLElement => {
    const btn = document.querySelector<HTMLElement>(
      `[data-testid="server-rail-server"][data-host="${host}"]`,
    );
    if (btn === null) throw new Error(`${host} is not drawn`);
    return btn;
  };
  const suffix = serverRailText("currentSuffix", { name: "" });
  return {
    name: "Classic rail",
    async mount(options) {
      rail = createServerRail(options);
      rail.mount(document.body);
      await settle();
    },
    clickServer: (host) => serverBtn(host).click(),
    clickMenuItem(host, testId) {
      serverBtn(host).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      const item = byTestId(testId);
      if (item === null) throw new Error(`no menu row ${testId}`);
      item.click();
    },
    openAdd: () => byTestId("server-rail-add")?.click(),
    openJoin: () => byTestId("server-rail-join")?.click(),
    drawnNames: () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="server-rail-server"]'),
        (b) => (b.title.endsWith(suffix) ? b.title.slice(0, -suffix.length) : b.title),
      ),
    dropOn(from, to, zone) {
      const target = serverBtn(to).closest<HTMLElement>(".server-rail-item");
      if (target === null) throw new Error(`${to} has no drop target`);
      dragDrop(serverBtn(from), target, { clientY: ZONE_AT[zone] });
    },
    destroy() {
      rail?.destroy?.();
      rail = null;
    },
  };
}

/** Command Deck's tabs: a folder member is reached through its folder tab's dropdown. */
function tabsDriver(): SwitcherDriver {
  let ctl: RailController | null = null;
  let tabs: ServerTabs | null = null;
  const suffix = serverRailText("currentSuffix", { name: "" });
  const strip = (label: string): string =>
    label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
  const nameOf = (el: Element): string => strip(el.getAttribute("aria-label") ?? "");
  const find = (selector: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el === null) throw new Error(`nothing matches ${selector}`);
    return el;
  };
  const folderTab = (id: string): HTMLElement =>
    find(`[data-testid="server-tab-folder"][data-folder-id="${id}"]`);
  /** The element a user acts on for `host`: its tab, or its row in its folder's open dropdown. */
  const reach = (host: string): HTMLElement => {
    const folder = ctl
      ?.layout()
      .find((item) => item.kind === "folder" && item.hosts.includes(host));
    if (folder === undefined || folder.kind !== "folder") {
      return find(`[data-testid="server-tab"][data-host="${host}"]`);
    }
    folderTab(folder.id).click();
    return find(`.server-tabs-menu [data-testid="server-tab-folder-item"][data-host="${host}"]`);
  };
  const closeMenu = (): void => {
    find(".server-tabs-menu").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  };
  return {
    name: "Deck tabs",
    async mount(options) {
      ctl = createRailController(options);
      tabs = createServerTabs(ctl);
      ctl.start(tabs.render, tabs.focusFallback);
      document.body.append(tabs.servers, tabs.nav);
      await settle();
    },
    clickServer: (host) => reach(host).click(),
    clickMenuItem(host, testId) {
      reach(host).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      const item = byTestId(testId);
      if (item === null) throw new Error(`no menu row ${testId}`);
      item.click();
    },
    openAdd() {
      byTestId("server-tabs-add")?.click();
      byTestId("server-tabs-add-server")?.click();
    },
    openJoin() {
      byTestId("server-tabs-add")?.click();
      byTestId("server-tabs-join")?.click();
    },
    drawnNames() {
      const names: string[] = [];
      const cells = document.querySelectorAll<HTMLElement>(
        ".server-tabs-track > .server-tab:not(.server-tabs-more)",
      );
      for (const cell of cells) {
        if (cell.dataset["testid"] === "server-tab") {
          names.push(nameOf(cell));
          continue;
        }
        // The track is not rebuilt while a dropdown is open, so `cell` stays live.
        cell.click();
        const rows = document.querySelectorAll(
          '.server-tabs-menu [data-testid="server-tab-folder-item"]',
        );
        names.push(...Array.from(rows, nameOf));
        closeMenu();
      }
      return names;
    },
    dropOn(from, to, zone) {
      const tab = (host: string): HTMLElement =>
        find(`[data-testid="server-tab"][data-host="${host}"]`);
      dragDrop(tab(from), tab(to), { clientX: ZONE_AT[zone] });
    },
    destroy() {
      tabs?.destroy();
      ctl?.destroy();
      tabs?.nav.remove();
      tabs?.servers.remove();
      tabs = null;
      ctl = null;
    },
  };
}

const drivers: ReadonlyArray<() => SwitcherDriver> = [classicDriver, tabsDriver];

function profile(name: string, host: string): ServerProfile {
  return {
    id: host,
    name,
    host,
    username: "u",
    autoConnect: false,
    rememberPassword: false,
    color: "#5865f2",
    lastConnected: null,
  };
}

const three = [
  profile("Alpha", "a.example"),
  profile("Beta", "b.example"),
  profile("Gamma", "c.example"),
];

function options(over: Partial<RailControllerOptions> = {}) {
  const switchServer = vi.fn();
  const addServer = vi.fn();
  const onShowServer = vi.fn();
  const opts: RailControllerOptions = {
    currentHost: "a.example",
    loadServers: () => Promise.resolve(three),
    switchServer,
    addServer,
    joinInvite: () => false,
    newFolderId: () => "fid",
    onShowServer,
    ...over,
  };
  return { opts, switchServer, addServer, onShowServer };
}

const stored = (): unknown => JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "null");

/** What the two switch cases need from a driver. */
type SwitchDriver = Pick<SwitcherDriver, "mount" | "clickServer" | "openAdd" | "destroy">;

async function switchesOnce(driver: SwitchDriver): Promise<void> {
  localStorage.setItem("owncord:settings:confirmServerSwitch", "false");
  const { opts, switchServer, addServer } = options();
  await driver.mount(opts);
  await driver.clickServer("b.example");
  await driver.clickServer("b.example");
  expect(switchServer).toHaveBeenCalledExactlyOnceWith("b.example");
  await driver.openAdd();
  expect(addServer).not.toHaveBeenCalled();
}

async function asksOnce(driver: SwitchDriver): Promise<void> {
  const { opts, switchServer } = options();
  await driver.mount(opts);
  await driver.clickServer("b.example");
  await driver.clickServer("b.example");
  expect(document.querySelectorAll('[data-testid="server-switch-dialog"]')).toHaveLength(1);
  byTestId("server-switch-cancel")?.click();
  expect(byTestId("server-switch-dialog")).toBeNull();
  expect(switchServer).not.toHaveBeenCalled();

  await driver.clickServer("b.example");
  const confirm = byTestId("server-switch-confirm");
  expect(confirm).not.toBeNull();
  driver.destroy();
  expect(byTestId("server-switch-dialog")).toBeNull();
  confirm?.click();
  expect(switchServer).not.toHaveBeenCalled();
}

describe.each(drivers.map((make) => ({ make, name: make().name })))("$name", ({ make }) => {
  let driver: SwitcherDriver;

  beforeEach(() => {
    localStorage.clear();
    setSidebarMode("channels");
    authStore.setState((s) => ({ ...s, serverName: "Alpha" }));
    authStore.flush();
    driver = make();
  });
  afterEach(() => {
    driver.destroy();
    document.body.innerHTML = "";
    authStore.setState((s) => ({ ...s, serverName: null }));
    authStore.flush();
  });

  it("a click on another server switches once even on a double click, and Add is ignored after it", () =>
    switchesOnce(driver));

  it("with the switch question on, a double click opens one question; Cancel keeps the session; destroy closes it without switching", () =>
    asksOnce(driver));

  it("a click on the current server shows it", async () => {
    const { opts, switchServer, onShowServer } = options();
    await driver.mount(opts);
    driver.clickServer("a.example");
    expect(onShowServer).toHaveBeenCalledTimes(1);
    expect(switchServer).not.toHaveBeenCalled();
  });

  it("with the read failing and then succeeding, an action before the read leaves every stored folder and host in place", async () => {
    const folder = {
      kind: "folder",
      id: "f1",
      name: "Work",
      color: "#3ba55d",
      collapsed: false,
      hosts: ["a.example", "b.example"],
    };
    const loose = { kind: "server", host: "c.example" };
    localStorage.setItem(RAIL_LAYOUT_KEY, JSON.stringify([folder, loose]));
    const loadServers = vi
      .fn<() => Promise<readonly ServerProfile[]>>()
      .mockRejectedValueOnce(new Error("store down"))
      .mockResolvedValue(three);
    await driver.mount(options({ loadServers }).opts);

    // Only a.example is drawn before the read, so Move down passes b.example,
    // which is not drawn yet: the result is still the full stored layout.
    driver.clickMenuItem("a.example", "rail-move-down");
    const moved = [{ ...folder, hosts: ["b.example", "a.example"] }, loose];
    expect(stored()).toEqual(moved);

    await settle();
    expect(loadServers).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual(moved);
  });

  it("menu actions reach commit and redraw", async () => {
    await driver.mount(options({ loadServers: () => Promise.resolve(three.slice(0, 2)) }).opts);
    driver.clickMenuItem("a.example", "rail-group-next");
    expect(stored()).toMatchObject([{ kind: "folder", hosts: ["b.example", "a.example"] }]);
    expect(driver.drawnNames()).toEqual(["Beta", "Alpha"]);

    driver.clickMenuItem("b.example", "rail-move-down");
    expect(stored()).toMatchObject([{ kind: "folder", hosts: ["a.example", "b.example"] }]);
    expect(driver.drawnNames()).toEqual(["Alpha", "Beta"]);

    driver.clickMenuItem("a.example", "rail-remove-from-folder");
    expect(stored()).toEqual([
      expect.objectContaining({ kind: "folder", hosts: ["b.example"] }),
      { kind: "server", host: "a.example" },
    ]);
  });

  it("a drop that makes a folder", async () => {
    await driver.mount(options().opts);
    const { dropOn } = driver;
    if (dropOn === undefined) throw new Error(`${driver.name} cannot drop`);
    dropOn("c.example", "b.example", "into");
    expect(stored()).toEqual([
      { kind: "server", host: "a.example" },
      expect.objectContaining({ kind: "folder", id: "fid", hosts: ["b.example", "c.example"] }),
    ]);
    expect(driver.drawnNames()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("the join dialog closes when the switcher is destroyed", async () => {
    await driver.mount(options().opts);
    driver.openJoin();
    expect(byTestId("server-rail-join-dialog")).not.toBeNull();
    driver.destroy();
    expect(byTestId("server-rail-join-dialog")).toBeNull();
  });

  it("a server name with markup is drawn as text and makes no element", async () => {
    const name = "<img src=x onerror=1>";
    await driver.mount(
      options({ loadServers: () => Promise.resolve([three[0]!, profile(name, "b.example")]) }).opts,
    );
    expect(driver.drawnNames()).toContain(name);
    expect(document.querySelector("img")).toBeNull();
  });
});

/** The Servers sheet on a phone: each tap opens the sheet from the Servers button, waits for it and taps a row. */
function sheetDriver(): SwitchDriver {
  let ctl: RailController | null = null;
  let tabs: ServerTabs | null = null;
  const openSheet = async (): Promise<HTMLElement> => {
    tabs?.servers.click();
    await vi.dynamicImportSettled();
    await vi.dynamicImportSettled();
    const sheet = byTestId("deck-servers-sheet");
    if (sheet === null) throw new Error("the Servers sheet did not open");
    return sheet;
  };
  return {
    async mount(options) {
      ctl = createRailController(options);
      tabs = createServerTabs(ctl);
      ctl.start(tabs.render, tabs.focusFallback);
      document.body.append(tabs.servers, tabs.nav);
      await settle();
    },
    async clickServer(host) {
      const sheet = await openSheet();
      const name = ctl?.look(host).name;
      const row = Array.from(
        sheet.querySelectorAll<HTMLElement>('[data-testid="deck-servers-sheet-server"]'),
      ).find((r) => r.querySelector(".menu-sheet-label")?.textContent === name);
      if (row === undefined) throw new Error(`no sheet row for ${host}`);
      row.click();
    },
    async openAdd() {
      const sheet = await openSheet();
      sheet.querySelector<HTMLElement>('[data-testid="server-tabs-add-server"]')?.click();
    },
    destroy() {
      tabs?.destroy();
      ctl?.destroy();
      tabs?.nav.remove();
      tabs?.servers.remove();
      tabs = null;
      ctl = null;
    },
  };
}

describe("Deck tabs, the Servers sheet on a phone", () => {
  let driver: SwitchDriver;

  beforeEach(() => {
    localStorage.clear();
    usePhone();
    setSidebarMode("channels");
    authStore.setState((s) => ({ ...s, serverName: "Alpha" }));
    authStore.flush();
    driver = sheetDriver();
  });
  afterEach(() => {
    driver.destroy();
    closeBottomSheet();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    authStore.setState((s) => ({ ...s, serverName: null }));
    authStore.flush();
  });

  it("a tap on another server switches once even on a double tap, and Add is ignored after it", () =>
    switchesOnce(driver));

  it("with the switch question on, a double tap opens one question; Cancel keeps the session; destroy closes it without switching", () =>
    asksOnce(driver));
});
