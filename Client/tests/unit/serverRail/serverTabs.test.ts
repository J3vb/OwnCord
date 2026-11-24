/**
 * Command Deck's server tabs: the drawing, the folder dropdown and the "+N"
 * and Servers lists, the one menu slot that holds redraws while a menu is open,
 * and where focus goes when a render, a fit or a fold hides what had it.
 *
 * jsdom lays nothing out, so widths and getClientRects are stubbed: a cell is
 * "shown" when it is connected, not under [hidden] and, inside the fold, not in
 * the row (the Servers button is shown only inside it).
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
import { SERVER_ICONS_KEY } from "../../../src/features/server-rail/serverIcons";
import { serverRailText } from "../../../src/i18n/serverRail";
import { RAIL_LAYOUT_KEY, ungroupFolder } from "@lib/prefs/serverRailLayout";
import type { ServerProfile } from "@lib/presence/profiles";
import { authStore } from "@stores/auth.store";

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

const H = "h.example";
const N = "n.example";
const P = "p.example";
const R = "r.example";
const S = "s.example";
const PROFILES = [
  profile("Hangar 9", H),
  profile("Night Owls", N),
  profile("Pixel Forge", P),
  profile("Retro LAN", R),
  profile("Sky Deck", S),
];
const WORK = { kind: "folder", id: "f1", name: "Work", color: "#3ba55d", collapsed: false };
/** Four top-level items: Hangar 9 (current), Night Owls, the Work folder (Pixel Forge, Retro LAN), Sky Deck. */
const LAYOUT = [
  { kind: "server", host: H },
  { kind: "server", host: N },
  { ...WORK, hosts: [P, R] },
  { kind: "server", host: S },
];

// --- Layout stubs -------------------------------------------------------------

const TAB = 100;
const MORE = 40;
const ADD = 26;
let fold = false;
let navWidth = 0;

function rectOf(el: Element): DOMRect {
  const width = el.matches(".server-tabs-more")
    ? MORE
    : el.matches(".server-tabs-add")
      ? ADD
      : el.matches(".server-tab")
        ? TAB
        : 0;
  return new DOMRect(10, 40, width, 30);
}

function isShown(el: Element): boolean {
  if (!el.isConnected || el.closest("[hidden]") !== null) return false;
  if (fold) return el.closest(".server-tabs") === null;
  return el.closest(".deck-servers-btn") === null;
}

/** Room for `count` tabs and "+N" (when not all four fit). */
function widthFor(count: number): number {
  return count >= LAYOUT.length ? 1000 : ADD + MORE + TAB * count;
}

// --- Mount --------------------------------------------------------------------

let ctl: RailController;
let tabs: ServerTabs;
let switchServer: Mock<(host: string) => void>;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

async function mount(layout: unknown = LAYOUT, width = 1000): Promise<void> {
  localStorage.setItem(RAIL_LAYOUT_KEY, JSON.stringify(layout));
  navWidth = width;
  switchServer = vi.fn<(host: string) => void>();
  ctl = createRailController({
    currentHost: H,
    loadServers: () => Promise.resolve(PROFILES),
    switchServer,
    addServer: vi.fn(),
    joinInvite: () => false,
    newFolderId: () => "fid",
  });
  tabs = createServerTabs(ctl);
  Object.defineProperty(tabs.nav, "clientWidth", { get: () => (fold ? 0 : navWidth) });
  document.body.append(tabs.servers, tabs.nav);
  ctl.start(tabs.render, tabs.focusFallback);
  await settle();
}

/** Narrows or widens the row, as the nav's observer would, and refits. */
function resize(width: number): void {
  navWidth = width;
  tabs.fit();
}

// --- Queries and input ----------------------------------------------------------

const q = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);
const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));
const tab = (host: string): HTMLElement =>
  q(`[data-testid="server-tab"][data-host="${host}"]`) ?? fail(`no tab ${host}`);
const folderTab = (): HTMLElement =>
  q('[data-testid="server-tab-folder"]') ?? fail("no folder tab");
const more = (): HTMLElement => q('[data-testid="server-tabs-more"]') ?? fail("no +N");
const add = (): HTMLElement => q('[data-testid="server-tabs-add"]') ?? fail("no +");
const menu = (): HTMLElement | null => q(".server-tabs-menu");
const menus = (): number => all(".server-tabs-menu").length;
const row = (testId: string, host?: string): HTMLElement =>
  q(
    `.server-tabs-menu [data-testid="${testId}"]${host === undefined ? "" : `[data-host="${host}"]`}`,
  ) ?? fail(`no row ${testId}`);
