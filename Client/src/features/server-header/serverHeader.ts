/**
 * The server header: icon, name button (the server menu's anchor), online
 * count, and the invite, Audit Log and Moderation buttons. The page wires the
 * menu and the invite controller; this module draws the header and keeps it in
 * step with the stores it reads.
 */
import { createElement, setText } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { openAdminPanel } from "@lib/adminPanel";
import { canManageInvites, canModerateMembers, canViewAuditLog } from "@lib/permissions";
import type { ApiClient } from "@lib/api";
import type { ToastContainer } from "@lib/ui/toastContainer";
import { authStore } from "@stores/auth.store";
import { membersStore, getOnlineMembers } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { trackCurrentView } from "../navigation/contentView";
import type { ContentViewId, NavigationDestinations } from "../navigation/destinations";
import { navigationText } from "../../i18n/navigation";
import { shellText } from "../../i18n/shell";

export interface ServerHeaderDeps {
  readonly api: ApiClient;
  readonly getToast: () => ToastContainer | null;
  readonly destinations?: NavigationDestinations;
  readonly onOpenView?: (id: ContentViewId, opener: HTMLElement) => void;
  readonly openInvite: () => void;
}

export interface ServerHeader {
  /** `.unified-sidebar-header`. */
  readonly element: HTMLDivElement;
  /** The server-name button: the server menu's anchor. */
  readonly menuAnchor: HTMLButtonElement;
  readonly openAdmin: (section?: string) => void;
  /** Releases every subscription the header made. */
  readonly destroy: () => void;
}

/** A server-header icon button: named by its aria-label, the title is its
 *  hover tooltip. */
export function headerAction(
  label: string,
  hint: string,
  icon: IconName,
  testId: string,
  iconSize = 16,
): HTMLButtonElement {
  const btn = createElement("button", {
    type: "button",
    class: "sidebar-header-action",
    title: hint,
    "aria-label": label,
    "data-testid": testId,
  });
  btn.appendChild(createIcon(icon, iconSize));
  return btn;
}

export function createServerHeader(deps: ServerHeaderDeps): ServerHeader {
  const unsubscribers: Array<() => void> = [];
  const element = createElement("div", { class: "unified-sidebar-header" });
  const icon = createElement("div", { class: "server-icon-sm" }, "OC"); // i18n-exempt: logo monogram, not copy
  const infoCol = createElement("div", { class: "server-info" });

  // The server name is the menu's button (Discord's server menu). The text sits
  // in its own span so a rename replaces only the text, never the chevron.
  const nameEl = createElement("button", {
    type: "button",
    class: "server-name",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "data-testid": "server-name",
  });
  const nameText = createElement(
    "span",
    { class: "server-name-text" },
    authStore.getState().serverName ?? shellText("common.serverFallback"),
  );
  const nameChevron = createIcon("chevron-down", 14);
  nameChevron.classList.add("server-name-chevron");
  nameEl.appendChild(nameText);
  nameEl.appendChild(nameChevron);

  const onlineEl = createElement(
    "span",
    { class: "server-online" },
    shellText("common.online", { count: getOnlineMembers().length }),
  );
  infoCol.appendChild(nameEl);
  infoCol.appendChild(onlineEl);
  element.appendChild(icon);
  element.appendChild(infoCol);

  // Invite, Audit Log and Moderation: one row of quiet icon buttons.
  const actions = createElement("div", { class: "sidebar-header-actions" });

  const inviteBtn = headerAction(
    shellText("invite.invite"),
    shellText("invite.invitePeople"),
    "user-plus",
    "invite-btn",
  );
  inviteBtn.addEventListener("click", () => {
    deps.openInvite();
  });
  actions.appendChild(inviteBtn);

  // The audit log itself stays in the admin panel: it is a paginated,
  // filterable table over an endpoint this client otherwise never calls, and a
  // second implementation would be a second thing to keep correct. What belongs
  // here is the way in, for the moderators who hold VIEW_AUDIT_LOG and would
  // otherwise have to know the panel's URL by heart.
  //
  // Rendered once per mount and kept in sync with the role list: `ready` may
  // land after this header is built, and a moderator whose role only becomes
  // known then would never see the entry otherwise.
  const auditBtn = headerAction(
    shellText("audit.label"),
    shellText("audit.hint"),
    "scroll-text",
    "audit-log-btn",
  );

  // The Audit Log button and the server menu's Server Settings share this.
  const openAdmin = (section?: string): void => {
    const host = deps.api.getConfig().host ?? "";
    if (host === "") {
      deps.getToast()?.show(shellText("audit.notConnected"), "error");
      return;
    }
    void openAdminPanel(host, section).catch(() => {
      deps.getToast()?.show(shellText("audit.openFailed"), "error");
    });
  };
  auditBtn.addEventListener("click", () => openAdmin("audit"));

  // The Moderation Center entry: beside Audit Log, only with
  // MODERATE_MEMBERS, and only once the Moderation Center ships.
  let moderationBtn: HTMLButtonElement | null = null;
  if (deps.destinations?.moderation !== undefined) {
    const btn = headerAction(
      navigationText("moderation.title"),
      navigationText("moderation.entryHint"),
      "shield",
      "moderation-btn",
    );
    btn.addEventListener("click", () => deps.onOpenView?.("moderation", btn));
    unsubscribers.push(trackCurrentView(btn, "moderation"));
    moderationBtn = btn;
  }

  const syncAuditBtn = (): void => {
    inviteBtn.style.display = canManageInvites() ? "" : "none";
    auditBtn.style.display = canViewAuditLog() ? "" : "none";
    if (moderationBtn !== null) {
      moderationBtn.style.display = canModerateMembers() ? "" : "none";
    }
  };
  syncAuditBtn();

  actions.appendChild(auditBtn);
  if (moderationBtn !== null) actions.appendChild(moderationBtn);
  element.appendChild(actions);

  // The permission is derived from the signed-in user's role plus the role
  // list, so both have to be watched.
  unsubscribers.push(
    authStore.subscribeSelector(
      (s) => `${s.user?.role ?? ""}|${s.user?.role_ids?.join(",") ?? ""}`,
      () => syncAuditBtn(),
    ),
    channelsStore.subscribeSelector(
      (s) => s.roles,
      () => syncAuditBtn(),
    ),
    // Keep the server name in sync with the auth store.
    authStore.subscribeSelector(
      (s) => s.serverName,
      (name) => {
        setText(nameText, name ?? shellText("common.serverFallback"));
      },
    ),
    // Keep the online count in sync with the members store.
    membersStore.subscribeSelector(
      (s) => s.members,
      () => {
        setText(onlineEl, shellText("common.online", { count: getOnlineMembers().length }));
      },
    ),
  );

  return {
    element,
    menuAnchor: nameEl,
    openAdmin,
    destroy: () => {
      for (const unsub of unsubscribers.splice(0)) unsub();
    },
  };
}
