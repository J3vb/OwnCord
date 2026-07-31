import { Permission } from "./types";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";

/** Bitmask with every permission bit set. */
const ALL_PERMISSIONS = 0x7fffffff;

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
 * Returns true if `userPerms` includes **any** of the listed permissions.
 * ADMINISTRATOR bit causes an automatic pass.
 */
export function hasAnyPermission(userPerms: number, ...perms: Permission[]): boolean {
  if ((userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) {
    return true;
  }
  return perms.some((p) => (userPerms & p) === p);
}

/**
 * Returns true if `userPerms` includes **all** of the listed permissions.
 * ADMINISTRATOR bit causes an automatic pass.
 */
export function hasAllPermissions(userPerms: number, ...perms: Permission[]): boolean {
  if ((userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) {
    return true;
  }
  return perms.every((p) => (userPerms & p) === p);
}

/**
 * Compute effective permissions after applying channel-level overrides.
 *
 * - If the base permissions contain ADMINISTRATOR the result is all bits set
 *   (deny/allow are ignored).
 * - Otherwise: remove `deny` bits first, then add `allow` bits.
 *   Allow takes precedence over deny (matches server semantics).
 */
export function computeEffective(basePerms: number, allow: number, deny: number): number {
  if ((basePerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }
  return (basePerms & ~deny) | allow;
}

/** Shorthand check for the ADMINISTRATOR bit. */
export function isAdministrator(userPerms: number): boolean {
  return (userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
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