const trackCells = (): HTMLElement[] => all(".server-tabs-track > *");
const nameOf = (el: Element): string => el.getAttribute("aria-label") ?? el.textContent ?? "";

function fail(message: string): never {
  throw new Error(message);
}

function key(el: Element, k: string, init: KeyboardEventInit = {}): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
  );
}

function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

/** Escape on the open menu itself, where its key listener is. */
function escape(): void {
  const open = menu();
  if (open === null) throw new Error("no menu open");
  key(open, "Escape");
}

const dialogs = (): number => all('[data-testid="server-switch-dialog"]').length;

beforeEach(() => {
  localStorage.clear();
  fold = false;
  authStore.setState((s) => ({ ...s, serverName: "Hangar 9" }));
  authStore.flush();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return rectOf(this);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (isShown(this) ? [rectOf(this)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  tabs.destroy();
  ctl.destroy();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  authStore.setState((s) => ({ ...s, serverName: null }));
  authStore.flush();
});

describe("drawing", () => {
  it("draws a toolbar with the current tab marked and each name as text", async () => {
    await mount();
    const track = q(".server-tabs-track")!;
    expect(track.getAttribute("role")).toBe("toolbar");
    expect(track.getAttribute("aria-label")).toBe(serverRailText("tabsLabel"));
    expect(track.getAttribute("aria-orientation")).toBe("horizontal");
    expect(tabs.nav.getAttribute("aria-label")).toBe(serverRailText("label"));
    expect(tab(H).getAttribute("aria-current")).toBe("page");
    expect(tab(N).hasAttribute("aria-current")).toBe(false);
    expect(all(".server-tab-name").map((n) => n.textContent)).toEqual([
      "Hangar 9",
      "Night Owls",
      "Work",
      "Sky Deck",
    ]);
    expect(more().hidden).toBe(true);
    expect(add().getAttribute("aria-label")).toBe(serverRailText("addMenu"));
  });

  it('with a cached icon, a server tab, a dropdown row and a +N row are each named once, and the current tab is "Hangar 9 (current server)"', async () => {
    const dataUrl = "data:image/png;base64,AAAA";
    localStorage.setItem(
      SERVER_ICONS_KEY,
      JSON.stringify([N, P, S].map((host) => ({ host, hash: "0123456789abcdef", dataUrl }))),
    );
    await mount(LAYOUT, widthFor(2));
    expect(tab(N).querySelector("img")?.getAttribute("alt")).toBe("Night Owls");
    expect(nameOf(tab(N))).toBe("Night Owls");
    expect(tab(N).title).toBe("Night Owls");
    expect(nameOf(tab(H))).toBe("Hangar 9 (current server)");
    more().click();
    expect(nameOf(row("server-tab-menu-server", S))).toBe("Sky Deck");
    expect(nameOf(row("server-tab-folder-item", P))).toBe("Pixel Forge");
    escape();
    await settle();
    resize(1000);
    folderTab().click();
    expect(nameOf(row("server-tab-folder-item", P))).toBe("Pixel Forge");
  });

  it('a folder with an empty name is drawn and labelled as "Folder", in the tab, the dropdown and +N', async () => {
    const layout = [LAYOUT[0], LAYOUT[1], { ...LAYOUT[2], name: "" }, LAYOUT[3]];
    await mount(layout);
    expect(folderTab().querySelector(".server-tab-name")?.textContent).toBe("Folder");
    expect(nameOf(folderTab())).toBe(serverRailText("folderTab", { name: "Folder", count: 2 }));
    folderTab().click();
    expect(menu()?.getAttribute("aria-label")).toBe("Folder");
    expect(q(".server-tabs-menu-heading")?.textContent).toBe("Folder");
    escape();
    await settle();
    resize(widthFor(2));
    more().click();
    const heading = row("server-tab-menu-folder");
    expect(heading.textContent).toContain("Folder");
    expect(nameOf(heading)).toBe(serverRailText("folderTab", { name: "Folder", count: 2 }));
  });

  it("a folder tab names its count and whether it holds the current server", async () => {
    await mount([{ ...WORK, hosts: [H, P, R] }, LAYOUT[1], LAYOUT[3]]);
    const label = serverRailText("folderTab", { name: "Work", count: 3 });
    expect(nameOf(folderTab())).toBe(serverRailText("holdsCurrent", { label }));
    expect(folderTab().classList.contains("active")).toBe(true);
    expect(folderTab().querySelector(".server-tab-count")?.textContent).toBe("3");
    expect(folderTab().style.getPropertyValue("--folder-color")).toBe("#3ba55d");
    tabs.destroy();
    ctl.destroy();
    document.body.innerHTML = "";
    await mount();
    expect(nameOf(folderTab())).toBe(serverRailText("folderTab", { name: "Work", count: 2 }));
    expect(folderTab().classList.contains("active")).toBe(false);
  });

  it("the Servers button is named Servers", async () => {
    await mount();
    expect(nameOf(tabs.servers)).toBe("Servers");
    expect(tabs.servers.getAttribute("aria-haspopup")).toBe("menu");
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("false");
    expect(tabs.servers.dataset["testid"]).toBe("deck-servers-btn");
  });
});

describe("keyboard", () => {
  it("roving: Left/Right/Home/End move across visible tabs and +N, hidden tabs are skipped, one tab stop", async () => {
    await mount(LAYOUT, widthFor(2));
    const stops = trackCells().filter((c) => c.getAttribute("tabindex") === "0");
    expect(stops).toEqual([tab(H)]);
    tab(H).focus();
    key(tab(H), "ArrowRight");
    expect(document.activeElement).toBe(tab(N));
    key(tab(N), "ArrowRight");
    expect(document.activeElement).toBe(more());
    key(more(), "ArrowRight");
    expect(document.activeElement).toBe(more());
    key(more(), "Home");
    expect(document.activeElement).toBe(tab(H));
    key(tab(H), "End");
    expect(document.activeElement).toBe(more());
    key(more(), "ArrowLeft");
    expect(document.activeElement).toBe(tab(N));
    expect(trackCells().filter((c) => c.getAttribute("tabindex") === "0")).toEqual([tab(N)]);
    expect(folderTab().hidden).toBe(true);
  });

  it("Shift+F10 on a tab opens its menu at the tab's bottom-left", async () => {
    await mount();
    key(tab(N), "F10", { shiftKey: true });
    const open = menu()!;
    expect(open.getAttribute("aria-label")).toBe("Night Owls");
    expect(open.style.left).toBe("10px");
    expect(open.style.top).toBe("70px");
    expect(open.querySelector('[data-testid="rail-move-left"]')).not.toBeNull();
  });

  it("a render destroys the previous render owner: its signal is aborted, a replaced tab's Shift+F10 opens nothing and the new tab's opens its menu", async () => {
    await mount();
    const old = tab(N);
    ctl.redraw();
    expect(old.isConnected).toBe(false);
    key(old, "F10", { shiftKey: true });
    expect(menu()).toBeNull();
    key(tab(N), "ContextMenu");
    expect(menu()).not.toBeNull();
  });

  it("a render deferred while a menu is open keeps the opener's Shift+F10 listener live until the menu closes", async () => {
    await mount();
    const opener = tab(N);
    rightClick(opener);
    ctl.redraw();
    expect(tab(N)).toBe(opener);
    key(opener, "F10", { shiftKey: true });
    expect(menus()).toBe(1);
    escape();
    await settle();
    expect(opener.isConnected).toBe(false);
    key(opener, "F10", { shiftKey: true });
    expect(menu()).toBeNull();
  });

  it("destroy aborts the current render owner", async () => {
    await mount();
    const target = tab(N);
    tabs.destroy();
    key(target, "F10", { shiftKey: true });
    expect(menu()).toBeNull();
  });
});

describe("folder dropdown", () => {
  it("the folder dropdown opens on click, Enter and ArrowDown, sets aria-expanded and closes on Escape with focus back", async () => {
    await mount();
    const open: Array<() => void> = [
      () => folderTab().click(),
      () => key(folderTab(), "Enter"),
      () => key(folderTab(), "ArrowDown"),
    ];
    for (const how of open) {
      how();
      expect(menu()?.dataset["testid"]).toBe("server-tab-folder-menu");
      expect(folderTab().getAttribute("aria-expanded")).toBe("true");
      expect(all('.server-tabs-menu [data-testid="server-tab-folder-item"]')).toHaveLength(2);
      escape();
      expect(menu()).toBeNull();
      expect(folderTab().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(folderTab());
      await settle();
    }
  });

  it("a dropdown row switches through the switch question once on a double click", async () => {
    await mount();
    folderTab().click();
    const target = row("server-tab-folder-item", P);
    expect(target.getAttribute("role")).toBe("menuitemradio");
    target.click();
    expect(menu()).toBeNull();
    expect(dialogs()).toBe(1);
    folderTab().click();
    row("server-tab-folder-item", P).click();
    expect(dialogs()).toBe(1);
    expect(switchServer).not.toHaveBeenCalled();
  });

  it("right-click and Shift+F10 on a dropdown row open Move up, Move down and Remove from folder", async () => {
    await mount();
    for (const how of [rightClick, (el: Element) => key(el, "F10", { shiftKey: true })]) {
      folderTab().click();
      how(row("server-tab-folder-item", P));
      expect(menus()).toBe(1);
      const ids = all(".server-tabs-menu [data-testid]").map((el) => el.dataset["testid"]);
      expect(ids).toEqual(["rail-move-up", "rail-move-down", "rail-remove-from-folder"]);
      escape();
      await settle();
    }
  });

  it("Folder options opens the folder menu without Expand or Collapse", async () => {
    await mount();
    folderTab().click();
    row("server-tab-folder-options").click();
    expect(menus()).toBe(1);
    expect(menu()?.getAttribute("aria-label")).toBe("Work");
    const labels = all(".server-tabs-menu [role^='menuitem']").map((el) => el.textContent);
    expect(labels).not.toContain(serverRailText("expand"));
    expect(labels).not.toContain(serverRailText("collapse"));
    expect(q('.server-tabs-menu [data-testid="rail-rename-folder"]')).not.toBeNull();
    expect(q('.server-tabs-menu [data-testid="rail-move-left"]')).not.toBeNull();
    expect(folderTab().getAttribute("aria-expanded")).toBe("true");
  });

  it("a switch from a dropdown row keeps the folder tab as the last opener", async () => {
    await mount();
    folderTab().click();
    row("server-tab-folder-item", R).click();
    expect(tabs.focusFallback()).toBe(folderTab());
  });

  it("a tab click focuses the tab before the switch question opens", async () => {
    await mount();
    const seen: boolean[] = [];
    tab(N).addEventListener("focus", () => seen.push(dialogs() > 0));
    tab(N).click();
    expect(seen[0]).toBe(false);
    expect(dialogs()).toBe(1);
    q<HTMLElement>('[data-testid="server-switch-cancel"]')!.click();
    expect(document.activeElement).toBe(tab(N));
  });
});

describe("+N and Servers", () => {
  it("the +N menu lists the hidden items in order; a folder is a heading row followed by a group of its members, and the arrow keys walk both", async () => {
    await mount(LAYOUT, widthFor(2));
    expect(more().hidden).toBe(false);
    expect(more().textContent).toBe("+2");
    expect(nameOf(more())).toBe(serverRailText("moreTabs", { count: 2 }));
    more().click();
    const open = menu()!;
    expect(open.dataset["testid"]).toBe("server-tabs-more-menu");
    const kids = Array.from(open.children) as HTMLElement[];
    expect(kids.map((k) => k.dataset["testid"] ?? k.getAttribute("role"))).toEqual([
      "server-tab-menu-folder",
      "group",
      "server-tab-menu-server",
    ]);
    const group = kids[1]!;
    expect(group.getAttribute("aria-labelledby")).toBe(kids[0]!.id);
    expect(Array.from(group.children).map((c) => (c as HTMLElement).dataset["host"])).toEqual([
      P,
      R,
    ]);
    kids[0]!.focus();
    const walk: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) {
      key(document.activeElement!, "ArrowDown");
      walk.push((document.activeElement as HTMLElement).dataset["host"]);
    }
    expect(walk).toEqual([P, R, S]);
    expect(open.querySelector(".menu-item-icon")).toBeNull();
  });

  it("Enter and right-click on a folder heading open the folder menu", async () => {
    await mount(LAYOUT, widthFor(2));
    for (const how of [(el: HTMLElement) => el.click(), rightClick]) {
      more().click();
      how(row("server-tab-menu-folder"));
      expect(menus()).toBe(1);
      expect(menu()?.getAttribute("aria-label")).toBe("Work");
      expect(q('.server-tabs-menu [data-testid="rail-move-to-start"]')).not.toBeNull();
      expect(q('.server-tabs-menu [data-testid="rail-move-left"]')).not.toBeNull();
      escape();
      await settle();
    }
  });

  it("a menu opened from a +N row inherits +N as opener: a folder heading's menu then Escape returns focus to +N", async () => {
    await mount(LAYOUT, widthFor(2));
    more().click();
    row("server-tab-menu-folder").click();
    expect(more().getAttribute("aria-expanded")).toBe("true");
    escape();
    expect(document.activeElement).toBe(more());
    expect(more().getAttribute("aria-expanded")).toBe("false");
  });

  it("+N stays shown while its menu is open even when the data change leaves nothing hidden", async () => {
    await mount(LAYOUT, widthFor(2));
    more().click();
    resize(1000);
    ctl.redraw();
    expect(more().hidden).toBe(false);
    expect(folderTab().hidden).toBe(true);
    escape();
    await settle();
    expect(more().hidden).toBe(true);
    expect(folderTab().hidden).toBe(false);
  });

  it("the Servers menu lists every item with folders inline, then Add and Join", async () => {
    await mount();
    fold = true;
    tabs.servers.click();
    const open = menu()!;
    expect(open.dataset["testid"]).toBe("deck-servers-menu");
    expect(open.getAttribute("aria-label")).toBe("Servers");
    const ids = Array.from(open.children, (k) => {
      const el = k as HTMLElement;
      return el.dataset["host"] ?? el.dataset["testid"] ?? el.getAttribute("role");
    });
    expect(ids).toEqual([
      H,
      N,
      "server-tab-menu-folder",
      "group",
      S,
      "separator",
      "server-tabs-add-server",
      "server-tabs-join",
    ]);
    expect(tabs.servers.getAttribute("aria-expanded")).toBe("true");
    expect(open.querySelector(".menu-item-icon")).toBeNull();
  });

  it("each Servers menu row opens its menu with axis y, Move to {folder} on a loose server and no Move to start", async () => {
    await mount();
    fold = true;
    tabs.servers.click();
    rightClick(row("server-tab-menu-server", N));
    const ids = all(".server-tabs-menu [data-testid]").map((el) => el.dataset["testid"]);
    expect(ids).toEqual(["rail-move-up", "rail-move-down", "rail-move-to-folder-0"]);
    escape();
    await settle();
    tabs.servers.click();
    rightClick(row("server-tab-menu-folder"));
    const labels = all(".server-tabs-menu [role^='menuitem']").map((el) => el.textContent);
    expect(labels).toContain(serverRailText("moveUp"));
    expect(labels).not.toContain(serverRailText("moveLeft"));
    expect(q('.server-tabs-menu [data-testid="rail-move-to-start"]')).toBeNull();
    escape();
    await settle();
    tabs.servers.click();
    rightClick(row("server-tab-folder-item", P));
    expect(all(".server-tabs-menu [data-testid]").map((el) => el.dataset["testid"])).toEqual([
      "rail-move-up",
      "rail-move-down",
      "rail-remove-from-folder",
    ]);
  });
});

describe("the busy state", () => {
  it("while a menu is open, render and fit leave the track untouched (same elements, nothing hidden or shown, aria-expanded stays true)", async () => {
    await mount(LAYOUT, widthFor(2));
    const before = trackCells();
    const hidden = before.map((c) => c.hidden);
    more().click();
    resize(1000);
    ctl.redraw();
    tabs.render();
    expect(trackCells()).toEqual(before);
    expect(trackCells().map((c) => c.hidden)).toEqual(hidden);
    expect(more().getAttribute("aria-expanded")).toBe("true");
  });

  it("after the menu closes the pending work runs once, a render when any render was asked", async () => {
    await mount();
    const layout = vi.spyOn(ctl, "layout");
    folderTab().click();
    tabs.fit();
    ctl.redraw();
    tabs.fit();
    expect(layout).not.toHaveBeenCalled();
    escape();
    expect(layout).not.toHaveBeenCalled();
    await settle();
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it("Escape from a folder dropdown returns focus to the folder tab before the deferred flush runs", async () => {
    await mount();
    const old = folderTab();
    old.click();
    ctl.redraw();
    escape();
    expect(document.activeElement).toBe(old);
    expect(old.isConnected).toBe(true);
    await settle();
    expect(old.isConnected).toBe(false);
    expect(document.activeElement).toBe(folderTab());
  });

  it("when the deferred flush hides the tab focus returned to, focus moves to +N", async () => {
    await mount();
    folderTab().click();
    resize(widthFor(2));
    escape();
    expect(document.activeElement).toBe(folderTab());
    await settle();
    expect(folderTab().hidden).toBe(true);
    expect(document.activeElement).toBe(more());
  });

  it("when the flush after the +N menu hides +N, focus moves to the row's Tab stop", async () => {
    await mount(LAYOUT, widthFor(2));
    more().click();
    resize(1000);
    escape();
    expect(document.activeElement).toBe(more());
    await settle();
    expect(more().hidden).toBe(true);
    expect(document.activeElement).toBe(tab(H));
    expect(tab(H).getAttribute("tabindex")).toBe("0");
  });

  it("a member's menu opened from the dropdown supersedes it: the new menu holds the slot with the folder tab as opener, aria-expanded stays true, and the old onClosed neither clears the slot nor flushes", async () => {
    await mount();
    folderTab().click();
    const layout = vi.spyOn(ctl, "layout");
    ctl.redraw();
    rightClick(row("server-tab-folder-item", P));
    expect(menus()).toBe(1);
    expect(menu()?.getAttribute("aria-label")).toBe("Pixel Forge");
    expect(folderTab().getAttribute("aria-expanded")).toBe("true");
    await settle();
    expect(layout).not.toHaveBeenCalled();
    escape();
    expect(document.activeElement).toBe(folderTab());
    await settle();
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it("opening another tab's menu over an open one resets the old opener's aria-expanded and sets the new one", async () => {
    await mount();
    folderTab().click();
    add().click();
    expect(menus()).toBe(1);
    expect(folderTab().getAttribute("aria-expanded")).toBe("false");
    expect(add().getAttribute("aria-expanded")).toBe("true");
    expect(all(".server-tabs-menu [data-testid]").map((el) => el.dataset["testid"])).toEqual([
      "server-tabs-add-server",
      "server-tabs-join",
    ]);
  });

  it("the opener is focused before its menu opens, unless the menu opens from a menu row", async () => {
    await mount();
    const atFocus: boolean[] = [];
    folderTab().addEventListener("focus", () => atFocus.push(menu() !== null));
    folderTab().click();
    expect(atFocus).toEqual([false]);
    // From a row: the dropdown closes first and gives focus back; the renderer does not focus.
    (document.activeElement as HTMLElement | null)?.blur();
    const dropdown = menu()!;
    const seen: boolean[] = [];
    folderTab().addEventListener("focus", () => seen.push(dropdown.isConnected));
    rightClick(row("server-tab-folder-item", P));
    expect(seen.every((connected) => !connected)).toBe(true);
  });

  it("a flush queued before destroy does nothing", async () => {
    await mount();
    folderTab().click();
    ctl.redraw();
    escape();
    const layout = vi.spyOn(ctl, "layout");
    const cells = trackCells();
    tabs.destroy();
    await settle();
    expect(layout).not.toHaveBeenCalled();
    expect(trackCells()).toEqual(cells);
  });

  it("after destroy, render, fit, closeMenu and a queued flush do nothing", async () => {
    await mount();
    const cells = trackCells();
    const layout = vi.spyOn(ctl, "layout");
    tabs.destroy();
    tabs.render();
    resize(widthFor(1));
    tabs.closeMenu();
    await settle();
    expect(layout).not.toHaveBeenCalled();
    expect(trackCells()).toEqual(cells);
    expect(cells.every((c) => c === more() || !c.hidden)).toBe(true);
    expect(tabs.focusFallback()).toBeNull();
    folderTab().click();
    expect(menu()).toBeNull();
  });
});

describe("focus rescue", () => {
  it("a window resize into the fold closes the menu and focuses the Servers button", async () => {
    await mount();
    folderTab().click();
    fold = true;
    tabs.closeMenu();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(tabs.servers);
  });

  it("a resize into the fold with focus on a tab and no menu open moves focus to the Servers button", async () => {
    await mount();
    tab(N).focus();
    fold = true;
    tabs.closeMenu();
    expect(document.activeElement).toBe(tabs.servers);
  });

  it("leaving the fold with the Servers menu open moves focus to the row's Tab stop", async () => {
    await mount();
    fold = true;
    tabs.servers.click();
    expect(menu()).not.toBeNull();
    fold = false;
    tabs.closeMenu();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(tab(H));
  });

  it("a render or fit does not move focus that was outside the tabs", async () => {
    await mount();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    fold = true;
    ctl.redraw();
    tabs.fit();
    tabs.closeMenu();
    expect(document.activeElement).toBe(outside);
  });

  it("focusFallback returns the last opener's new cell after a render, else +N, else the row's Tab stop, else the Servers button in the fold", async () => {
    await mount();
    tab(N).click();
    q<HTMLElement>('[data-testid="server-switch-cancel"]')!.click();
    ctl.redraw();
    expect(tabs.focusFallback()).toBe(tab(N));
    resize(widthFor(1));
    expect(tab(N).hidden).toBe(true);
    expect(tabs.focusFallback()).toBe(more());

    resize(1000);
    folderTab().click();
    escape();
    await settle();
    ctl.mutations.commit(ungroupFolder(ctl.mutations.reconciled(), "f1"));
    expect(q('[data-testid="server-tab-folder"]')).toBeNull();
    expect(tabs.focusFallback()).toBe(tab(H));

    fold = true;
    expect(tabs.focusFallback()).toBe(tabs.servers);
  });

  it("inside the fold, focusFallback skips the tab and +N and returns the Servers button", async () => {
    await mount(LAYOUT, widthFor(2));
    tab(N).click();
    q<HTMLElement>('[data-testid="server-switch-cancel"]')!.click();
    expect(more().hidden).toBe(false);
    fold = true;
    expect(tabs.focusFallback()).toBe(tabs.servers);
  });
});

describe("the Tab stop", () => {
  const stops = (): HTMLElement[] => trackCells().filter((c) => c.getAttribute("tabindex") === "0");

  it("a redraw with focus on a non-current tab keeps the Tab stop on that tab alone", async () => {
    await mount();
    tab(H).focus();
    key(tab(H), "ArrowRight");
    expect(document.activeElement).toBe(tab(N));
    ctl.redraw();
    expect(document.activeElement).toBe(tab(N));
    expect(stops()).toEqual([tab(N)]);
    tabs.fit();
    expect(stops()).toEqual([tab(N)]);
  });

  it("a fit that hides the Tab stop's cell, or +N, takes the stop off it", async () => {
    await mount();
    tab(H).focus();
    key(tab(H), "End");
    expect(stops()).toEqual([tab(S)]);
    tab(S).blur();
    resize(widthFor(2));
    expect(tab(S).hidden).toBe(true);
    expect(tab(S).getAttribute("tabindex")).toBe("-1");
    expect(stops()).toHaveLength(1);
    expect(stops()[0]!.hidden).toBe(false);

    more().focus();
    key(more(), "End");
    expect(stops()).toEqual([more()]);
    more().blur();
    resize(1000);
    expect(more().hidden).toBe(true);
    expect(more().getAttribute("tabindex")).toBe("-1");
    expect(stops()).toHaveLength(1);
    expect(stops()[0]!.hidden).toBe(false);
  });

  it("a menu that throws while opening holds nothing: the opener collapses, the error reaches the caller and the deferred render still runs", async () => {
    await mount();
    folderTab().click();
    ctl.redraw();
    const layout = vi.spyOn(ctl, "layout");
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    const boom = new Error("boom");
    vi.spyOn(document.body, "appendChild").mockImplementationOnce(() => {
      throw boom;
    });
    add().click();
    window.removeEventListener("error", onError);
    expect(errors).toEqual([boom]);
    expect(add().getAttribute("aria-expanded")).toBe("false");
    expect(folderTab().getAttribute("aria-expanded")).toBe("false");
    await settle();
    expect(layout).toHaveBeenCalledTimes(1);
    // Nothing holds the slot: a fit runs at once.
    resize(widthFor(2));
    expect(more().hidden).toBe(false);
  });
});

describe("drag", () => {
  // jsdom has no DragEvent: a MouseEvent with a clientX stands in. Every tab's
  // rect is (10, 40, 100, 30), so x 15 is "before", 60 "into" and 95 "after".
  function dragAt(el: Element, type: string, clientX = 60): void {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
  }

  const track = (): HTMLElement => q(".server-tabs-track") ?? fail("no track");
  const storedLayout = (): unknown => JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "null");
  const order = (): Array<string | undefined> =>
    all(".server-tabs-track > .server-tab:not(.server-tabs-more)").map(
      (el) => el.dataset["host"] ?? el.dataset["folderId"],
    );

  it('a render asked for during a drag, then a "before" drop, commits before and makes no folder', async () => {
    await mount();
    dragAt(tab(S), "dragstart");
    ctl.redraw();
    dragAt(tab(N), "dragover", 15);
    expect(tab(N).classList.contains("drop-before")).toBe(true);
    dragAt(tab(N), "drop", 15);
    expect(order()).toEqual([H, S, N, "f1"]);
    expect(storedLayout()).toEqual([
      { kind: "server", host: H },
      { kind: "server", host: S },
      { kind: "server", host: N },
      { ...WORK, hosts: [P, R] },
    ]);
    expect(all('[data-testid="server-tab-folder"]')).toHaveLength(1);
    expect(all(".drop-before, .drop-after, .drop-into")).toHaveLength(0);
  });

  it("a drop that commits nothing, with a render pending, renders nothing until dragend and then once", async () => {
    await mount();
    const layout = vi.spyOn(ctl, "layout");
    const before = trackCells();
    dragAt(tab(N), "dragstart");
    ctl.redraw();
    dragAt(tab(N), "dragover", 60);
    dragAt(tab(N), "drop", 60);
    await settle();
    expect(layout).not.toHaveBeenCalled();
    expect(trackCells()).toEqual(before);
    trackCells().forEach((el, i) => expect(el).toBe(before[i]));

    dragAt(tab(N), "dragend");
    await settle();
    expect(layout).toHaveBeenCalledTimes(1);
    expect(trackCells()[0]).not.toBe(before[0]);
    await settle();
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it("a capture-phase drop queues no flush: after the drop and its microtasks the track is the same elements", async () => {
    await mount();
    const before = trackCells();
    dragAt(tab(N), "dragstart");
    ctl.redraw();
    // In the gap between two tabs: the track gets the drop, the nav catches it.
    dragAt(track(), "dragover");
    dragAt(track(), "drop");
    await settle();
    trackCells().forEach((el, i) => expect(el).toBe(before[i]));
    expect(trackCells()).toHaveLength(before.length);
  });

  it("a committed drop renders at once and a later flush does not render again", async () => {
    await mount();
    dragAt(tab(S), "dragstart");
    ctl.redraw();
    const layout = vi.spyOn(ctl, "layout");
    dragAt(tab(N), "drop", 95);
    expect(order()).toEqual([H, N, S, "f1"]);
    const calls = layout.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const after = trackCells();
    // A stray dragend (the source tab was replaced, so none arrives) still flushes.
    dragAt(track(), "dragend");
    await settle();
    expect(layout).toHaveBeenCalledTimes(calls);
    trackCells().forEach((el, i) => expect(el).toBe(after[i]));
  });
});

describe("drag markers and +N", () => {
  function fireDrag(el: Element, type: string, clientX = 60): void {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
  }
  const markers = (): number => all(".drop-before, .drop-after, .drop-into").length;

  it("a drag that ends in the gap or with dragend leaves no drop marker", async () => {
    await mount();
    const track = q(".server-tabs-track") ?? fail("no track");
    fireDrag(tab(S), "dragstart");
    fireDrag(tab(N), "dragover", 15);
    expect(markers()).toBe(1);
    fireDrag(track, "dragover");
    fireDrag(track, "drop");
    expect(markers()).toBe(0);
    fireDrag(tab(S), "dragend");

    fireDrag(tab(S), "dragstart");
    fireDrag(tab(N), "dragover", 95);
    expect(markers()).toBe(1);
    fireDrag(tab(S), "dragend");
    expect(markers()).toBe(0);
  });

  it("a drop on +N after two renders commits once and moves the item last", async () => {
    await mount(LAYOUT, widthFor(2));
    ctl.redraw();
    ctl.redraw();
    await settle();
    const commit = vi.spyOn(ctl.mutations, "commit");
    fireDrag(tab(N), "dragstart");
    fireDrag(more(), "dragover", 30);
    expect(more().classList.contains("drop-after")).toBe(true);
    fireDrag(more(), "drop", 30);
    expect(commit).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "[]") as unknown[];
    expect(stored.at(-1)).toEqual({ kind: "server", host: N });
  });
});
