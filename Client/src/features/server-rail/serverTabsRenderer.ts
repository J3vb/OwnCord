/**
 * Command Deck's server switcher: a row of tabs under the top bar's first row,
 * folder tabs with a dropdown, a "+N" menu for the tabs that do not fit, a "+"
 * menu, and the Servers button that takes the row's place in a short or narrow
 * window. It draws from the shared controller and hands it DOM events; it owns
 * no observer and no window listener (the mount does).
 *
 * One menu from the tabs is open at a time, in one slot. While it is open, or
 * while a tab is being dragged, the row is not rebuilt or refitted: `render`
 * and `fit` only mark themselves pending, and run once after the menu closes
 * or the drag ends, so the opener or the drop target stays the same, visible
 * element.
 */
import { Disposable } from "@lib/disposable";
import { clearChildren, createElement, setText } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/ui/a11y";
import { openMenuOnKeyboard, type OpenMenu } from "@lib/ui/contextMenu";
import type { FolderItem, ItemRef, RailItem } from "@lib/prefs/serverRailLayout";
import { serverRailText } from "../../i18n/serverRail";
import type { RailController } from "./railController";
import { createRailDrag } from "./railDrag";
import { railIcon, serverAvatar } from "./serverRailParts";
import {
  belowStart,
  chevron,
  folderLabel,
  folderName,
  openAddMenu,
  openFolderDropdown,
  openItemList,
  openItemMenu,
  serverLabel,
  type TabMenuContext,
} from "./serverTabMenus";
import { wireMoreDrop, wireTabDrag } from "./tabDrag";
import { fitTabs } from "./tabFit";

export interface ServerTabs {
  readonly nav: HTMLElement;
  readonly servers: HTMLButtonElement;
  /** Rebuilds the track's children, fits them and puts focus back by key. While busy, only marks itself pending. */
  readonly render: () => void;
  /** Re-measures and moves tabs between the row and "+N"; a no-op while the row is not shown. While busy, only marks itself pending. */
  readonly fit: () => void;
  /** Closes the open menu, if any, then moves focus to rescueTarget() if it was in the tabs and is now lost. */
  readonly closeMenu: () => void;
  /** For dialogs opened from the row: `rescueTarget()`, the last opener if shown, else "+N", else the row's Tab stop, else the Servers button. */
  readonly focusFallback: () => HTMLElement | null;
  /** Marks the renderer destroyed, closes an open menu (without `rescueFocus`), releases its own listeners (the track's roving listener). After it, every method returns at once. */
  readonly destroy: () => void;
}

/** The cells the roving Tab stop moves across: every shown tab, "+N" included. */
const CELL = ".server-tab:not([hidden])";

interface Slot {
  readonly menu: OpenMenu;
  readonly openerKey: string;
  readonly opener: HTMLElement;
}

interface Cell {
  readonly item: RailItem;
  readonly el: HTMLElement;
}

/** Laid out and not hidden: false for a hidden tab and for every cell of the folded row. */
function shown(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function menuButton(cls: string, testId: string, label: string): HTMLButtonElement {
  return createElement("button", {
    type: "button",
    class: cls,
    "aria-label": label,
    title: label,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "data-testid": testId,
  });
}

/** `aria-expanded` on an opener that declares a popup; a server tab declares none. */
function setExpanded(el: HTMLElement, expanded: boolean): void {
  if (el.hasAttribute("aria-haspopup")) el.setAttribute("aria-expanded", String(expanded));
}

/** ArrowDown on a button that opens a list opens it, as Enter does. */
function onArrowDown(el: HTMLElement, open: () => void, signal?: AbortSignal): void {
  el.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "ArrowDown" || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      open();
    },
    signal === undefined ? {} : { signal },
  );
}

