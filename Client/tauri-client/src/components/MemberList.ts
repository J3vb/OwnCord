/**
 * MemberList component — shows server members grouped by role with online status.
 * Subscribes to membersStore for reactive updates.
 * Right-click context menu for admin actions (force logout, ban, role change).
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { membersStore, type Member, type MembersState } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { blocksStore } from "@stores/blocks.store";
import { channelsStore } from "@stores/channels.store";
import { createMemberContextMenu } from "@components/AdminActions";
import {
  createUserProfilePopup,
  type UserProfilePopupComponent,
} from "@components/UserProfilePopup";
import { Permission, type UserStatus } from "@lib/types";
import { roleHasPermission } from "@lib/permissions";

/** Options for configuring admin action callbacks on the member list. */
export interface MemberListOptions {
  /** Role name of the signed-in user; resolved against the server's role list
   *  to get the permission mask that gates the moderation menu items. */
  readonly currentUserRole: string;
  /** Force logout: revokes the target's sessions (KICK_MEMBERS). */
  readonly onKick: (userId: number, username: string) => Promise<void>;
  readonly onBan: (
    userId: number,
    username: string,
    reason: string,
    durationHours: number,
  ) => Promise<void>;
  readonly onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
  readonly onToggleBlock: (userId: number, username: string, block: boolean) => Promise<void>;
  /** Start a DM with a user (wires the profile popup's Message button). */
  readonly onMessageUser?: (userId: number) => void;
}

/** Roles offered in the "Change Role" submenu when the server hasn't sent any. */
const FALLBACK_ASSIGNABLE_ROLES: readonly string[] = ["admin", "moderator", "member"];

/**
 * Role names an admin can assign, taken from the server's role list. "owner" is
 * excluded — ownership transfer isn't a context-menu action.
 */
function assignableRoleNames(): readonly string[] {
  const roles = channelsStore
    .getState()
    .roles.map((r) => r.name.toLowerCase())
    .filter((name) => name !== "owner");
  return roles.length > 0 ? roles : FALLBACK_ASSIGNABLE_ROLES;
}

/** Which moderation menu items the signed-in user may see. */
interface ModerationGates {
  readonly canKick: boolean;
  readonly canBan: boolean;
  readonly canManageRoles: boolean;
}

/**
 * Menu items the signed-in user's role permits, from the permission mask the
 * server ships in `ready`. Administrator implies all three. When the role name
 * has no match in that list (pre-`ready`, or an older server that sent none)
 * the legacy owner/admin name check stands in — a mask of 0 would otherwise
 * hide moderation from every actual admin.
 */
function moderationGates(roleName: string): ModerationGates {
  return {
    canKick: roleHasPermission(roleName, Permission.KICK_MEMBERS),
    canBan: roleHasPermission(roleName, Permission.BAN_MEMBERS),
    canManageRoles: roleHasPermission(roleName, Permission.MANAGE_ROLES),
  };
}

interface RoleGroup {
  readonly role: string;
  readonly label: string;
  readonly colorVar: string;
}

/** Theme-variable fallbacks for the seeded roles (used when the server sends no color). */
const FALLBACK_ROLE_COLORS: Record<string, string> = {
  owner: "var(--role-owner, #e74c3c)",
  admin: "var(--role-admin, #f39c12)",
  moderator: "var(--role-mod, #2ecc71)",
};

const MEMBER_COLOR = "var(--role-member, #949ba4)";

/** Ordered role groups used when the server hasn't sent a role list. */
const FALLBACK_ROLE_GROUPS: readonly RoleGroup[] = [
  { role: "owner", label: "OWNER", colorVar: FALLBACK_ROLE_COLORS["owner"]! },
  { role: "admin", label: "ADMIN", colorVar: FALLBACK_ROLE_COLORS["admin"]! },
  { role: "moderator", label: "MODERATOR", colorVar: FALLBACK_ROLE_COLORS["moderator"]! },
  { role: "member", label: "MEMBER", colorVar: MEMBER_COLOR },
] as const;

/**
 * Role groups from the server's `ready` role list (already ordered by position,
 * highest first), colored by the server's role color when set. A hardcoded
 * list rendered custom roles nowhere and ignored `roles.color` entirely.
 */
function roleGroups(): readonly RoleGroup[] {
  const roles = channelsStore.getState().roles;
  if (roles.length === 0) return FALLBACK_ROLE_GROUPS;
  return roles.map((r) => {
    const key = r.name.toLowerCase();
    return {
      role: key,
      label: r.name.toUpperCase(),
      colorVar: r.color ?? FALLBACK_ROLE_COLORS[key] ?? MEMBER_COLOR,
    };
  });
}

