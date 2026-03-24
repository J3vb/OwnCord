import { Permission } from './types';

/** Bitmask with every permission bit set. */
const ALL_PERMISSIONS = 0x7FFFFFFF;

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
