/**
 * ServerRail — the compact-squircle column left of the sidebar: Home, the saved
 * servers (loose or in folders), Add a server and Join with an invite link.
 * The client holds one connection, so clicking another server runs the shared
 * server switch; the rail never shows state for servers it is not connected to.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { showContextMenu, type ContextMenuItem } from "@lib/ui/contextMenu";
import type { MountableComponent } from "@lib/text/safeRender";
import { toggleCollapsed, type FolderItem, type ItemRef } from "@lib/prefs/serverRailLayout";
import { setSidebarMode, uiStore } from "@stores/ui.store";
import { dmStore, type DmChannel } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { CHANNEL_MUTE_CHANGED } from "@lib/prefs/channelMutes";
import { dmUnreadCount, totalDmUnread } from "@lib/dmUnread";
import { formatBadgeCount } from "../messaging/formatting";
import { serverRailText } from "../../i18n/serverRail";
import type { CountSource } from "../navigation/destinations";
import {
  atDmMode,
  dmItem,
  homeLabel,
  railIcon,
  roundButton,
  serverAvatar,
} from "./serverRailParts";
import { folderMenu, serverMenu } from "./serverRailMenus";
import { createRailController, type RailControllerOptions } from "./railController";
import { createRailDrag } from "./railDrag";

export type ServerRailOptions = RailControllerOptions & {
  /** Open a DM from its icon under Home. */
  readonly onOpenDm?: (dm: DmChannel) => void;
  /** Message requests waiting for this account; they badge Home too. */
  readonly pendingRequests?: CountSource;
};

export function createServerRail(options: ServerRailOptions): MountableComponent {
  // The rail's own subscriptions; the shared ones live on the controller.
  const disposable = new Disposable();
  const ctl = createRailController(options);
  const { mutations } = ctl;
  const drag = createRailDrag(mutations);
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

  function isActive(host: string): boolean {
    return host === ctl.currentHost && !atDmMode();
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
      signal: ctl.signal,
      ariaLabel: label,
      className: "server-rail-menu",
      restoreFocusTo: () => el,
    });
  }

  // --- Rendering ----------------------------------------------------------

  function avatar(host: string, mini: boolean): HTMLElement {
    const { name, color } = ctl.look(host);
    return serverAvatar(name, color, mini, ctl.icon(host));
  }

  function serverItem(host: string, inFolder: boolean): HTMLElement {
    const { name } = ctl.look(host);
    const active = isActive(host);
    const isCurrent = host === ctl.currentHost;
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
    btn.addEventListener("click", () => ctl.activate(host));
    btn.addEventListener("contextmenu", (e) => menuAt(e, btn, serverMenu(host, mutations), name));
    const ref: ItemRef = { kind: "server", host };
    drag.source(btn, ref);
    drag.target(wrapper, ref, { inFolder });
    wrapper.appendChild(btn);
    if (active) wrapper.classList.add("active");
    return wrapper;
  }

  function folderItem(folder: FolderItem): HTMLElement {
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
    btn.addEventListener("click", () =>
      mutations.commit(toggleCollapsed(mutations.reconciled(), folder.id)),
    );
    btn.addEventListener("contextmenu", (e) =>
      menuAt(e, btn, folderMenu(folder, mutations), label),
    );
    const ref: ItemRef = { kind: "folder", id: folder.id };
    drag.source(btn, ref);
    drag.target(head, ref, { inFolder: false });
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
    for (const item of ctl.layout()) {
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
      roundButton("server-rail-add", "server-rail-add", serverRailText("add"), "plus", ctl.add),
      roundButton(
        "server-rail-join",
        "server-rail-join",
        serverRailText("join"),
        "compass",
        ctl.openJoin,
      ),
    );
    const scroll = createElement("div", { class: "server-rail-scroll" });
    appendChildren(scroll, top, list);
    appendChildren(nav, scroll, footer);
    drag.root(nav);
    container.appendChild(nav);

    ctl.start(render);
    disposable.onStoreChange(uiStore, (s) => s.sidebarMode, ctl.redraw);
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
    window.addEventListener(CHANNEL_MUTE_CHANGED, () => renderDms?.(), {
      signal: disposable.signal,
    });
    const unsubRequests = options.pendingRequests?.subscribe(() => renderDms?.());
    if (unsubRequests !== undefined) disposable.addCleanup(unsubRequests);
    renderDms?.();
  }

  function destroy(): void {
    disposable.destroy();
    ctl.destroy();
    root?.remove();
    root = null;
    list = null;
    homeBtn = null;
  }

  return { mount, destroy };
}
