/**
 * Sidebar build step: the server header (name, online count, mark-all-read,
 * invite, audit and moderation buttons) and its server menu, then the content
 * slot.
 */
import { createElement, setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon } from "@lib/icons";
import { migrateCollapsedToCategoryIds } from "../../../features/channels/collapsedMigration";
import { attachServerMenu } from "../ServerMenu";
import { createInviteManagerController } from "../OverlayManagers";
import { markAllRead, unreadChannelIds } from "@lib/readState";
import { loadCollapsedCategories, openSettings } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { membersStore, getOnlineMembers } from "@stores/members.store";
import { channelsStore, NO_CATEGORY } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { openAdminPanel } from "@lib/adminPanel";
import { canManageInvites, canModerateMembers, canViewAuditLog } from "@lib/permissions";
import { trackCurrentView } from "../../../features/navigation/contentView";
import { navigationText } from "../../../i18n/navigation";
import { shellText } from "../../../i18n/shell";
import { headerAction } from "./sidebarShared";
import type { SidebarScope } from "./sidebarScope";

export function mountServerHeader(sc: SidebarScope): void {
  // ---------------------------------------------------------------------------
  // Sidebar wrapper (replaces old channel-sidebar root)
  // ---------------------------------------------------------------------------

  sc.sidebarWrapper = createElement("div", {
    class: "unified-sidebar",
    id: "unified-sidebar",
    "data-testid": "unified-sidebar",
  });

  // ---------------------------------------------------------------------------
  // Server header
  // ---------------------------------------------------------------------------

  sc.serverHeader = createElement("div", { class: "unified-sidebar-header" });

  sc.serverIcon = createElement("div", { class: "server-icon-sm" }, "OC"); // i18n-exempt: logo monogram, not copy
  sc.serverInfoCol = createElement("div", { class: "server-info" });

  // The server name is the menu's button (Discord's server menu). The text sits
  // in its own span so a rename replaces only the text, never the chevron.
  sc.serverNameEl = createElement("button", {
    type: "button",
    class: "server-name",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "data-testid": "server-name",
  });

  sc.serverNameText = createElement(
    "span",
    { class: "server-name-text" },
    authStore.getState().serverName ?? shellText("common.serverFallback"),
  );

  sc.serverNameChevron = createIcon("chevron-down", 14);

  sc.serverNameChevron.classList.add("server-name-chevron");

  sc.serverNameEl.appendChild(sc.serverNameText);

  sc.serverNameEl.appendChild(sc.serverNameChevron);

  sc.onlineCount = getOnlineMembers().length;

  sc.serverOnlineEl = createElement(
    "span",
    { class: "server-online" },
    shellText("common.online", { count: sc.onlineCount }),
  );

  sc.serverInfoCol.appendChild(sc.serverNameEl);

  sc.serverInfoCol.appendChild(sc.serverOnlineEl);

  sc.serverHeader.appendChild(sc.serverIcon);

  sc.serverHeader.appendChild(sc.serverInfoCol);

  // Invite, Audit Log and Moderation: one row of quiet icon buttons.
  sc.headerActions = createElement("div", { class: "sidebar-header-actions" });

  // Mark Server as Read: a server-wide action, so it lives in this header rather
  // than in ChannelSidebar's own header (hidden here, see sidebar.css). First in
  // the row so it appearing and disappearing does not move Invite. Shown only
  // while a server channel is unread (DMs are not part of the server and are
  // left alone); those badges live in channels.store.
  sc.markAllBtn = headerAction(
    shellText("channel.markAllRead"),
    shellText("channel.markAllRead"),
    "check",
    "mark-all-read",
  );

  sc.markAllBtn.addEventListener("click", () => {
    // A server-wide action: DMs are not part of the server, so they stay as they are.
    markAllRead({ includeDms: false });
  });

  sc.syncMarkAllBtn = (): void => {
    const show = unreadChannelIds({ includeDms: false }).length > 0;
    // Hiding the focused button would drop focus to <body>; hand it to the
    // next header action still shown (Invite, Audit Log, Moderation are each
    // permission-gated), else to the channel list's roving row, so the next
    // Tab starts nearby.
    if (!show && document.activeElement === sc.markAllBtn) {
      const next =
        [...sc.headerActions.querySelectorAll<HTMLElement>(".sidebar-header-action")].find(
          (btn) => btn !== sc.markAllBtn && btn.style.display !== "none",
        ) ??
        sc.headerActions
          .closest(".unified-sidebar")
          ?.querySelector<HTMLElement>('[data-channel-id][tabindex="0"]');
      next?.focus();
    }
    sc.markAllBtn.style.display = show ? "" : "none";
  };

  sc.syncMarkAllBtn();

  sc.headerActions.appendChild(sc.markAllBtn);

  sc.unsubscribers.push(
    channelsStore.subscribeSelector((s) => s.channels, sc.syncMarkAllBtn),
    dmStore.subscribeSelector((s) => s.channels, sc.syncMarkAllBtn),
  );

  sc.headerInviteCtrl = createInviteManagerController({ api: sc.api, getRoot: sc.getRoot });

  sc.headerInviteBtn = headerAction(
    shellText("invite.invite"),
    shellText("invite.invitePeople"),
    "user-plus",
    "invite-btn",
  );

  sc.headerInviteBtn.addEventListener("click", () => {
    void sc.headerInviteCtrl.open();
  });

  sc.headerActions.appendChild(sc.headerInviteBtn);

  sc.unsubscribers.push(() => {
    sc.headerInviteCtrl.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Audit log entry point
  // ---------------------------------------------------------------------------
  //
  // The audit log itself stays in the admin panel — it is a paginated,
  // filterable table over an endpoint this client otherwise never calls, and a
  // second implementation would be a second thing to keep correct. What belongs
  // here is the way in, for the moderators who hold VIEW_AUDIT_LOG and would
  // otherwise have to know the panel's URL by heart.
  //
  // Rendered once per mount and kept in sync with the role list: `ready` may
  // land after this header is built, and a moderator whose role only becomes
  // known then would never see the entry otherwise.
  sc.auditBtn = headerAction(
    shellText("audit.label"),
    shellText("audit.hint"),
    "scroll-text",
    "audit-log-btn",
  );

  // The Audit Log button and the server menu's Server Settings share this.
  sc.openAdmin = (section?: string): void => {
    const host = sc.api.getConfig().host ?? "";
    if (host === "") {
      sc.getToast()?.show(shellText("audit.notConnected"), "error");
      return;
    }
    void openAdminPanel(host, section).catch(() => {
      sc.getToast()?.show(shellText("audit.openFailed"), "error");
    });
  };

  sc.auditBtn.addEventListener("click", () => sc.openAdmin("audit"));

  // The Moderation Center entry: beside Audit Log, only with
  // MODERATE_MEMBERS, and only once the Moderation Center ships.
  sc.moderationBtn = null;

  if (sc.opts.destinations?.moderation !== undefined) {
    const btn = headerAction(
      navigationText("moderation.title"),
      navigationText("moderation.entryHint"),
      "shield",
      "moderation-btn",
    );
    btn.addEventListener("click", () => sc.opts.onOpenView?.("moderation", btn));
    sc.unsubscribers.push(trackCurrentView(btn, "moderation"));
    sc.moderationBtn = btn;
  }

  sc.syncAuditBtn = (): void => {
    sc.headerInviteBtn.style.display = canManageInvites() ? "" : "none";
    sc.auditBtn.style.display = canViewAuditLog() ? "" : "none";
    if (sc.moderationBtn !== null) {
      sc.moderationBtn.style.display = canModerateMembers() ? "" : "none";
    }
  };

  sc.syncAuditBtn();

  sc.headerActions.appendChild(sc.auditBtn);

  if (sc.moderationBtn !== null) sc.headerActions.appendChild(sc.moderationBtn);

  sc.serverHeader.appendChild(sc.headerActions);

  // The permission is derived from the signed-in user's role plus the role
  // list, so both have to be watched.
  sc.unsubscribers.push(
    authStore.subscribeSelector(
      (s) => `${s.user?.role ?? ""}|${s.user?.role_ids?.join(",") ?? ""}`,
      () => sc.syncAuditBtn(),
    ),
  );

  sc.unsubscribers.push(
    channelsStore.subscribeSelector(
      (s) => s.roles,
      () => sc.syncAuditBtn(),
    ),
  );

  sc.sidebarWrapper.appendChild(sc.serverHeader);

  // The server menu. Its rows are decided each time it opens (ServerMenu.ts).
  sc.serverMenuOwner = new Disposable();

  sc.unsubscribers.push(() => sc.serverMenuOwner.destroy());

  attachServerMenu(
    sc.serverNameEl,
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

  // Keep server name in sync with auth store
  sc.unsubServerName = authStore.subscribeSelector(
    (s) => s.serverName,
    (name) => {
      setText(sc.serverNameText, name ?? shellText("common.serverFallback"));
    },
  );

  sc.unsubscribers.push(sc.unsubServerName);

  // Keep online count in sync with members store
  sc.unsubOnlineCount = membersStore.subscribeSelector(
    (s) => s.members,
    () => {
      const count = getOnlineMembers().length;
      setText(sc.serverOnlineEl, shellText("common.online", { count }));
    },
  );

  sc.unsubscribers.push(sc.unsubOnlineCount);

  // ---------------------------------------------------------------------------
  // Switchable content slot
  // ---------------------------------------------------------------------------

  sc.contentSlot = createElement("div", { class: "sidebar-content" });

  sc.sidebarWrapper.appendChild(sc.contentSlot);
}
