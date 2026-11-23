/**
 * Sidebar build step: the server header (drawn by features/server-header), its
 * server menu, the collapsed-category state, then the content slot.
 */
import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { migrateCollapsedToCategoryIds } from "../../../features/channels/collapsedMigration";
import { createServerHeader } from "../../../features/server-header/serverHeader";
import { attachServerMenu } from "../ServerMenu";
import { createInviteManagerController } from "../OverlayManagers";
import { markAllRead } from "@lib/readState";
import { loadCollapsedCategories, openSettings } from "@stores/ui.store";
import { channelsStore, NO_CATEGORY } from "@stores/channels.store";
import type { SidebarScope } from "./sidebarScope";

export function mountServerHeader(sc: SidebarScope): void {
  sc.sidebarWrapper = createElement("div", {
    class: "unified-sidebar",
    id: "unified-sidebar",
    "data-testid": "unified-sidebar",
  });

  sc.headerInviteCtrl = createInviteManagerController({ api: sc.api, getRoot: sc.getRoot });
  sc.unsubscribers.push(() => {
    sc.headerInviteCtrl.cleanup();
  });

  const header = createServerHeader({
    api: sc.api,
    getToast: sc.getToast,
    destinations: sc.opts.destinations,
    onOpenView: sc.opts.onOpenView,
    openInvite: () => {
      void sc.headerInviteCtrl.open();
    },
  });
  sc.serverHeader = header.element;
  sc.openAdmin = header.openAdmin;
  sc.unsubscribers.push(header.destroy);
  sc.sidebarWrapper.appendChild(sc.serverHeader);

  // The server menu. Its rows are decided each time it opens (ServerMenu.ts).
  sc.serverMenuOwner = new Disposable();
  sc.unsubscribers.push(() => sc.serverMenuOwner.destroy());
  attachServerMenu(
    header.menuAnchor,
    {
      onInvite: () => {
        void sc.headerInviteCtrl.open();
      },
      onMarkRead: () => markAllRead({ includeDms: false }),
      onNotificationSettings: () => openSettings("Notifications"), // i18n-exempt: settings tab id, not copy
      onCreateChannel: () => sc.openCreateChannelModal(NO_CATEGORY),
      onCreateCategory: () => sc.categoryDialogs.create(),
      onServerSettings: () => sc.openAdmin(),
    },
    sc.serverMenuOwner.signal,
  );

  // Load per-server collapsed category state from localStorage, scoped to
  // the connected host (not the display name) — the same convention as
  // setChannelMutesHost/setAudioVolumeHost. The display name
  // defaults to "OwnCord Server" on every unmodified install, so keying on
  // it would collapse two different servers' saved state onto one entry.
  loadCollapsedCategories(sc.api.getConfig().host);

  // Collapsed state saved under a category NAME (the older key) moves to the id
  // key once the channel list says which name is which id. Done at once when
  // the list is already here, else on the first channels write that fills it.
  if (!migrateCollapsedToCategoryIds()) {
    const unsubscribeTranslate = channelsStore.subscribeSelector(
      (s) => s.channels,
      () => {
        if (migrateCollapsedToCategoryIds()) unsubscribeTranslate();
      },
    );
    sc.unsubscribers.push(unsubscribeTranslate);
  }

  // ---------------------------------------------------------------------------
  // Switchable content slot
  // ---------------------------------------------------------------------------

  sc.contentSlot = createElement("div", { class: "sidebar-content" });

  sc.sidebarWrapper.appendChild(sc.contentSlot);
}
