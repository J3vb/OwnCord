/**
 * The server switcher's controller behaviours, run once per renderer. A row is
 * a driver of action functions, so a new renderer adds a row and no case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerRail } from "../../../src/features/server-rail/ServerRail";
import type { RailControllerOptions } from "../../../src/features/server-rail/railController";
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

interface SwitcherDriver {
  readonly name: string;
  mount(options: RailControllerOptions): Promise<void>;
  clickServer(host: string): void;
  /** Opens the server's menu where it is drawn and clicks the row with this test id. */
  clickMenuItem(host: string, testId: string): void;
  openAdd(): void;
  openJoin(): void;
  /** Every server name as drawn text. */
  drawnNames(): string[];
  destroy(): void;
}

const byTestId = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
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

  it("a click on another server switches once even on a double click, and Add is ignored after it", async () => {
    localStorage.setItem("owncord:settings:confirmServerSwitch", "false");
    const { opts, switchServer, addServer } = options();
    await driver.mount(opts);
    driver.clickServer("b.example");
    driver.clickServer("b.example");
    expect(switchServer).toHaveBeenCalledExactlyOnceWith("b.example");
    driver.openAdd();
    expect(addServer).not.toHaveBeenCalled();
  });

  it("with the switch question on, a double click opens one question; Cancel keeps the session; destroy closes it without switching", async () => {
    const { opts, switchServer } = options();
    await driver.mount(opts);
    driver.clickServer("b.example");
    driver.clickServer("b.example");
    expect(document.querySelectorAll('[data-testid="server-switch-dialog"]')).toHaveLength(1);
    byTestId("server-switch-cancel")?.click();
    expect(byTestId("server-switch-dialog")).toBeNull();
    expect(switchServer).not.toHaveBeenCalled();

    driver.clickServer("b.example");
    const confirm = byTestId("server-switch-confirm");
    expect(confirm).not.toBeNull();
    driver.destroy();
    expect(byTestId("server-switch-dialog")).toBeNull();
    confirm?.click();
    expect(switchServer).not.toHaveBeenCalled();
  });

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
