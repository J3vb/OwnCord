/**
 * ServerRail — the compact-squircle column left of the sidebar: Home, the saved
 * servers (loose or in folders), Add a server and Join with an invite link.
 * The client holds one connection, so clicking another server runs the shared
 * server switch; the rail never shows state for servers it is not connected to.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { showContextMenu, type ContextMenuItem } from "@lib/context-menu";
import { createPromptModal } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
import type { ServerProfile } from "@lib/profiles";
import {
  FOLDER_COLORS,
  FOLDER_NAME_MAX,
  folderOf,
  groupServers,
  groupWithNext,
  loadLayout,
  moveItem,
  moveOutOfFolder,
  moveServer,
  reconcile,
  renameFolder,
  saveLayout,
  serverInitials,
  setFolderColor,
  shiftItem,
  toggleCollapsed,
  ungroupFolder,
  type ItemRef,
  type RailItem,
  type RailLayout,
} from "@lib/serverRailLayout";
import { setSidebarMode, uiStore } from "@stores/ui.store";
import { dmDisplayName, dmStore, type DmChannel } from "@stores/dm.store";
import { CHANNEL_MUTE_CHANGED } from "@lib/channel-mutes";
import { dmUnreadCount, totalDmUnread } from "@lib/dmUnread";
import { createAvatarElement, pickAvatarColor } from "./message-list/avatar";
import { formatBadgeCount } from "@lib/formatting";
import { serverRailText } from "../i18n/serverRail";
import { openServerRailJoinModal } from "./ServerRailJoinModal";

export interface ServerRailOptions {
  /** `api.getConfig().host`: the server this session is connected to. */
  readonly currentHost: string;
  /** The connected server's display name (may be empty before it is known). */
  readonly currentName: string;
  readonly loadServers: () => Promise<readonly ServerProfile[]>;
  readonly switchServer: (host: string) => void;
  readonly addServer: () => void;
  /** Whether pasted text is a usable invite; when true it has been handed on. */
  readonly joinInvite: (text: string) => boolean;
  readonly newFolderId?: () => string;
  /** Open a DM from its icon under Home. */
  readonly onOpenDm?: (dm: DmChannel) => void;
}

type DropZone = "before" | "after" | "into";

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide paths, kept here rather than in lib/icons so they stay out of the
// startup closure (lib/icons is imported eagerly).
const RAIL_ICON_PATHS = {
  plus: ["M5 12h14", "M12 5v14"],
  compass: [
    "M22 12a10 10 0 1 1-20 0a10 10 0 0 1 20 0z",
    "m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z",
  ],
  folder: [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ],
} as const;

