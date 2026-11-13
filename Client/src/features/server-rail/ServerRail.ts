/**
 * ServerRail — the compact-squircle column left of the sidebar: Home, the saved
 * servers (loose or in folders), Add a server and Join with an invite link.
 * The client holds one connection, so clicking another server runs the shared
 * server switch; the rail never shows state for servers it is not connected to.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { showContextMenu, type ContextMenuItem } from "@lib/ui/contextMenu";
import { createPromptModal, type ModalInstance } from "@lib/ui/modalFactory";
import type { MountableComponent } from "@lib/text/safeRender";
import type { ServerProfile } from "@lib/presence/profiles";
import {
  FOLDER_NAME_MAX,
  loadLayout,
  reconcile,
  renameFolder,
  saveLayout,
  isIpAddressName,
  serverInitials,
  toggleCollapsed,
  type ItemRef,
  type RailItem,
  type RailLayout,
} from "@lib/prefs/serverRailLayout";
import { setSidebarMode, uiStore } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { dmStore, type DmChannel } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { CHANNEL_MUTE_CHANGED } from "@lib/prefs/channelMutes";
import { dmUnreadCount, totalDmUnread } from "@lib/dmUnread";
import { formatBadgeCount } from "@lib/text/formatting";
import { serverRailText } from "../../i18n/serverRail";
import type { CountSource } from "../navigation/destinations";
import {
  atDmMode,
  defaultFolderId,
  describeServer,
  dmItem,
  homeLabel,
  railIcon,
  roundButton,
  sameItem,
  zoneOf,
  type ServerLook,
} from "./serverRailParts";
import { applyDrop, folderMenu, serverMenu, type RailMutations } from "./serverRailMenus";
import { openServerRailJoinModal } from "./ServerRailJoinModal";
import { shouldConfirmServerSwitch } from "./switchConfirmPref";
import { openServerSwitchConfirm } from "./switchConfirmDialog";

export interface ServerRailOptions {
  /** `api.getConfig().host`: the server this session is connected to. */
  readonly currentHost: string;
  readonly loadServers: () => Promise<readonly ServerProfile[]>;
  readonly switchServer: (host: string) => void;
  readonly addServer: () => void;
  /** Whether pasted text is a usable invite; when true it has been handed on. */
  readonly joinInvite: (text: string) => boolean;
  readonly newFolderId?: () => string;
  /** Back to the connected server's channels (a click on its own icon). */
  readonly onShowServer?: () => void;
  /** Open a DM from its icon under Home. */
  readonly onOpenDm?: (dm: DmChannel) => void;
  /** Message requests waiting for this account; they badge Home too. */
  readonly pendingRequests?: CountSource;
}