export function createServerTabs(ctl: RailController): ServerTabs {
  const own = new Disposable();
  let renderOwner = new Disposable();
  let slot: Slot | null = null;
  let dragging = false;
  let pending: "none" | "fit" | "render" = "none";
  let destroyed = false;
  let lastOpenerKey: string | null = null;
  let cells: Cell[] = [];

  const servers = menuButton("deck-servers-btn", "deck-servers-btn", serverRailText("label"));
  servers.append(
    railIcon("server"),
    createElement("span", { class: "deck-servers-text" }, serverRailText("label")),
    chevron(10),
  );
  const nav = createElement("nav", {
    class: "server-tabs",
    "aria-label": serverRailText("label"),
    "data-testid": "server-tabs",
  });
  const track = createElement("div", {
    class: "server-tabs-track",
    role: "toolbar",
    "aria-label": serverRailText("tabsLabel"),
    "aria-orientation": "horizontal",
  });
  const add = menuButton("server-tabs-add", "server-tabs-add", serverRailText("addMenu"));
  add.appendChild(railIcon("plus"));
  let more = createMore();
  nav.append(track, add);

  const drag = createRailDrag(ctl.mutations);
  drag.root(nav);

  // A menu from the tabs is open, or a tab is being dragged.
  const busy = (): boolean => slot !== null || dragging;

  // --- Focus ----------------------------------------------------------------

  function elementFor(key: string | null): HTMLElement | null {
    if (key === null) return null;
    if (key === "more") return more;
    if (key === "add") return add;
    if (key === "servers") return servers;
    const [kind, ...rest] = key.split(":");
    const id = rest.join(":");
    const attr = kind === "host" ? "host" : "folderId";
    return cells.find((c) => c.el.dataset[attr] === id)?.el ?? null;
  }

  function keyOf(el: Element | null): string | null {
    if (!(el instanceof HTMLElement)) return null;
    if (el === more) return "more";
    const cell = cells.find((c) => c.el === el);
    if (cell === undefined) return null;
    return cell.item.kind === "server" ? `host:${cell.item.host}` : `folder:${cell.item.id}`;
  }

  /** Focus is in the row, in an open tabs menu, or on the Servers button. */
  function focusInTabs(): boolean {
    const active = document.activeElement;
    if (active === null) return false;
    return (
      nav.contains(active) || active === servers || slot?.menu.element.contains(active) === true
    );
  }

  function rescueTarget(): HTMLElement | null {
    const candidates = [
      elementFor(lastOpenerKey),
      more,
      track.querySelector<HTMLElement>('.server-tab:not([hidden])[tabindex="0"]'),
      servers,
    ];
    return candidates.find(shown) ?? null;
  }

  function rescueFocus(hadFocus: boolean): void {
    if (!hadFocus) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && shown(active)) return;
    rescueTarget()?.focus();
  }

  // --- Menus ----------------------------------------------------------------

  function flush(): void {
    if (destroyed || busy()) return;
    const work = pending;
    pending = "none";
    if (work === "render") render();
    else if (work === "fit") fit();
  }

  const open: TabMenuContext["open"] = (req) => {
    if (destroyed) return;
    const inherit = req.fromRow && slot !== null;
    const openerKey = inherit && slot !== null ? slot.openerKey : req.openerKey;
    const opener = inherit && slot !== null ? slot.opener : req.opener;
    // WebKit does not focus a button on a click, and the menu returns focus to
    // whatever had it when it opened.
    if (!inherit) opener.focus();
    const old = slot;
    slot = null;
    if (old !== null && old.opener !== opener) setExpanded(old.opener, false);
    lastOpenerKey = openerKey;
    let menu: OpenMenu | null = null;
    const onClosed = (): void => {
      if (slot === null || slot.menu !== menu) return;
      setExpanded(slot.opener, false);
      slot = null;
      queueMicrotask(flush);
    };
    try {
      menu = req.show(onClosed);
    } catch (err) {
      // Nothing is held: the opener is collapsed and deferred work still runs.
      setExpanded(opener, false);
      queueMicrotask(flush);
      throw err;
    }
    if (!menu.element.isConnected) {
      // Closed while opening (the switcher is ending): nothing is held.
      setExpanded(opener, false);
      queueMicrotask(flush);
      return;
    }
    slot = { menu, openerKey, opener };
    setExpanded(opener, true);
  };

  const ctx: TabMenuContext = { ctl, open, activate: (host) => ctl.activate(host) };

  // --- Cells ----------------------------------------------------------------

  function serverTab(host: string): HTMLElement {
    const { name, color } = ctl.look(host);
    const label = serverLabel(ctl, host);
    const tab = createElement("button", {
      type: "button",
      class: "server-tab",
      title: label,
      "aria-label": label,
      tabindex: "-1",
      "data-testid": "server-tab",
      "data-host": host,
    });
    if (host === ctl.currentHost) tab.setAttribute("aria-current", "page");
    tab.append(
      serverAvatar(name, color, false, ctl.icon(host)),
      createElement("span", { class: "server-tab-name" }, name),
    );
    const key = `host:${host}`;
    tab.addEventListener("click", () => {
      // WebKit does not focus a button on a click, and the switch question
      // returns focus to whatever had it.
      tab.focus();
      lastOpenerKey = key;
      ctl.activate(host);
    });
    const ref: ItemRef = { kind: "server", host };
    bindItemMenu(tab, ref, key);
    wireTabDrag(drag, tab, ref);
    return tab;
  }

  function folderTab(folder: FolderItem): HTMLElement {
    const label = folderLabel(folder, ctl.currentHost);
    const tab = menuButton("server-tab server-tab-folder", "server-tab-folder", label);
    tab.tabIndex = -1;
    tab.dataset["folderId"] = folder.id;
    if (folder.hosts.includes(ctl.currentHost)) tab.classList.add("active");
    tab.style.setProperty("--folder-color", folder.color);
    const glyph = createElement("span", { class: "server-tab-glyph", "aria-hidden": "true" });
    glyph.appendChild(railIcon("folder"));
    tab.append(
      glyph,
      createElement("span", { class: "server-tab-name" }, folderName(folder)),
      createElement("span", { class: "server-tab-count" }, String(folder.hosts.length)),
      chevron(12),
    );
    const openDropdown = (): void => openFolderDropdown(folder, tab, ctx);
    tab.addEventListener("click", openDropdown);
    onArrowDown(tab, openDropdown);
    const ref: ItemRef = { kind: "folder", id: folder.id };
    bindItemMenu(tab, ref, `folder:${folder.id}`);
    wireTabDrag(drag, tab, ref);
    return tab;
  }

  /** Right-click at the pointer; Shift+F10 and the Menu key at the tab's bottom-left. */
  function bindItemMenu(tab: HTMLElement, ref: ItemRef, key: string): void {
    const opener = { key, el: tab, fromRow: false };
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openItemMenu(ref, "row", { x: e.clientX, y: e.clientY }, opener, ctx);
    });
    openMenuOnKeyboard(
      tab,
      () => openItemMenu(ref, "row", belowStart(tab), opener, ctx),
      renderOwner.signal,
    );
  }

  function createMore(): HTMLButtonElement {
    const btn = menuButton("server-tab server-tabs-more", "server-tabs-more", "");
    btn.removeAttribute("title");
    btn.tabIndex = -1;
    btn.hidden = true;
    btn.append(createElement("span", { class: "server-tabs-more-label" }), chevron(10));
    const openList = (): void => openItemList("more", hiddenItems(), btn, ctx);
    btn.addEventListener("click", openList);
    onArrowDown(btn, openList);
    return btn;
  }

  function hiddenItems(): RailItem[] {
    return cells.filter((c) => c.el.hidden).map((c) => c.item);
  }

  function setMoreCount(count: number): void {
    const label = more.querySelector<HTMLElement>(".server-tabs-more-label");
    if (label !== null) setText(label, serverRailText("moreMark", { count }));
    more.setAttribute("aria-label", serverRailText("moreTabs", { count }));
  }

  // --- Fit ------------------------------------------------------------------

  function pinnedIndex(): number {
    const { currentHost } = ctl;
    return cells.findIndex(({ item }) =>
      item.kind === "server" ? item.host === currentHost : item.hosts.includes(currentHost),
    );
  }

  /** The width the track may take: the nav's content box minus "+" and its gap. */
  function room(): number {
    const style = getComputedStyle(nav);
    const padding = px(style.paddingLeft) + px(style.paddingRight);
    return nav.clientWidth - padding - add.getBoundingClientRect().width - px(style.columnGap);
  }

  /** One measured pass; returns "+N"'s measured width when it was too narrow for its label. */
  function fitPass(minMore: number): number | null {
    for (const { el } of cells) el.hidden = false;
    more.hidden = false;
    setMoreCount(cells.length);
    // Every read, then every write.
    const widths = cells.map(({ el }) => el.getBoundingClientRect().width);
    const moreWidth = Math.max(minMore, more.getBoundingClientRect().width);
    const gap = px(getComputedStyle(track).columnGap);
    const result = fitTabs({ widths, pinned: pinnedIndex(), room: room(), moreWidth, gap });
    cells.forEach(({ el }, i) => {
      el.hidden = result.shown[i] !== true;
      // A hidden cell must not keep the row's Tab stop.
      if (el.hidden) el.tabIndex = -1;
    });
    more.hidden = result.hidden === 0;
    if (more.hidden) more.tabIndex = -1;
    setMoreCount(result.hidden);
    if (more.hidden) return null;
    const actual = more.getBoundingClientRect().width;
    return actual > moreWidth ? actual : null;
  }

  function fitNow(): void {
    if (nav.clientWidth === 0) return;
    const wider = fitPass(0);
    if (wider !== null) fitPass(wider);
  }

  function fit(): void {
    if (destroyed) return;
    if (busy()) {
      if (pending !== "render") pending = "fit";
      return;
    }
    const hadFocus = focusInTabs();
    fitNow();
    setRovingTabindex(track, CELL);
    rescueFocus(hadFocus);
    // The Tab stop follows the cell focus landed on.
    setRovingTabindex(track, CELL);
  }

  // --- Render ---------------------------------------------------------------

  function render(): void {
    if (destroyed) return;
    if (busy()) {
      pending = "render";
      return;
    }
    // This render does the pending work, so a later flush does not repeat it.
    pending = "none";
    const hadFocus = focusInTabs();
    const focusedKey = keyOf(document.activeElement);
    renderOwner.destroy();
    renderOwner = new Disposable();
    clearChildren(track);
    const layout = ctl.layout();
    cells = layout.map((item) => ({
      item,
      el: item.kind === "server" ? serverTab(item.host) : folderTab(item),
    }));
    more = createMore();
    wireMoreDrop(drag, more, layout);
    track.append(...cells.map((c) => c.el), more);
    fitNow();
    setRovingTabindex(track, CELL);
    const back = elementFor(focusedKey);
    if (shown(back)) back.focus();
    rescueFocus(hadFocus);
    // The Tab stop follows the cell focus landed on.
    setRovingTabindex(track, CELL);
  }

  // --- Fixed controls -------------------------------------------------------

  const openServers = (): void => openItemList("servers", ctl.layout(), servers, ctx);
  servers.addEventListener("click", openServers, { signal: own.signal });
  onArrowDown(servers, openServers, own.signal);
  const openAdd = (): void => openAddMenu(add, ctx);
  add.addEventListener("click", openAdd, { signal: own.signal });
  onArrowDown(add, openAdd, own.signal);
  enableRovingNavigation(track, CELL, own.signal);

  // --- Drag -----------------------------------------------------------------
  // A drop's own handler on a tab measures that tab, so nothing may rebuild the
  // track before it runs. The capture-phase drop therefore queues nothing: a
  // microtask would run between this listener and the tab's. A drop that
  // commits renders at once, as the row is no longer busy; one that commits
  // nothing, a drop outside the window and Escape all end with `dragend`.
  own.onEvent(track, "dragstart", () => (dragging = true));
  own.onEvent(track, "drop", () => (dragging = false), { capture: true });
  own.onEvent(track, "dragend", () => {
    dragging = false;
    queueMicrotask(flush);
  });

  function closeMenu(): void {
    if (destroyed) return;
    const hadFocus = focusInTabs();
    slot?.menu.destroy();
    rescueFocus(hadFocus);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    const last = slot;
    slot = null;
    last?.menu.destroy();
    renderOwner.destroy();
    own.destroy();
  }

  return {
    nav,
    servers,
    render,
    fit,
    closeMenu,
    focusFallback: () => (destroyed ? null : rescueTarget()),
    destroy,
  };
}