/** Status priority for sorting: lower = higher priority (shown first). */
function statusPriority(status: UserStatus): number {
  switch (status) {
    case "online":
      return 0;
    case "idle":
      return 1;
    case "dnd":
      return 2;
    case "offline":
      return 3;
    default:
      return 99;
  }
}

function statusColor(status: UserStatus): string {
  switch (status) {
    case "online":
      return "var(--green)";
    case "idle":
      return "var(--yellow)";
    case "dnd":
      return "var(--red)";
    case "offline":
      return "var(--text-micro)";
    default:
      return "#747f8d";
  }
}

let activeMenu: { element: HTMLDivElement; destroy(): void } | null = null;
let activePopup: UserProfilePopupComponent | null = null;

function closeActiveMenu(): void {
  if (activeMenu !== null) {
    activeMenu.destroy();
    activeMenu = null;
  }
}

function closeActivePopup(): void {
  if (activePopup !== null) {
    activePopup.destroy?.();
    activePopup = null;
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
    "aria-label": member.status,
    title: member.status,
  });
  avatar.appendChild(statusDot);

  const name = createElement("span", { class: "mi-name", style: `color: ${colorVar}` });
  setText(name, member.username);

  appendChildren(item, avatar, name);

  // Left-click opens the profile popup (previously dead code — built and
  // tested but never mounted from anywhere).
  item.addEventListener(
    "click",
    (e) => {
      closeActiveMenu();
      closeActivePopup();
      const currentUserId = authStore.getState().user?.id ?? 0;
      const isSelf = member.id === currentUserId;
      const onMessageUser = opts.onMessageUser;
      activePopup = createUserProfilePopup({
        user: {
          id: member.id,
          username: member.username,
          avatar: member.avatar,
          role: member.role,
          status: member.status,
        },
        anchorX: e.clientX,
        anchorY: e.clientY,
        ...(isSelf || onMessageUser === undefined
          ? {}
          : { onMessage: (userId: number) => onMessageUser(userId) }),
      });
      activePopup.mount(document.body);
    },
    { signal },
  );

  // Context menu for admin actions
  item.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();

      // Don't show context menu for yourself
      const currentUserId = authStore.getState().user?.id ?? 0;
      if (member.id === currentUserId) return;

      // Moderation actions are permission-gated per item (a role name told us
      // nothing about what its bits allow); block/unblock is open to everyone.
      const gates = moderationGates(opts.currentUserRole);
      const showAdminActions = gates.canKick || gates.canBan || gates.canManageRoles;

      closeActiveMenu();
      document.removeEventListener("mousedown", handleOutsideClick);

      // Roles come from the server's `ready` payload — a hardcoded list made
      // custom roles unreachable and, worse, unresolvable to a role id, so
      // picking one silently did nothing.
      const availableRoles = assignableRoleNames();
      const isBlocked = blocksStore.getState().blockedByMe.has(member.id);

      activeMenu = createMemberContextMenu({
        userId: member.id,
        username: member.username,
        currentRole: member.role.toLowerCase(),
        availableRoles,
        showAdminActions,
        canKick: gates.canKick,
        canBan: gates.canBan,
        canManageRoles: gates.canManageRoles,
        isBlocked,
        onToggleBlock: () => opts.onToggleBlock(member.id, member.username, !isBlocked),
        onKick: () => opts.onKick(member.id, member.username),
        onBan: (reason: string, durationHours: number) =>
          opts.onBan(member.id, member.username, reason, durationHours),
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
    },
    { signal },
  );

  return item;
}