export function createServerRail(options: ServerRailOptions): MountableComponent {
  const disposable = new Disposable();
  const { signal } = disposable;
  const newFolderId = options.newFolderId ?? defaultFolderId;

  let profiles: readonly ServerProfile[] = [];
  // True once the saved servers were read. Until then the list is a guess, and
  // saving a layout pruned to it would forget every folder and the order.
  let serversKnown = false;
  let loading = false;
  let pendingLayout: RailLayout | null = null;
  let layout: RailLayout = loadLayout();
  // Set by the first switch/add click; the session is torn down right after,
  // so any later click on the same rail is a stale double-click.
  let leaving = false;
  let confirming = false;
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

  function describe(host: string): ServerLook {
    return describeServer(host, profiles, options.currentHost);
  }

  function commit(next: RailLayout): void {
    if (!serversKnown) {
      // Saving now could drop folders of servers the failed read did not list:
      // keep the change until the list is in.
      pendingLayout = next;
      loadProfiles();
      return;
    }
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
      if (options.onShowServer !== undefined) options.onShowServer();
      else setSidebarMode("channels");
      return;
    }
    if (leaving) return;
    if (!shouldConfirmServerSwitch()) {
      leaveFor(host);
      return;
    }
    // A second click while the question is up must not stack another.
    if (confirming) return;
    confirming = true;
    openServerSwitchConfirm({
      name: describe(host).name,
      onConfirm: () => leaveFor(host),
      onClose: () => {
        confirming = false;
      },
      signal,
    });
  }

  function leaveFor(host: string): void {
    if (leaving) return;
    leaving = true;
    options.switchServer(host);
  }

  function addServer(): void {
    if (leaving) return;
    leaving = true;
    options.addServer();
  }

  // The rail's dialogs close with it: a session that ends while one is open
  // must not leave it (and its focus trap) over the connect page.
  const openModals = new Set<ModalInstance>();
  function own(modal: ModalInstance): void {
    for (const m of openModals) if (!m.overlay.isConnected) openModals.delete(m);
    openModals.add(modal);
  }

  function openJoin(): void {
    own(openServerRailJoinModal({ onSubmit: options.joinInvite }));
  }

  function promptRename(folder: Extract<RailItem, { kind: "folder" }>): void {
    own(
      createPromptModal({
        title: serverRailText("renameFolder"),
        label: serverRailText("renameLabel"),
        initialValue: folder.name,
        maxLength: FOLDER_NAME_MAX,
        testId: "server-rail-rename-input",
        onSubmit: (value) => commit(renameFolder(reconciled(), folder.id, value)),
      }),
    );
  }

  const mutations: RailMutations = { reconciled, commit, newFolderId, promptRename };

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

  // --- Drag and drop ------------------------------------------------------

  function clearIndicators(): void {
    if (root === null) return;
    for (const el of root.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
      el.classList.remove("drop-before", "drop-after", "drop-into");
    }
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
      applyDrop(from, target, zone, mutations);
    });
  }

  // --- Rendering ----------------------------------------------------------

  function avatar(host: string, mini: boolean): HTMLElement {
    const { name, color } = describe(host);
    const el = createElement("span", { class: mini ? "server-rail-mini" : "server-rail-avatar" });
    el.style.background = color;
    if (!mini && isIpAddressName(name)) el.appendChild(railIcon("server"));
    else setText(el, serverInitials(name));
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
    btn.addEventListener("contextmenu", (e) => menuAt(e, btn, serverMenu(host, mutations), name));
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
    btn.addEventListener("contextmenu", (e) =>
      menuAt(e, btn, folderMenu(folder, mutations), label),
    );
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
    // conversation with something unread, or with your call, gets its own
    // icon under it.
    const homeBadge = createElement("span", {
      class: "server-rail-badge",
      "aria-hidden": "true",
      "data-testid": "server-rail-home-badge",
    });
    appendChildren(homeWrap, homeBtn, homeBadge);
    const dmList = createElement("div", { class: "server-rail-dms" });
    renderDms = (): void => {
      const channels = dmStore.getState().channels;
      const unread = totalDmUnread(channels);
      const requests = options.pendingRequests?.get() ?? 0;
      // One badge for everything behind Home; the name tells the two apart.
      const total = unread + requests;
      homeBadge.hidden = total === 0;
      setText(homeBadge, formatBadgeCount(total));
      homeBtn?.setAttribute("aria-label", homeLabel(unread, requests));
      clearChildren(dmList);
      // The DM whose call you are in stays first under Home until the call
      // ends, so the call is one click away from any server view.
      const callId = voiceStore.getState().currentChannelId;
      const callDm = callId === null ? undefined : channels.find((c) => c.channelId === callId);
      if (callDm !== undefined) dmList.appendChild(dmItem(callDm, true, options.onOpenDm));
      const unreadDms = channels
        .filter((c) => c !== callDm && dmUnreadCount(c) > 0)
        .toSorted((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      for (const dm of unreadDms) dmList.appendChild(dmItem(dm, false, options.onOpenDm));
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
    disposable.onStoreChange(authStore, (s) => s.serverName, render);
    disposable.onStoreChange(
      dmStore,
      (s) => s.channels,
      () => renderDms?.(),
    );
    disposable.onStoreChange(
      voiceStore,
      (s) => s.currentChannelId,
      () => renderDms?.(),
    );
    window.addEventListener(CHANNEL_MUTE_CHANGED, () => renderDms?.(), { signal });
    const unsubRequests = options.pendingRequests?.subscribe(() => renderDms?.());
    if (unsubRequests !== undefined) disposable.addCleanup(unsubRequests);
    render();
    renderDms?.();

    loadProfiles();
  }

  function loadProfiles(): void {
    if (loading || signal.aborted) return;
    loading = true;
    void options
      .loadServers()
      .then((loaded) => {
        loading = false;
        if (signal.aborted) return;
        profiles = loaded;
        serversKnown = true;
        const pending = pendingLayout;
        pendingLayout = null;
        if (pending !== null) commit(pending);
        else render();
        return;
      })
      .catch(() => {
        // The current server still shows; the saved layout stays as it was
        // and the next layout change tries the read again.
        loading = false;
      });
  }

  function destroy(): void {
    for (const modal of openModals) modal.close();
    openModals.clear();
    disposable.destroy();
    root?.remove();
    root = null;
    list = null;
    homeBtn = null;
  }

  return { mount, destroy };
}
