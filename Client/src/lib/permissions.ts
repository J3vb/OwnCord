import { Permission } from "./types";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";

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
  const name = roleName.toLowerCase();
  const role = channelsStore.getState().roles.find((r) => r.name.toLowerCase() === name);
  return role?.permissions ?? null;
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
 * This is the single derivation every moderation affordance uses, so the
 * member-list gates and the voice moderation menu cannot drift apart. Drives
 * affordances only — the server is still the authority on every action, and
 * enforces the rank rule the client cannot evaluate.
 */
export function roleHasPermission(roleName: string, perm: Permission): boolean {
  const perms = permissionsForRole(roleName);
  if (perms === null) return isLegacyAdminRole(roleName);
  return hasPermission(perms, perm);
}

/**
 * Effective permission bits for the signed-in user, from the role list the
 * server sends in `ready`. Returns 0 when the role is unknown (pre-`ready`,
 * or a role the server didn't send) — deny by default.
 */
export function currentUserPermissions(): number {
  const roleName = authStore.getState().user?.role;
  if (roleName === undefined || roleName === null) return 0;
  return permissionsForRole(roleName) ?? 0;
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
 * Whether the signed-in user's role holds MANAGE_CHANNELS — create, edit,
 * delete and reorder channels, all of which the server gates on the same bit
 * behind `/admin/api/channels*`.
 *
 * Routed through `roleHasPermission` rather than `currentUserHasPermission` so
 * a server that sent no role list still shows the affordances to owner/admin
 * instead of hiding channel management from everyone. The one derivation for
 * every channel-management affordance, so the category "+", the context menu
 * and the audit-log entry cannot disagree about who may manage channels.
 */
export function canManageChannels(): boolean {
  const roleName = authStore.getState().user?.role ?? "";
  return roleHasPermission(roleName, Permission.MANAGE_CHANNELS);
}

/**
 * Whether the signed-in user's role holds VIEW_AUDIT_LOG. Gates the desktop
 * entry point into the admin panel's audit log; the panel re-checks the bit
 * on every request.
 */
export function canViewAuditLog(): boolean {
  const roleName = authStore.getState().user?.role ?? "";
  return roleHasPermission(roleName, Permission.VIEW_AUDIT_LOG);
}

/**
 * Whether the signed-in user's role holds MODERATE_MEMBERS. Gates the
 * Moderation Center entry (B9-4, Q2); the server re-checks the bit on every
 * queue read and action.
 */
export function canModerateMembers(): boolean {
  const roleName = authStore.getState().user?.role ?? "";
  return roleHasPermission(roleName, Permission.MODERATE_MEMBERS);
}
