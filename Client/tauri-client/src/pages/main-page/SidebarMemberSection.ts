/**
 * SidebarMemberSection — the collapsible member list panel that sits below
 * channels in "channels" mode. Supports drag-to-resize and persists
 * collapsed state and height to localStorage.
 */

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { createMemberList } from "@components/MemberList";
import { authStore } from "@stores/auth.store";
import { getRoleIdByName } from "@stores/roles.store";
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
}

export interface SidebarMemberSectionResult {
  /** The root element to insert into the DOM. */
  readonly element: HTMLDivElement;
  /** The member list MountableComponent (for external cleanup tracking). */
  readonly memberListComponent: MountableComponent;
  /** Clean up event listeners and abort controller. */
  readonly destroy: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSidebarMemberSection(opts: SidebarMemberSectionOptions): SidebarMemberSectionResult {
  const { api, getToast } = opts;
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
  const resizeAbort = new AbortController();
  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  resizeHandle.addEventListener("mousedown", (e: MouseEvent) => {
    isDragging = true;
    startY = e.clientY;
    startHeight = memberListContainer.offsetHeight;
    e.preventDefault();
  }, { signal: resizeAbort.signal });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isDragging) return;
    const delta = startY - e.clientY;
    const maxH = window.innerHeight * 0.65;
    const newHeight = Math.max(80, Math.min(startHeight + delta, maxH));
    memberListContainer.style.height = `${newHeight}px`;
  }, { signal: resizeAbort.signal });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    localStorage.setItem(LS_KEY_HEIGHT, String(memberListContainer.offsetHeight));
  }, { signal: resizeAbort.signal });

  unsubs.push(() => { resizeAbort.abort(); });

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

  // --- Member list component ---
  const memberList = createMemberList({
    currentUserRole: authStore.getState().user?.role ?? "member",
    onKick: async (userId, username) => {
      try {
        await api.adminKickMember(userId);
        getToast()?.show(`Kicked ${username}`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to kick member";
        getToast()?.show(msg, "error");
      }
    },
    onBan: async (userId, username) => {
      try {
        await api.adminBanMember(userId);
        getToast()?.show(`Banned ${username}`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to ban member";
        getToast()?.show(msg, "error");
      }
    },
    onChangeRole: async (userId, username, newRole) => {
      const roleId = getRoleIdByName(newRole);
      if (roleId === undefined) return;
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
  memberListContainer.appendChild(memberContent);

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
