import { Permission } from "./types";
import { authStore } from "@stores/auth.store";
import { channelsStore, type ChannelsState } from "@stores/channels.store";

/**
 * Returns true if `userPerms` includes the given permission bit.
 * Users with the ADMINISTRATOR bit always pass.
 */
export function hasPermission(userPerms: number, perm: Permission): boolean {
  if ((userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) {
    return true;
  }
  return (userPerms & perm) === perm;
}

/**
 * Permission mask for a role name, from the role list the server sends in
 * `ready`. Returns null when that list has no matching entry (pre-`ready`, or
 * an older server that sent none) so callers can distinguish "unknown role"
 * from "role with no bits" and fall back instead of hiding everything.
 */
export function permissionsForRole(roleName: string): number | null {
  return permissionsForRoleIn(channelsStore.getState().roles, roleName);
}

/** `permissionsForRole` over a role list the caller already holds, so a
 *  builder fed by a snapshot reads no store. */
export function permissionsForRoleIn(
  roles: ChannelsState["roles"],
  roleName: string,
): number | null {
  const name = roleName.toLowerCase();
  return roles.find((r) => r.name.toLowerCase() === name)?.permissions ?? null;
}

/**
 * Permission mask of a member holding several roles: the OR of every
 * held role's mask, so a bit any held role grants counts. `roleIds` comes from
 * the server's `role_ids`; an id the cached roster does not know is skipped.
 * With no `roleIds` (an older server), or none that resolve, the single role
 * name answers exactly as `permissionsForRoleIn` does. Null = unknown.
 */
export function permissionsForMemberIn(
  roles: ChannelsState["roles"],
  roleIds: readonly number[] | undefined,
  roleName: string,
): number | null {
  if (roleIds !== undefined) {
    let mask = 0;
    let found = false;
    for (const id of roleIds) {
      const role = roles.find((r) => r.id === id);
      if (role === undefined) continue;
      mask |= role.permissions;
      found = true;
    }
    if (found) return mask;
  }
  return permissionsForRoleIn(roles, roleName);
}

/**
 * Rank of a member for "who outranks whom": the highest `position` among the
 * held roles (the top role), else the role name's position. Undefined when
 * neither is known, which callers read as "cannot tell; the server decides".
 */
export function topPositionFor(
  roles: ChannelsState["roles"],
  roleIds: readonly number[] | undefined,
  roleName: string,
): number | undefined {
  if (roleIds !== undefined) {
    let top = Number.NEGATIVE_INFINITY;
    for (const id of roleIds) {
      const position = roles.find((r) => r.id === id)?.position;
      if (position !== undefined) top = Math.max(top, position);
    }
    if (top !== Number.NEGATIVE_INFINITY) return top;
  }
  const name = roleName.toLowerCase();
  return roles.find((r) => r.name.toLowerCase() === name)?.position;
}

/**
 * Legacy owner/admin name check. Only meaningful as a fallback for servers
 * that send no role list; the permission mask is authoritative whenever one
 * is available.
 */
export function isLegacyAdminRole(roleName: string): boolean {
  const name = roleName.toLowerCase();
  return name === "owner" || name === "admin";
}

/**
 * Whether `roleName` grants `perm`, from the role list the server sends in
 * `ready`. When that list has no matching entry (pre-`ready`, or an older
 * server that sent none) the legacy owner/admin name check stands in — a mask
 * of 0 would otherwise hide moderation from every actual admin.
 *
 * This is the single derivation every moderation affordance uses for the
 * permission bits, so the member-list gates and the voice moderation menu
 * cannot drift apart. The member list also mirrors the rank rule through
 * `topPositionFor`; the voice moderation menu does not. Drives affordances
 * only — the server is still the authority on every action and on rank.
 */
export function roleHasPermission(roleName: string, perm: Permission): boolean {
  return roleHasPermissionIn(channelsStore.getState().roles, roleName, perm);
}

/** `roleHasPermission` over a role list the caller already holds. */
export function roleHasPermissionIn(
  roles: ChannelsState["roles"],
  roleName: string,
  perm: Permission,
): boolean {
  const perms = permissionsForRoleIn(roles, roleName);
  if (perms === null) return isLegacyAdminRole(roleName);
  return hasPermission(perms, perm);
}

/**
 * `roleHasPermissionIn` for a member who may hold several roles: the OR of the
 * held masks, with the same legacy owner/admin fallback when nothing resolves.
 */
export function memberHasPermissionIn(
  roles: ChannelsState["roles"],
  roleIds: readonly number[] | undefined,
  roleName: string,
  perm: Permission,
): boolean {
  const perms = permissionsForMemberIn(roles, roleIds, roleName);
  if (perms === null) return isLegacyAdminRole(roleName);
  return hasPermission(perms, perm);
}

/**
 * Whether the signed-in user holds `perm` through any held role, with the
 * legacy owner/admin fallback. Read live from the stores.
 */
export function currentUserRoleHasPermission(perm: Permission): boolean {
  const me = authStore.getState().user;
  return memberHasPermissionIn(channelsStore.getState().roles, me?.role_ids, me?.role ?? "", perm);
}

/**
 * Effective permission bits for the signed-in user, from the role list the
 * server sends in `ready`. Returns 0 when the role is unknown (pre-`ready`,
 * or a role the server didn't send) — deny by default.
 */
export function currentUserPermissions(): number {
  const me = authStore.getState().user;
  const roleName = me?.role;
  if (roleName === undefined || roleName === null) return 0;
  return permissionsForMemberIn(channelsStore.getState().roles, me?.role_ids, roleName) ?? 0;
}

/**
 * Whether the signed-in user holds `perm`. Drives affordances only — the
 * server is still the authority on every action.
 */
export function currentUserHasPermission(perm: Permission): boolean {
  return hasPermission(currentUserPermissions(), perm);
}

/** Shorthand for the MANAGE_MESSAGES bit (delete others' messages, bypass slow mode). */
export function canManageMessages(): boolean {
  return currentUserHasPermission(Permission.MANAGE_MESSAGES);
}

/**
 * A per-channel message affordance (can_delete_others / can_pin) as the server
 * computed it, or — when it never said (an older server) — the role's
 * MANAGE_MESSAGES, which is the behaviour before the server sent it. Absent is
 * never read as false.
 */
export function channelBitOrRole(bit: boolean | undefined): boolean {
  return bit ?? canManageMessages();
}

/**
 * Whether the signed-in user's role holds MANAGE_CHANNELS — create, edit,
 * delete and reorder channels, all of which the server gates on the same bit
 * behind `/api/v1/moderation/channels*`.
 *
 * Routed through `roleHasPermission` rather than `currentUserHasPermission` so
 * a server that sent no role list still shows the affordances to owner/admin
 * instead of hiding channel management from everyone. The one derivation for
 * every channel-management affordance, so the category "+", the context menu
 * and the audit-log entry cannot disagree about who may manage channels.
 */
export function canManageChannels(): boolean {
  return currentUserRoleHasPermission(Permission.MANAGE_CHANNELS);
}

/**
 * The manager's category list, but only while the viewer currently holds
 * MANAGE_CHANNELS. A viewer demoted mid-session keeps the stale list in the
 * store until the next ready, so every reader goes through this: without the
 * bit it is empty and the groups come from the channels' own fields.
 */
export function visibleCategories(): ChannelsState["categories"] {
  return canManageChannels() ? channelsStore.getState().categories : [];
}

/**
 * Whether the signed-in user's role holds VIEW_AUDIT_LOG. Gates the desktop
 * entry point into the admin panel's audit log; the panel re-checks the bit
 * on every request.
 */
export function canViewAuditLog(): boolean {
  return currentUserRoleHasPermission(Permission.VIEW_AUDIT_LOG);
}

/**
 * Whether the signed-in user's role holds MANAGE_INVITES (ADMINISTRATOR implies
 * it). The server gates every `/api/v1/invites` route on this bit, so the
 * header Invite button is only offered to roles that can use it.
 */
export function canManageInvites(): boolean {
  return currentUserRoleHasPermission(Permission.MANAGE_INVITES);
}

/**
 * Whether the signed-in user's role holds MODERATE_MEMBERS. Gates the
 * Moderation Center entry; the server re-checks the bit on every
 * queue read and action.
 */
export function canModerateMembers(): boolean {
  return currentUserRoleHasPermission(Permission.MODERATE_MEMBERS);
}
