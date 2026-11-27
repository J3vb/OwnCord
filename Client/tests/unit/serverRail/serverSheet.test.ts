/**
 * The Servers sheet: on a phone the Servers button opens the server list as a
 * bottom sheet instead of the popover, with the same servers and folders in
 * the same order, then Add and Join.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createRailController,
  type RailController,
} from "../../../src/features/server-rail/railController";
import {
  createServerTabs,
  type ServerTabs,
} from "../../../src/features/server-rail/serverTabsRenderer";
import { openServerSheet } from "../../../src/features/server-rail/serverSheet";
import type { TabMenuContext } from "../../../src/features/server-rail/serverTabMenus";
import { serverRailText } from "../../../src/i18n/serverRail";
import { RAIL_LAYOUT_KEY } from "@lib/prefs/serverRailLayout";
import type { ServerProfile } from "@lib/presence/profiles";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { authStore } from "@stores/auth.store";
import { expectConsole } from "../../helpers/console";

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

const PROFILES = [
  profile("Alpha", "a.example"),
  profile("Beta", "b.example"),
  profile("Gamma", "c.example"),
  profile("Delta", "d.example"),
];
/** Alpha (current), the Work folder (Gamma, Delta), Beta. */
const LAYOUT = [
  { kind: "server", host: "a.example" },
  {
    kind: "folder",
    id: "f1",
    name: "Work",
    color: "#3ba55d",
    collapsed: false,
    hosts: ["c.example", "d.example"],
  },
  { kind: "server", host: "b.example" },
];

const SHEET = '[data-testid="deck-servers-sheet"]';
const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(SHEET);
const labels = (): string[] =>
  Array.from(sheet()?.querySelectorAll(".menu-sheet-label") ?? [], (el) => el.textContent ?? "");
const rowNamed = (label: string): HTMLElement => {
  const found = Array.from(sheet()?.querySelectorAll<HTMLElement>(".menu-sheet-row") ?? []).find(
    (r) => r.querySelector(".menu-sheet-label")?.textContent === label,
  );
  if (found === undefined) throw new Error(`no row ${label}`);
  return found;
};

let phone = true;
let ctl: RailController;
let tabs: ServerTabs;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Both lazy hops: the sheet's module, then the menu sheet's. */
async function imports(): Promise<void> {
  await vi.dynamicImportSettled();
  await vi.dynamicImportSettled();
  await settle();
}

/** history.back() lands its popstate on a later task in jsdom. */
async function settleHistory(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function mount(): Promise<void> {
  localStorage.setItem(RAIL_LAYOUT_KEY, JSON.stringify(LAYOUT));
  ctl = createRailController({
    currentHost: "a.example",
    loadServers: () => Promise.resolve(PROFILES),
    switchServer: vi.fn(),
    addServer: vi.fn(),
    joinInvite: () => false,
  });
  tabs = createServerTabs(ctl);
  document.body.append(tabs.servers, tabs.nav);
  ctl.start(tabs.render, tabs.focusFallback);
  await settle();
}

async function tap(): Promise<void> {
  tabs.servers.click();
  await imports();
}

/** A context with spies, for the cases that watch the order of calls. */
function spyContext(): TabMenuContext & {
  readonly closeMenu: Mock<() => void>;
  readonly activate: Mock<(host: string) => void>;
} {
  return {
    ctl,
    open: vi.fn(),
    activate: vi.fn<(host: string) => void>(),
    closeMenu: vi.fn<() => void>(),
  };
}

beforeEach(() => {
  phone = true;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: phone && q.includes("pointer: coarse") })),
  );
  localStorage.clear();
  authStore.setState((s) => ({ ...s, serverName: "Alpha" }));
  authStore.flush();
});

afterEach(async () => {
  closeBottomSheet();
  await settleHistory();
  tabs.destroy();
  ctl.destroy();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  authStore.setState((s) => ({ ...s, serverName: null }));
  authStore.flush();
});