function railIcon(name: keyof typeof RAIL_ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [
    ["viewBox", "0 0 24 24"],
    ["width", "24"],
    ["height", "24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["aria-hidden", "true"],
    ["data-icon", name],
  ] as const) {
    svg.setAttribute(k, v);
  }
  svg.classList.add("icon");
  for (const d of RAIL_ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const FALLBACK_COLOR = "var(--accent)";
const COLOR_NAME_KEYS = [
  "color.blurple",
  "color.green",
  "color.amber",
  "color.red",
  "color.pink",
  "color.grey",
] as const;

function defaultFolderId(): string {
  return `f-${globalThis.crypto.randomUUID()}`;
}

function atDmMode(): boolean {
  return uiStore.getState().sidebarMode === "dms";
}

function zoneOf(e: DragEvent, el: HTMLElement, allowInto: boolean): DropZone {
  const rect = el.getBoundingClientRect();
  if (rect.height === 0) return allowInto ? "into" : "after";
  const y = (e.clientY - rect.top) / rect.height;
  if (allowInto) {
    if (y < 0.25) return "before";
    if (y > 0.75) return "after";
    return "into";
  }
  return y < 0.5 ? "before" : "after";
}

function sameItem(a: ItemRef, b: ItemRef): boolean {
  if (a.kind === "server" && b.kind === "server") return a.host === b.host;
  if (a.kind === "folder" && b.kind === "folder") return a.id === b.id;
  return false;
}

function roundButton(
  cls: string,
  testId: string,
  label: string,
  icon: "plus" | "compass",
  onClick: () => void,
): HTMLElement {
  const btn = createElement("button", {
    type: "button",
    class: `server-rail-btn server-rail-action ${cls}`,
    title: label,
    "aria-label": label,
    "data-testid": testId,
  });
  btn.appendChild(railIcon(icon));
  btn.addEventListener("click", onClick);
  return btn;
}

export function createServerRail(options: ServerRailOptions): MountableComponent {
  const disposable = new Disposable();
  const { signal } = disposable;
  const newFolderId = options.newFolderId ?? defaultFolderId;

  let profiles: readonly ServerProfile[] = [];
  let layout: RailLayout = loadLayout();
  // Set by the first switch/add click; the session is torn down right after,
  // so any later click on the same rail is a stale double-click.
  let leaving = false;
  let dragging: ItemRef | null = null;
  let root: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let homeBtn: HTMLButtonElement | null = null;
  let renderDms: (() => void) | null = null;

  const nav = createElement("nav", {
    class: "server-rail",
    "aria-label": serverRailText("label"),
    "data-testid": "server-rail",
  });
  root = nav;

  // --- Data ---------------------------------------------------------------

  function allHosts(): string[] {
    const hosts = profiles.map((p) => p.host);
    if (options.currentHost !== "" && !hosts.includes(options.currentHost)) {
      hosts.push(options.currentHost);
    }
    return hosts;
  }

  function reconciled(): RailLayout {
    return reconcile(layout, allHosts());
  }

  function describe(host: string): { name: string; color: string } {
    const profile = profiles.find((p) => p.host === host);
    if (profile !== undefined) {
      return { name: profile.name !== "" ? profile.name : host, color: profile.color };
    }
    const name =
      host === options.currentHost && options.currentName !== "" ? options.currentName : host;
    return { name, color: FALLBACK_COLOR };
  }

  function commit(next: RailLayout): void {
    layout = next;
    saveLayout(layout);
    render();
  }

  function isActive(host: string): boolean {
    return host === options.currentHost && !atDmMode();
  }

  // --- Actions ------------------------------------------------------------

  function activateServer(host: string): void {
    if (host === options.currentHost) {
      setSidebarMode("channels");
      return;
    }
    if (leaving) return;
    leaving = true;
    options.switchServer(host);
  }

  function addServer(): void {
    if (leaving) return;
    leaving = true;
    options.addServer();
  }

  function openJoin(): void {
    openServerRailJoinModal({ onSubmit: options.joinInvite });
  }

  function promptRename(folder: Extract<RailItem, { kind: "folder" }>): void {
    createPromptModal({
      title: serverRailText("renameFolder"),
      label: serverRailText("renameLabel"),
      initialValue: folder.name,
      maxLength: FOLDER_NAME_MAX,
      testId: "server-rail-rename-input",
      onSubmit: (value) => commit(renameFolder(reconciled(), folder.id, value)),
    });
  }

  // --- Context menus (also the keyboard route for every drag operation) ----

  function menuAt(e: MouseEvent, el: HTMLElement, items: ContextMenuItem[], label: string): void {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    showContextMenu({
      x: fromKeyboard ? rect.right : e.clientX,
      y: fromKeyboard ? rect.top : e.clientY,
      items,
      signal,
      ariaLabel: label,
      className: "server-rail-menu",
      restoreFocusTo: () => el,
    });
  }

  function serverMenu(host: string): ContextMenuItem[] {
    const current = reconciled();
    const ref: ItemRef = { kind: "server", host };
    const items: ContextMenuItem[] = [
      {
        label: serverRailText("moveUp"),
        testId: "rail-move-up",
        onClick: () => commit(shiftItem(current, ref, -1)),
      },
      {
        label: serverRailText("moveDown"),
        testId: "rail-move-down",
        onClick: () => commit(shiftItem(current, ref, 1)),
      },
    ];
    if (folderOf(current, host) !== null) {
      items.push({
        label: serverRailText("removeFromFolder"),
        testId: "rail-remove-from-folder",
        onClick: () => commit(moveOutOfFolder(current, host)),
      });
    } else {
      const index = current.findIndex((i) => i.kind === "server" && i.host === host);
      const next = current[index + 1];
      if (next !== undefined && next.kind === "server") {
        items.push({
          label: serverRailText("groupNext"),
          testId: "rail-group-next",
          onClick: () => commit(groupWithNext(current, host, newFolderId())),
        });
      }
    }
    return items;
  }

  function folderMenu(folder: Extract<RailItem, { kind: "folder" }>): ContextMenuItem[] {
    const current = reconciled();
    const ref: ItemRef = { kind: "folder", id: folder.id };
    return [
      {
        label: folder.collapsed ? serverRailText("expand") : serverRailText("collapse"),
        onClick: () => commit(toggleCollapsed(current, folder.id)),
      },
      {
        label: serverRailText("renameFolder"),
        testId: "rail-rename-folder",
        onClick: () => promptRename(folder),
      },
      {
        label: serverRailText("folderColor"),
        testId: "rail-folder-color",
        onClick: () => {},
        submenu: FOLDER_COLORS.map((color, i) => ({
          label: serverRailText(COLOR_NAME_KEYS[i] ?? "color.grey"),
          checked: folder.color === color,
          radio: true,
          testId: `rail-color-${i}`,
          onClick: () => commit(setFolderColor(current, folder.id, color)),
        })),
      },
      {
        label: serverRailText("moveUp"),
        onClick: () => commit(shiftItem(current, ref, -1)),
      },
      {
        label: serverRailText("moveDown"),
        onClick: () => commit(shiftItem(current, ref, 1)),
      },
      {
        label: serverRailText("ungroup"),
        testId: "rail-ungroup",
        onClick: () => commit(ungroupFolder(current, folder.id)),
      },
    ];
  }

  // --- Drag and drop ------------------------------------------------------

  function clearIndicators(): void {
    if (root === null) return;
    for (const el of root.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
      el.classList.remove("drop-before", "drop-after", "drop-into");
    }
  }

  function applyDrop(from: ItemRef, target: ItemRef, zone: DropZone): void {
    const current = reconciled();
    if (from.kind === "server") {
      if (target.kind === "server") {
        if (zone === "into") {
          commit(groupServers(current, from.host, target.host, newFolderId()));
        } else {
          commit(moveServer(current, from.host, { type: zone, ref: target }));
        }
      } else if (zone === "into") {
        commit(moveServer(current, from.host, { type: "into", folderId: target.id }));
      } else {
        commit(moveServer(current, from.host, { type: zone, ref: target }));
      }
      return;
    }
    // A folder only moves among the top-level items.
    let anchor: ItemRef = target;
    if (target.kind === "server") {
      const holder = folderOf(current, target.host);
      if (holder !== null) anchor = { kind: "folder", id: holder.id };
    }
    commit(moveItem(current, from, anchor, zone === "after" || zone === "into"));
  }

  function makeDraggable(el: HTMLElement, ref: ItemRef): void {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragging = ref;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", ref.kind === "server" ? ref.host : ref.id);
      }
    });
    el.addEventListener("dragend", () => {
      dragging = null;
      clearIndicators();
    });
  }

  /** Make `wrapper` a drop target for `target`; `allowInto` = centre drop joins/creates a folder. */
  function makeDropTarget(wrapper: HTMLElement, target: ItemRef, inFolder: boolean): void {
    const intoAllowed = (): boolean =>
      dragging !== null &&
      dragging.kind === "server" &&
      !(target.kind === "server" && inFolder) &&
      !(target.kind === "server" && dragging.host === target.host);
    wrapper.addEventListener("dragover", (e) => {
      if (dragging === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearIndicators();
      wrapper.classList.add(`drop-${zoneOf(e, wrapper, intoAllowed())}`);
    });
    wrapper.addEventListener("dragleave", (e) => {
      if (e.relatedTarget instanceof Node && wrapper.contains(e.relatedTarget)) return;
      wrapper.classList.remove("drop-before", "drop-after", "drop-into");
    });
    wrapper.addEventListener("drop", (e) => {
      const from = dragging;
      if (from === null) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = zoneOf(e, wrapper, intoAllowed());
      dragging = null;
      clearIndicators();
      if (from.kind === target.kind && sameItem(from, target)) return;
      applyDrop(from, target, zone);
    });
  }

  // --- Rendering ----------------------------------------------------------

  function avatar(host: string, mini: boolean): HTMLElement {
    const { name, color } = describe(host);
    const el = createElement("span", { class: mini ? "server-rail-mini" : "server-rail-avatar" });
    el.style.background = color;
    setText(el, serverInitials(name));
    return el;
  }

  function serverItem(host: string, inFolder: boolean): HTMLElement {
    const { name } = describe(host);
    const active = isActive(host);
    const isCurrent = host === options.currentHost;
    const wrapper = createElement("div", { class: "server-rail-item" });
    const label = isCurrent ? serverRailText("currentSuffix", { name }) : name;
    const btn = createElement("button", {
      type: "button",
      class: `server-rail-btn${active ? " active" : ""}`,
      title: label,
      "aria-label": label,
      "data-testid": "server-rail-server",
      "data-host": host,
    });
    if (active) btn.setAttribute("aria-current", "true");
    btn.appendChild(avatar(host, false));
    btn.addEventListener("click", () => activateServer(host));
    btn.addEventListener("contextmenu", (e) => menuAt(e, btn, serverMenu(host), name));
    const ref: ItemRef = { kind: "server", host };
    makeDraggable(btn, ref);
    makeDropTarget(wrapper, ref, inFolder);
    wrapper.appendChild(btn);
    if (active) wrapper.classList.add("active");
    return wrapper;
  }

  function folderItem(folder: Extract<RailItem, { kind: "folder" }>): HTMLElement {
    const name = folder.name !== "" ? folder.name : serverRailText("folder");
    const label = serverRailText("folderNamed", { name });
    const holdsActive = folder.hosts.some(isActive);
    const box = createElement("div", {
      class: `server-rail-folder${folder.collapsed ? " collapsed" : ""}`,
      "data-testid": "server-rail-folder",
      "data-folder-id": folder.id,
    });
    box.style.setProperty("--folder-color", folder.color);
    const head = createElement("div", { class: "server-rail-item server-rail-folder-head" });
    const btn = createElement("button", {
      type: "button",
      class: "server-rail-btn server-rail-folder-btn",
      title: label,
      "aria-label": label,
      "aria-expanded": String(!folder.collapsed),
      "data-testid": "server-rail-folder-toggle",
    });
    if (folder.collapsed) {
      const grid = createElement("span", { class: "server-rail-folder-grid" });
      for (const host of folder.hosts.slice(0, 4)) grid.appendChild(avatar(host, true));
      btn.appendChild(grid);
    } else {
      const glyph = createElement("span", { class: "server-rail-folder-glyph" });
      glyph.appendChild(railIcon("folder"));
      btn.appendChild(glyph);
    }
    btn.addEventListener("click", () => commit(toggleCollapsed(reconciled(), folder.id)));
    btn.addEventListener("contextmenu", (e) => menuAt(e, btn, folderMenu(folder), label));
    const ref: ItemRef = { kind: "folder", id: folder.id };
    makeDraggable(btn, ref);
    makeDropTarget(head, ref, false);
    head.appendChild(btn);
    if (holdsActive && folder.collapsed) head.classList.add("active");
    box.appendChild(head);
    if (!folder.collapsed) {
      for (const host of folder.hosts) box.appendChild(serverItem(host, true));
    }
    return box;
  }

  function dmItem(dm: DmChannel): HTMLElement {
    const name = dmDisplayName(dm);
    const count = dmUnreadCount(dm);
    const label = serverRailText("dmUnread", { name, count });
    const wrapper = createElement("div", { class: "server-rail-item" });
    const btn = createElement("button", {
      type: "button",
      class: "server-rail-btn server-rail-dm",
      title: name,
      "aria-label": label,
      "data-testid": "server-rail-dm",
      "data-channel-id": String(dm.channelId),
    });
    const subject = dm.isGroup
      ? { username: name, avatar: dm.icon ?? null }
      : { username: dm.recipient.username, avatar: dm.recipient.avatar };
    btn.appendChild(
      createAvatarElement(subject, {
        className: "server-rail-dm-avatar",
        background: pickAvatarColor(subject.username),
        decorative: true,
      }),
    );
    btn.addEventListener("click", () => {
      const live = dmStore.getState().channels.find((c) => c.channelId === dm.channelId);
      options.onOpenDm?.(live ?? dm);
    });
    const badge = createElement(
      "span",
      { class: "server-rail-badge", "aria-hidden": "true" },
      formatBadgeCount(count),
    );
    appendChildren(wrapper, btn, badge);
    return wrapper;
  }

  function render(): void {
    if (list === null) return;
    clearChildren(list);
    for (const item of reconciled()) {
      list.appendChild(item.kind === "server" ? serverItem(item.host, false) : folderItem(item));
    }
    const home = atDmMode();
    homeBtn?.classList.toggle("active", home);
    homeBtn?.parentElement?.classList.toggle("active", home);
    if (home) homeBtn?.setAttribute("aria-current", "true");
    else homeBtn?.removeAttribute("aria-current");
  }

  function mount(container: Element): void {
    const top = createElement("div", { class: "server-rail-top" });
    const homeWrap = createElement("div", { class: "server-rail-item" });
    homeBtn = createElement("button", {
      type: "button",
      class: "server-rail-btn server-rail-home",
      title: serverRailText("homeDirect"),
      "aria-label": serverRailText("home"),
      "data-testid": "server-rail-home",
    });
    homeBtn.appendChild(
      createElement("span", { class: "server-rail-home-mark" }, serverRailText("homeMark")),
    );
    homeBtn.addEventListener("click", () => setSidebarMode("dms"));
    // DMs live behind Home, so their unread total shows on it, and each
    // conversation with something unread gets its own icon under it.
    const homeBadge = createElement("span", {
      class: "server-rail-badge",
      "aria-hidden": "true",
      "data-testid": "server-rail-home-badge",
    });
    appendChildren(homeWrap, homeBtn, homeBadge);
    const dmList = createElement("div", { class: "server-rail-dms" });
    renderDms = (): void => {
      const channels = dmStore.getState().channels;
      const total = totalDmUnread(channels);
      homeBadge.hidden = total === 0;
      setText(homeBadge, formatBadgeCount(total));
      homeBtn?.setAttribute(
        "aria-label",
        total === 0 ? serverRailText("home") : serverRailText("homeUnread", { count: total }),
      );
      clearChildren(dmList);
      const unread = channels
        .filter((c) => dmUnreadCount(c) > 0)
        .toSorted((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      for (const dm of unread) dmList.appendChild(dmItem(dm));
    };
    top.appendChild(homeWrap);
    top.appendChild(dmList);
    top.appendChild(createElement("div", { class: "server-rail-sep", role: "presentation" }));

    list = createElement("div", { class: "server-rail-list" });
    const footer = createElement("div", { class: "server-rail-footer" });
    appendChildren(
      footer,
      roundButton("server-rail-add", "server-rail-add", serverRailText("add"), "plus", addServer),
      roundButton(
        "server-rail-join",
        "server-rail-join",
        serverRailText("join"),
        "compass",
        openJoin,
      ),
    );
    const scroll = createElement("div", { class: "server-rail-scroll" });
    appendChildren(scroll, top, list);
    appendChildren(nav, scroll, footer);
    // Drops that miss every item must not leave an indicator behind.
    nav.addEventListener("dragover", (e) => {
      if (dragging !== null) e.preventDefault();
    });
    nav.addEventListener("drop", () => {
      dragging = null;
      clearIndicators();
    });
    container.appendChild(nav);

    disposable.onStoreChange(uiStore, (s) => s.sidebarMode, render);
    disposable.onStoreChange(
      dmStore,
      (s) => s.channels,
      () => renderDms?.(),
    );
    window.addEventListener(CHANNEL_MUTE_CHANGED, () => renderDms?.(), { signal });
    render();
    renderDms?.();

    void options
      .loadServers()
      .then((loaded) => {
        if (signal.aborted) return;
        profiles = loaded;
        render();
        return;
      })
      .catch(() => {
        // loadServers resolves to [] on failure; the current server still shows.
      });
  }

  function destroy(): void {
    disposable.destroy();
    root?.remove();
    root = null;
    list = null;
    homeBtn = null;
  }

  return { mount, destroy };
}
