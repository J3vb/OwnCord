/**
 * SidebarMemberSection — the collapsible member list panel that sits below
 * channels in "channels" mode. Supports drag-to-resize and persists
 * collapsed state and height to localStorage.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { createMemberList } from "@components/MemberList";
import { parseTimestamp } from "@components/message-list/formatting";
import { authStore } from "@stores/auth.store";
import { setUserBlockedByMe } from "@stores/blocks.store";
import { getRoleIdByName } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { roleHasPermission } from "@lib/permissions";
import { Permission, type AdminUser } from "@lib/types";
import type { ApiClient } from "@lib/api";
import type { ToastContainer } from "@components/Toast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LS_KEY_HEIGHT = "owncord:member-list-height";
const LS_KEY_COLLAPSED = "owncord:member-list-collapsed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarMemberSectionOptions {
  readonly api: ApiClient;
  readonly getToast: () => ToastContainer | null;
  /** Start a DM with a user (profile popup's Message button). */
  readonly onMessageUser?: (userId: number) => void;
}

export interface SidebarMemberSectionResult {
  /** The root element to insert into the DOM. */
  readonly element: HTMLDivElement;
  /** The member list MountableComponent (for external cleanup tracking). */
  readonly memberListComponent: MountableComponent;
  /** Clean up event listeners and abort controller. */
  readonly destroy: () => void;
}

/** Whether a ban is still in force. The server never clears `banned` when a
 *  temporary ban runs out: the account is active again the moment
 *  `ban_expires` passes (auth.IsEffectivelyBanned), so the flag alone would
 *  list served bans forever. An expiry that does not parse keeps the ban in
 *  force, as it does on the server. */
