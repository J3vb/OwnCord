/**
 * MemberList component — shows server members grouped by role with online status.
 * Subscribes to membersStore for reactive updates.
 * Right-click context menu for admin actions (kick, ban, role change).
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { membersStore, type Member, type MembersState } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { createMemberContextMenu } from "@components/AdminActions";
import type { UserStatus } from "@lib/types";

/** Options for configuring admin action callbacks on the member list. */
export interface MemberListOptions {
  readonly currentUserRole: string;
  readonly onKick: (userId: number, username: string) => Promise<void>;
  readonly onBan: (userId: number, username: string, reason: string) => Promise<void>;
  readonly onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
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
    "aria-label": member.status,
    title: member.status,
  });
  avatar.appendChild(statusDot);

  const name = createElement("span", { class: "mi-name", style: `color: ${colorVar}` });
  setText(name, member.username);

  appendChildren(item, avatar, name);

  // Context menu for admin actions
  item.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();

      // Don't show context menu for yourself
      const currentUserId = authStore.getState().user?.id ?? 0;
      if (member.id === currentUserId) return;

      // Only admins and owners can use admin actions
      const role = opts.currentUserRole.toLowerCase();
      if (role !== "owner" && role !== "admin") return;

      closeActiveMenu();
      document.removeEventListener("mousedown", handleOutsideClick);

      // Roles come from the server's `ready` payload — a hardcoded list made
      // custom roles unreachable and, worse, unresolvable to a role id, so
      // picking one silently did nothing.
      const availableRoles = assignableRoleNames();

      activeMenu = createMemberContextMenu({
        userId: member.id,
        username: member.username,
        currentRole: member.role.toLowerCase(),
        availableRoles,
        onKick: () => opts.onKick(member.id, member.username),
        onBan: (reason: string) => opts.onBan(member.id, member.username, reason),
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

  for (const group of ROLE_GROUPS) {
    const groupMembers = (buckets.get(group.role) ?? []).toSorted(
      (a, b) => statusPriority(a.status) - statusPriority(b.status),
    );

    if (groupMembers.length === 0) continue;

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