describe("the Servers sheet", () => {
  it("a tap opens the sheet with the servers and folders in order, then Add and Join", async () => {
    await mount();
    await tap();
    expect(sheet()).not.toBeNull();
    expect(document.querySelector('[data-testid="deck-servers-menu"]')).toBeNull();
    expect(sheet()!.getAttribute("aria-label")).toBe(serverRailText("label"));
    const folder = serverRailText("folderTab", { name: "Work", count: 2 });
    expect(labels()).toEqual([
      serverRailText("currentSuffix", { name: "Alpha" }),
      folder,
      "Beta",
      serverRailText("add"),
      serverRailText("join"),
    ]);
    const ids = Array.from(
      sheet()!.querySelectorAll<HTMLElement>(".menu-sheet-row"),
      (r) => r.dataset["testid"],
    );
    expect(ids).toEqual([
      "deck-servers-sheet-server",
      "deck-servers-sheet-folder",
      "deck-servers-sheet-server",
      "server-tabs-add-server",
      "server-tabs-join",
    ]);
    // Add and Join sit in their own card, after a separation.
    expect(sheet()!.querySelectorAll(".msg-sheet-section")).toHaveLength(2);
    const current = rowNamed(serverRailText("currentSuffix", { name: "Alpha" }));
    expect(current.getAttribute("role")).toBe("radio");
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(rowNamed("Beta").getAttribute("aria-checked")).toBe("false");
  });

  it("a folder opens its servers on a second page", async () => {
    await mount();
    await tap();
    rowNamed(serverRailText("folderTab", { name: "Work", count: 2 })).click();
    expect(sheet()!.querySelector('[data-testid="menu-sheet-back"]')).not.toBeNull();
    expect(labels()).toEqual(["Gamma", "Delta"]);
    expect(sheet()!.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it("a server tap closes the sheet, then switches once", async () => {
    await mount();
    const ctx = spyContext();
    ctx.activate.mockImplementation(() => expect(sheet()).toBeNull());
    openServerSheet(ctx, ctl.layout(), tabs.servers);
    await imports();
    rowNamed("Beta").click();
    expect(ctx.activate).toHaveBeenCalledExactlyOnceWith("b.example");
    expect(sheet()).toBeNull();
  });

  it("closes the tabs' open menu before the sheet opens", async () => {
    await mount();
    const ctx = spyContext();
    ctx.closeMenu.mockImplementation(() => expect(sheet()).toBeNull());
    openServerSheet(ctx, ctl.layout(), tabs.servers);
    expect(ctx.closeMenu).toHaveBeenCalledTimes(1);
    await imports();
    expect(sheet()).not.toBeNull();
  });

  it("a window resize leaves it open", async () => {
    await mount();
    await tap();
    window.dispatchEvent(new Event("resize"));
    expect(sheet()).not.toBeNull();
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("true");
  });

  it("a phone-query change leaves it open, and Back then closes it", async () => {
    await mount();
    await tap();
    phone = false;
    window.dispatchEvent(new Event("resize"));
    expect(sheet()).not.toBeNull();
    history.back();
    await settleHistory();
    expect(sheet()).toBeNull();
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("false");
  });

  it("aria-expanded is true while it is open and false after, and focus returns to the button", async () => {
    await mount();
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("false");
    await tap();
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("true");
    sheet()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(sheet()).toBeNull();
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(tabs.servers);
  });

  it("an abort during the import opens nothing", async () => {
    await mount();
    tabs.servers.click();
    ctl.destroy();
    await imports();
    expect(sheet()).toBeNull();
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("false");
  });

  it("off a phone the Servers button opens the popover, not the sheet", async () => {
    phone = false;
    await mount();
    await tap();
    expect(sheet()).toBeNull();
    expect(document.querySelector('[data-testid="deck-servers-menu"]')).not.toBeNull();
  });
});

describe("the Servers sheet, when its module fails to load", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/features/menus/menuSheet");
  });

  it("logs, opens nothing and leaves aria-expanded false", async () => {
    vi.doMock("../../../src/features/menus/menuSheet", () => {
      throw new Error("chunk failed");
    });
    await mount();
    openServerSheet(spyContext(), ctl.layout(), tabs.servers);
    await imports();
    await vi.waitFor(() => expectConsole("warn", "Servers sheet failed to open"));
    expect(sheet()).toBeNull();
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("false");
  });
});
