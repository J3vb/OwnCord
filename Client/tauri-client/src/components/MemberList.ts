/**
 * MemberList component — shows server members grouped by role with online status.
 * Subscribes to membersStore for reactive updates.
 * Right-click context menu for admin actions (kick, ban, role change).
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { membersStore, type Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { createMemberContextMenu } from "@components/AdminActions";
import type { UserStatus } from "@lib/types";

/** Options for configuring admin action callbacks on the member list. */
export interface MemberListOptions {
  readonly currentUserRole: string;
  readonly onKick: (userId: number, username: string) => Promise<void>;
  readonly onBan: (userId: number, username: string) => Promise<void>;
  readonly onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
}

/** Ordered role groups with display names and CSS color variables. */
const ROLE_GROUPS: readonly {
  readonly role: string;
  readonly label: string;
  readonly colorVar: string;
}[] = [
  { role: "owner", label: "OWNER", colorVar: "var(--role-owner, #e74c3c)" },
  { role: "admin", label: "ADMIN", colorVar: "var(--role-admin, #f39c12)" },
  { role: "moderator", label: "MODERATOR", colorVar: "var(--role-mod, #2ecc71)" },
  { role: "member", label: "MEMBER", colorVar: "var(--role-member, #949ba4)" },
] as const;

/** Status priority for sorting: lower = higher priority (shown first). */
function statusPriority(status: UserStatus): number {
  switch (status) {
    case "online": return 0;
    case "idle": return 1;
    case "dnd": return 2;
    case "offline": return 3;
  }
}

function statusColor(status: UserStatus): string {
  switch (status) {
    case "online": return "var(--green)";
    case "idle": return "var(--yellow)";
    case "dnd": return "var(--red)";
    case "offline": return "var(--text-micro)";
  }
}

let activeMenu: { element: HTMLDivElement; destroy(): void } | null = null;

function closeActiveMenu(): void {
  if (activeMenu !== null) {
    activeMenu.destroy();
    activeMenu = null;
  }
}

function handleOutsideClick(e: MouseEvent): void {
  if (activeMenu !== null && !activeMenu.element.contains(e.target as Node)) {
    closeActiveMenu();
    document.removeEventListener("mousedown", handleOutsideClick);
  }
}

function createMemberItem(
  member: Member,
  colorVar: string,
  opts: MemberListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const item = createElement("div", {
    class: member.status === "offline" ? "member-item offline" : "member-item",
    "data-testid": `member-${member.id}`,
  });

  const initial = member.username.charAt(0).toUpperCase() || "?";
  const avatar = createElement(
    "div",
    { class: "mi-avatar", style: `background: ${colorVar}` },
    initial,
  );

  const statusDot = createElement("div", {
    class: "mi-status",
    style: `background: ${statusColor(member.status)}`,
  });
  avatar.appendChild(statusDot);

  const name = createElement(
    "span",
    { class: "mi-name", style: `color: ${colorVar}` },
  );
  setText(name, member.username);

  appendChildren(item, avatar, name);

  // Context menu for admin actions
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();

    // Don't show context menu for yourself
    const currentUserId = authStore.getState().user?.id ?? 0;
    if (member.id === currentUserId) return;

    // Only admins and owners can use admin actions
    const role = opts.currentUserRole.toLowerCase();
    if (role !== "owner" && role !== "admin") return;

    closeActiveMenu();
    document.removeEventListener("mousedown", handleOutsideClick);

    const availableRoles = ["admin", "moderator", "member"];

    activeMenu = createMemberContextMenu({
      userId: member.id,
      username: member.username,
      currentRole: member.role.toLowerCase(),
      availableRoles,
      onKick: () => opts.onKick(member.id, member.username),
      onBan: () => opts.onBan(member.id, member.username),
      onChangeRole: (newRole: string) => opts.onChangeRole(member.id, member.username, newRole),
    });

    // Position at mouse
    activeMenu.element.style.position = "fixed";
    activeMenu.element.style.left = `${e.clientX}px`;
    activeMenu.element.style.top = `${e.clientY}px`;
    activeMenu.element.style.zIndex = "1000";
    document.body.appendChild(activeMenu.element);

    // Close on outside click (deferred so this click doesn't close it)
    setTimeout(() => {
      document.addEventListener("mousedown", handleOutsideClick);
    }, 0);
  }, { signal });

  return item;
}

function renderList(root: HTMLDivElement, opts: MemberListOptions, signal: AbortSignal): void {
  clearChildren(root);

  const state = membersStore.getState();
  const allMembers = Array.from(state.members.values());

  for (const group of ROLE_GROUPS) {
    const groupMembers = allMembers
      .filter((m) => m.role.toLowerCase() === group.role)
      .sort((a, b) => statusPriority(a.status) - statusPriority(b.status));

    if (groupMembers.length === 0) continue;

    const header = createElement(
      "div",
      { class: "member-role-group" },
      `${group.label} \u2014 ${groupMembers.length}`,
    );
    root.appendChild(header);

    for (const member of groupMembers) {
      root.appendChild(createMemberItem(member, group.colorVar, opts, signal));
    }
  }
}

export function createMemberList(opts: MemberListOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", { class: "member-list", "data-testid": "member-list" });
    renderList(root, opts, disposable.signal);

    disposable.onStoreChange(
      membersStore,
      (s) => s.members,
      () => {
        if (root !== null) {
          renderList(root, opts, disposable.signal);
        }
      },
    );

    container.appendChild(root);
  }

  function destroy(): void {
    closeActiveMenu();
    document.removeEventListener("mousedown", handleOutsideClick);
    disposable.destroy();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