function isBanInForce(user: AdminUser): boolean {
  if (!user.banned) return false;
  if (!user.ban_expires) return true;
  const expires = parseTimestamp(user.ban_expires).getTime();
  return Number.isNaN(expires) || expires > Date.now();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSidebarMemberSection(
  opts: SidebarMemberSectionOptions,
): SidebarMemberSectionResult {
  const { api, getToast, onMessageUser } = opts;
  const unsubs: Array<() => void> = [];

  // --- Container ---
  const memberListContainer = createElement("div", {
    class: "sidebar-members-section",
    "data-testid": "sidebar-members",
  });

  // --- Header ---
  const memberHeader = createElement("div", { class: "category sidebar-members-header" });
  const memberArrow = createElement("span", { class: "category-arrow" }, "\u25BC");
  const memberLabelEl = createElement("span", { class: "category-name" }, "MEMBERS");
  appendChildren(memberHeader, memberArrow, memberLabelEl);
  memberListContainer.appendChild(memberHeader);

  // --- Resize handle ---
  const resizeHandle = createElement("div", { class: "sidebar-resize-handle" });
  memberListContainer.appendChild(resizeHandle);

  // Restore saved height
  const savedHeight = localStorage.getItem(LS_KEY_HEIGHT);
  if (savedHeight !== null) {
    memberListContainer.style.height = `${savedHeight}px`;
  }

  // --- Drag-to-resize logic ---
  const resizeOwner = new Disposable();
  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  resizeHandle.addEventListener(
    "mousedown",
    (e: MouseEvent) => {
      isDragging = true;
      startY = e.clientY;
      startHeight = memberListContainer.offsetHeight;
      e.preventDefault();
    },
    { signal: resizeOwner.signal },
  );

  document.addEventListener(
    "mousemove",
    (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = startY - e.clientY;
      const maxH = window.innerHeight * 0.65;
      const newHeight = Math.max(80, Math.min(startHeight + delta, maxH));
      memberListContainer.style.height = `${newHeight}px`;
    },
    { signal: resizeOwner.signal },
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (!isDragging) return;
      isDragging = false;
      localStorage.setItem(LS_KEY_HEIGHT, String(memberListContainer.offsetHeight));
    },
    { signal: resizeOwner.signal },
  );

  unsubs.push(() => {
    resizeOwner.destroy();
  });

  // --- Collapse state ---
  const savedCollapsed = localStorage.getItem(LS_KEY_COLLAPSED);
  let membersCollapsed = savedCollapsed === "true";
  const memberContent = createElement("div", { class: "sidebar-members-content" });

  function applyMembersCollapsed(): void {
    memberHeader.classList.toggle("collapsed", membersCollapsed);
    memberArrow.textContent = membersCollapsed ? "\u25B6" : "\u25BC";
    memberContent.style.display = membersCollapsed ? "none" : "";
    resizeHandle.style.display = membersCollapsed ? "none" : "";
    if (membersCollapsed) {
      memberListContainer.style.height = "auto";
    } else {
      const h = localStorage.getItem(LS_KEY_HEIGHT);
      if (h !== null) {
        memberListContainer.style.height = `${h}px`;
      } else {
        memberListContainer.style.height = "";
      }
    }
  }

  // Apply initial state
  applyMembersCollapsed();

  memberHeader.addEventListener("click", () => {
    membersCollapsed = !membersCollapsed;
    localStorage.setItem(LS_KEY_COLLAPSED, String(membersCollapsed));
    applyMembersCollapsed();
  });

  // --- Banned members ---
  // A banned user leaves the roster outright (dispatcher's MEMBER_BAN removes
  // them), so the context menu that issued the ban is the only place they ever
  // appeared — and it is gone with the row. This list, fed by the admin users
  // page, is what makes a ban reversible from the desktop client.
  const bannedSection = createElement("div", {
    class: "sidebar-banned-section",
    "data-testid": "sidebar-banned",
  });
  let bannedUsers: readonly AdminUser[] = [];

  function renderBanned(): void {
    bannedSection.replaceChildren();
    if (bannedUsers.length === 0) {
      bannedSection.style.display = "none";
      return;
    }
    bannedSection.style.display = "";
    bannedSection.appendChild(createElement("div", { class: "banned-header" }, "BANNED"));
    for (const user of bannedUsers) {
      const row = createElement("div", { class: "banned-row" });
      row.appendChild(createElement("span", { class: "banned-name" }, user.username));
      const unbanBtn = createElement(
        "button",
        { class: "banned-unban-btn", "data-testid": "unban-member" },
        "Unban",
      );
      unbanBtn.addEventListener("click", () => {
        void unbanMember(user.id, user.username);
      });
      row.appendChild(unbanBtn);
      bannedSection.appendChild(row);
    }
  }

  /** Refetch, or give up quietly: this list is an affordance for moderators,
   *  and a toast on every mount would be noise for the majority of members,
   *  who never see the section at all. */
  async function fetchBanned(): Promise<void> {
    // Read the role live, like MemberList's menu gates do: a role change
    // arrives as a store update, and this section is not remounted for it.
    if (!roleHasPermission(authStore.getState().user?.role ?? "", Permission.BAN_MEMBERS)) {
      bannedUsers = [];
      renderBanned();
      return;
    }
    try {
      bannedUsers = (await api.adminListUsers()).filter(isBanInForce);
    } catch {
      return;
    }
    renderBanned();
  }

  // One walk of the user list at a time. A burst of roster changes would
  // otherwise start a fetch each, and an older response landing last would win;
  // a change that arrives mid-walk buys exactly one more walk after it.
  let refreshing = false;
  let refreshQueued = false;
  async function refreshBanned(): Promise<void> {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshQueued = false;
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: one walk at a time
        await fetchBanned();
      } while (refreshQueued);
    } finally {
      refreshing = false;
    }
  }

  // Another moderator's ban or unban reaches this client only as a roster
  // change: member_ban drops the row and the unban's member_join restores it.
  // roleRevision moves on exactly those (and on role and profile changes, never
  // on presence or typing), and it is monotonic, so a ban and a join batched
  // into one notification still register.
  // ponytail: every roster change re-walks the user list for a moderator; a
  // banned-only server query is the upgrade if that ever costs something.
  unsubs.push(
    membersStore.subscribeSelector(
      (state) => state.roleRevision,
      () => void refreshBanned(),
    ),
  );

  async function unbanMember(userId: number, username: string): Promise<void> {
    try {
      await api.adminUnbanMember(userId);
      getToast()?.show(`Unbanned ${username}`, "success");
      // No roster update needed: the server's member_join broadcast puts them
      // back, and that roster change refreshes this list too. Refresh anyway —
      // the REST call can succeed while the socket is down.
      await refreshBanned();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to unban member";
      getToast()?.show(msg, "error");
    }
  }

  // --- Member list component ---
  const memberList = createMemberList({
    currentUserRole: authStore.getState().user?.role ?? "member",
    ...(onMessageUser !== undefined ? { onMessageUser } : {}),
    onReportUser: (userId, name) => {
      // The dialog lives as long as this section (resizeOwner is its lifetime).
      void import("../../features/reports/openers").then(({ openUserReport }) => {
        if (!resizeOwner.signal.aborted) {
          openUserReport({ api, userId, name, signal: resizeOwner.signal });
        }
      });
    },
    // "Force Logout", not "Kick": the endpoint revokes the target's sessions
    // and nothing stops them signing back in — there is no membership to remove.
    onKick: async (userId, username) => {
      try {
        await api.adminKickMember(userId);
        getToast()?.show(`Forced ${username} to log out`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to force logout";
        getToast()?.show(msg, "error");
      }
    },
    onBan: async (userId, username, reason, durationHours) => {
      try {
        await api.adminBanMember(userId, reason, durationHours);
        getToast()?.show(
          durationHours > 0 ? `Banned ${username} for ${durationHours}h` : `Banned ${username}`,
          "success",
        );
        // The row is about to vanish from the roster; the ban has to appear
        // somewhere or it cannot be undone from here.
        await refreshBanned();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to ban member";
        getToast()?.show(msg, "error");
      }
    },
    onToggleBlock: async (userId, username, block) => {
      try {
        if (block) {
          await api.blockUser(userId);
        } else {
          await api.unblockUser(userId);
        }
        setUserBlockedByMe(userId, block);
        getToast()?.show(block ? `Blocked ${username}` : `Unblocked ${username}`, "success");
      } catch (err) {
        const fallback = block ? "Failed to block user" : "Failed to unblock user";
        const msg = err instanceof Error ? err.message : fallback;
        getToast()?.show(msg, "error");
      }
    },
    onChangeRole: async (userId, username, newRole) => {
      const roleId = getRoleIdByName(newRole);
      if (roleId === undefined) {
        // No silent failures: the role vanished from the server's list.
        getToast()?.show(`Unknown role "${newRole}" — try reconnecting`, "error");
        return;
      }
      try {
        await api.adminChangeRole(userId, roleId);
        getToast()?.show(`Changed ${username}'s role to ${newRole}`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to change role";
        getToast()?.show(msg, "error");
      }
    },
  });
  memberList.mount(memberContent);
  // Appended after MemberList's own root: its re-renders replace only the
  // inside of that root, so this sibling survives every roster change.
  memberContent.appendChild(bannedSection);
  memberListContainer.appendChild(memberContent);
  void refreshBanned();

  return {
    element: memberListContainer,
    memberListComponent: memberList,
    destroy: () => {
      for (const unsub of unsubs) {
        unsub();
      }
    },
  };
}
