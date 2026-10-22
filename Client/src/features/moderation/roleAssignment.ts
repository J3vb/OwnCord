/**
 * Changing a member's role, as one rule set shared by the member context menu
 * and the profile popup's role picker: which roles the signed-in user may hand
 * out, whether they may act on a given member at all, and the one request
 * (with its toasts) that does it.
 *
 * Everything here drives affordances only; the server is still the authority
 * on the permission bit and on rank.
 */

import { errorText, type ApiClient } from "@lib/api";
import { Permission } from "@lib/types";
import { memberHasPermissionIn, topPositionFor } from "@lib/permissions";
import type { ProfileRolesState } from "@components/UserProfilePopup";
import { authStore } from "@stores/auth.store";
import { channelsStore, getRoleIdByName } from "@stores/channels.store";
import type { ToastType } from "@components/Toast";
import { shellText } from "../../i18n/shell";

/** Roles offered when the server hasn't sent any. */
// i18n-exempt: built-in role names, matched case-insensitively against the server list
const FALLBACK_ASSIGNABLE_ROLES: readonly string[] = ["Admin", "Moderator", "Member"];

/**
 * Role names an admin can assign, taken from the server's role list. "owner" is
 * excluded — ownership transfer isn't a menu action.
 */
export function assignableRoleNames(actorPosition: number | undefined): readonly string[] {
  const all = channelsStore.getState().roles;
  if (all.length === 0) return FALLBACK_ASSIGNABLE_ROLES;
  return all
    .filter(
      // The server refuses a role at or above the actor's own rank; with no
      // positions to compare it stays the authority.
      (r) =>
        r.name.toLowerCase() !== "owner" &&
        (actorPosition === undefined || r.position === undefined || r.position < actorPosition),
    )
    .map((r) => r.name);
}

/** Whether a role at `actorPosition` ranks above one at `targetPosition`.
 *  Unknown positions (an older server) leave the decision to the server. */
export function outranksPosition(
  actorPosition: number | undefined,
  targetPosition: number | undefined,
): boolean {
  return (
    actorPosition === undefined || targetPosition === undefined || actorPosition > targetPosition
  );
}

/**
 * The roles the signed-in user may assign to `targetUserId`, who currently
 * holds `targetRole`; null when they may not change that member's role at all
 * (no MANAGE_ROLES, the target is themselves or ranks at or above them, or
 * nothing is assignable). Read live, so a caller re-asking after a role change
 * on either side gets the new answer.
 */
export function roleChangeChoices(
  targetUserId: number,
  targetRole: string,
  targetRoleIds?: readonly number[],
): readonly string[] | null {
  const me = authStore.getState().user;
  if (me === null || me.id === targetUserId) return null;
  const roles = channelsStore.getState().roles;
  // Permissions are the OR of every held role; rank is the top role.
  if (!memberHasPermissionIn(roles, me.role_ids, me.role, Permission.MANAGE_ROLES)) return null;
  const actorPosition = topPositionFor(roles, me.role_ids, me.role);
  if (!outranksPosition(actorPosition, topPositionFor(roles, targetRoleIds, targetRole))) {
    return null;
  }
  const choices = assignableRoleNames(actorPosition);
  return choices.length > 0 ? choices : null;
}

/**
 * The chips and "+" list for `targetUserId` on a multi-role server: every held
 * role, highest position first (the cached `role_ids` tail may keep an older
 * order after a reorder), and, when the viewer holds MANAGE_ROLES and outranks
 * the member, which chips they may remove and which roles they may add.
 * Everything else is read-only chips. Read live; the server stays the authority.
 */