function renderList(
  root: HTMLDivElement,
  opts: MemberListOptions,
  signal: AbortSignal,
  rowsByUserId: Map<number, HTMLDivElement>,
): void {
  clearChildren(root);
  rowsByUserId.clear();

  const state = membersStore.getState();

  if (state.members.size === 0) {
    const emptyState = createElement("div", { class: "member-list-empty" });
    const msg = createElement("p", { class: "member-list-empty-text" }, "No members online");
    emptyState.appendChild(msg);
    root.appendChild(emptyState);
    return;
  }

  // Single pass: bucket members by (lowercased) role, then sort each bucket
  // by status \u2014 instead of one filter + toSorted sweep per role group.
  const buckets = new Map<string, Member[]>();
  for (const member of state.members.values()) {
    const role = member.role.toLowerCase();
    const bucket = buckets.get(role);
    if (bucket === undefined) {
      buckets.set(role, [member]);
    } else {
      bucket.push(member);
    }
  }

  const groups = roleGroups();
  const rendered = new Set<string>();
  for (const group of groups) {
    rendered.add(group.role);
    appendGroup(root, group, buckets.get(group.role) ?? [], opts, signal, rowsByUserId);
  }

  // Members whose role isn't in the server's role list (e.g. a role deleted
  // mid-session) still render, in a gray group, instead of vanishing.
  const leftovers = [...buckets.keys()].filter((role) => !rendered.has(role)).toSorted();
  for (const role of leftovers) {
    const group: RoleGroup = { role, label: role.toUpperCase(), colorVar: MEMBER_COLOR };
    appendGroup(root, group, buckets.get(role) ?? [], opts, signal, rowsByUserId);
  }
}

function appendGroup(
  root: HTMLDivElement,
  group: RoleGroup,
  members: readonly Member[],
  opts: MemberListOptions,
  signal: AbortSignal,
  rowsByUserId: Map<number, HTMLDivElement>,
): void {
  const groupMembers = members.toSorted(
    (a, b) => statusPriority(a.status) - statusPriority(b.status),
  );

  if (groupMembers.length === 0) return;

  const header = createElement(
    "div",
    { class: "member-role-group" },
    `${group.label} \u2014 ${groupMembers.length}`,
  );
  root.appendChild(header);

  for (const member of groupMembers) {
    const item = createMemberItem(member, group.colorVar, opts, signal);
    rowsByUserId.set(member.id, item);
    root.appendChild(item);
  }
}

/** True when the only difference between two member maps is presence status \u2014
 *  same ids with identical username/role/avatar/identity key. Such updates can
 *  be patched into the existing rows instead of rebuilding the list. */
function isPresenceOnlyChange(
  prev: ReadonlyMap<number, Member>,
  next: ReadonlyMap<number, Member>,
): boolean {
  if (prev.size === 0 || prev.size !== next.size) return false;
  for (const [id, member] of next) {
    const before = prev.get(id);
    if (before === undefined) return false;
    if (before === member) continue;
    if (
      before.username !== member.username ||
      before.role !== member.role ||
      before.avatar !== member.avatar ||
      before.identityPublicKey !== member.identityPublicKey
    ) {
      return false;
    }
  }
  return true;
}

/** Patch status dots/classes in place for members whose presence changed.
 *  Row identity (and therefore hover/context-menu state) is preserved; the
 *  status-priority sort order is deliberately not reshuffled until the next
 *  structural render. */
function patchPresence(
  prev: ReadonlyMap<number, Member>,
  next: ReadonlyMap<number, Member>,
  rowsByUserId: ReadonlyMap<number, HTMLDivElement>,
): void {
  for (const [id, member] of next) {
    const before = prev.get(id);
    if (before === undefined || before.status === member.status) continue;
    const row = rowsByUserId.get(id);
    if (row === undefined) continue;
    row.classList.toggle("offline", member.status === "offline");
    const dot = row.querySelector<HTMLDivElement>(".mi-status");
    if (dot !== null) {
      dot.style.background = statusColor(member.status);
      dot.setAttribute("aria-label", member.status);
      dot.title = member.status;
    }
  }
}

export function createMemberList(opts: MemberListOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  /** Rendered rows by user id \u2014 lets presence-only updates patch in place. */
  const rowsByUserId = new Map<number, HTMLDivElement>();
  let prevMembers: ReadonlyMap<number, Member> = new Map();

  function mount(container: Element): void {
    root = createElement("div", { class: "member-list", "data-testid": "member-list" });
    prevMembers = membersStore.getState().members;
    renderList(root, opts, disposable.signal, rowsByUserId);

    disposable.onStoreChange<MembersState, ReadonlyMap<number, Member>>(
      membersStore,
      (s) => s.members,
      (members) => {
        if (root !== null) {
          if (isPresenceOnlyChange(prevMembers, members)) {
            patchPresence(prevMembers, members, rowsByUserId);
          } else {
            renderList(root, opts, disposable.signal, rowsByUserId);
          }
        }
        prevMembers = members;
      },
    );

    container.appendChild(root);
  }

  function destroy(): void {
    closeActiveMenu();
    closeActivePopup();
    document.removeEventListener("mousedown", handleOutsideClick);
    disposable.destroy();
    rowsByUserId.clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