export function memberRolesState(
  targetUserId: number,
  targetRole: string,
  targetRoleIds: readonly number[] | undefined,
): ProfileRolesState {
  const roles = channelsStore.getState().roles;
  const me = authStore.getState().user;
  const actorPosition = me === null ? undefined : topPositionFor(roles, me.role_ids, me.role);
  const mayManage =
    me !== null &&
    me.id !== targetUserId &&
    memberHasPermissionIn(roles, me.role_ids, me.role, Permission.MANAGE_ROLES) &&
    outranksPosition(actorPosition, topPositionFor(roles, targetRoleIds, targetRole));
  // Below the actor's own top role; unknown positions leave it to the server.
  const below = (position: number | undefined): boolean =>
    actorPosition === undefined || position === undefined || position < actorPosition;

  const heldIds = new Set(targetRoleIds ?? []);
  const held = roles
    .filter((r) => heldIds.has(r.id))
    .toSorted((a, b) => (b.position ?? 0) - (a.position ?? 0));
  const byName = targetRoleIds === undefined || held.length === 0;
  const named = byName
    ? roles.filter((r) => r.name.toLowerCase() === targetRole.toLowerCase())
    : held;
  const chips = named.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    removable: mayManage && below(r.position),
  }));
  const addable = mayManage
    ? roles
        .filter((r) => r.name.toLowerCase() !== "owner" && !heldIds.has(r.id) && below(r.position))
        .map((r) => ({ id: r.id, name: r.name }))
    : [];
  return { chips, addable };
}

/** The two multi-role requests. */
export interface RoleMembershipDeps {
  readonly api: Pick<ApiClient, "adminAddMemberRole" | "adminRemoveMemberRole">;
  readonly notify: (message: string, type: ToastType) => void;
}

export interface RoleChangeDeps {
  readonly api: Pick<ApiClient, "adminChangeRole">;
  readonly notify: (message: string, type: ToastType) => void;
}

/** PATCH the member's role and toast the outcome. Never rejects: a failure is
 *  a toast, and the roster only changes when the server's echo arrives. */
export async function changeMemberRole(
  deps: RoleChangeDeps,
  userId: number,
  username: string,
  newRole: string,
): Promise<void> {
  const roleId = getRoleIdByName(newRole);
  if (roleId === undefined) {
    // No silent failures: the role vanished from the server's list.
    deps.notify(shellText("members.unknownRole", { role: newRole }), "error");
    return;
  }
  try {
    await deps.api.adminChangeRole(userId, roleId);
    deps.notify(shellText("members.roleChanged", { username, role: newRole }), "success");
  } catch (err) {
    deps.notify(errorText(err, shellText("members.roleChangeFailed")), "error");
  }
}

/** PUT one more role onto the member and toast the outcome. Never rejects; the
 *  roster changes only when the server's `member_update` echo arrives. */
export async function addMemberRole(
  deps: RoleMembershipDeps,
  userId: number,
  username: string,
  roleId: number,
): Promise<void> {
  const role = channelsStore.getState().roles.find((r) => r.id === roleId)?.name;
  if (role === undefined) {
    deps.notify(shellText("members.unknownRole", { role: String(roleId) }), "error");
    return;
  }
  try {
    await deps.api.adminAddMemberRole(userId, roleId);
    deps.notify(shellText("members.roleAdded", { username, role }), "success");
  } catch (err) {
    deps.notify(errorText(err, shellText("members.roleAddFailed")), "error");
  }
}

/** DELETE one role from the member and toast the outcome. Never rejects; the
 *  roster changes only on the server's echo. */
export async function removeMemberRole(
  deps: RoleMembershipDeps,
  userId: number,
  username: string,
  roleId: number,
): Promise<void> {
  const role = channelsStore.getState().roles.find((r) => r.id === roleId)?.name;
  if (role === undefined) {
    deps.notify(shellText("members.unknownRole", { role: String(roleId) }), "error");
    return;
  }
  try {
    await deps.api.adminRemoveMemberRole(userId, roleId);
    deps.notify(shellText("members.roleRemoved", { username, role }), "success");
  } catch (err) {
    deps.notify(errorText(err, shellText("members.roleRemoveFailed")), "error");
  }
}
