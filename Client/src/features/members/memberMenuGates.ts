/**
 * Which moderation items a member's context menu offers the signed-in user:
 * the permission bits of their roles, narrowed by rank against the target.
 */

import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import type { Member } from "@stores/members.store";
import { Permission, type ReadyRole } from "@lib/types";
import { manageNicknamesEnabled } from "@lib/net/serverCapabilities";
import { memberHasPermissionIn, topPositionFor } from "@lib/permissions";
import { assignableRoleNames, outranksPosition } from "../moderation/roleAssignment";

/** Which moderation menu items the signed-in user may see. */
export interface ModerationGates {
  readonly canKick: boolean;
  readonly canBan: boolean;
  readonly canManageRoles: boolean;
  readonly canTimeout: boolean;
  readonly canManageNicknames: boolean;
}

/** The permission gates narrowed to what the actor's rank allows against this target. */
function applyOutrank(
  base: ModerationGates,
  outranks: boolean,
  hasAssignableRoles: boolean,
): ModerationGates {
  return {
    canKick: base.canKick && outranks,
    canBan: base.canBan && outranks,
    canManageRoles: base.canManageRoles && outranks && hasAssignableRoles,
    canTimeout: base.canTimeout && outranks,
    canManageNicknames: base.canManageNicknames && outranks,
  };
}

function anyGate(gates: ModerationGates): boolean {
  return (
    gates.canKick ||
    gates.canBan ||
    gates.canManageRoles ||
    gates.canTimeout ||
    gates.canManageNicknames
  );
}

/**
 * Menu items the signed-in user's role permits, from the permission mask the
 * server ships in `ready`. Administrator implies all three. When the role name
 * has no match in that list (pre-`ready`, or an older server that sent none)
 * the legacy owner/admin name check stands in — a mask of 0 would otherwise
 * hide moderation from every actual admin.
 */
function moderationGates(
  roles: readonly ReadyRole[],
  roleIds: readonly number[] | undefined,
  roleName: string,
): ModerationGates {
  const has = (perm: Permission): boolean => memberHasPermissionIn(roles, roleIds, roleName, perm);
  return {
    canKick: has(Permission.KICK_MEMBERS),
    canBan: has(Permission.BAN_MEMBERS),
    canManageRoles: has(Permission.MANAGE_ROLES),
    canTimeout: has(Permission.MODERATE_MEMBERS),
    // The bit alone is not enough: an older server can hold it without the route.
    canManageNicknames: manageNicknamesEnabled() && has(Permission.MANAGE_NICKNAMES),
  };
}

export function resolveMenuGates(
  member: Member,
  isSelf: boolean,
  currentUserRole: string,
): {
  gates: ModerationGates;
  availableRoles: ReturnType<typeof assignableRoleNames>;
  outranks: boolean;
  showAdminActions: boolean;
} {
  // Moderation actions are permission-gated per item (a role name told us
  // nothing about what its bits allow); block/unblock is open to everyone.
  // The role name is read live from authStore, not the opts snapshot
  // taken once at mount -- dispatcher.ts keeps authStore.user.role
  // current on every self MEMBER_UPDATE precisely so gates like this one
  // see a promotion/demotion without waiting for the sidebar to rebuild.
  const actor = authStore.getState().user;
  const actorRole = actor?.role ?? currentUserRole;
  const roleList = channelsStore.getState().roles;
  // Permissions are the OR of every held role; rank is the top one.
  const baseGates = moderationGates(roleList, actor?.role_ids, actorRole);
  // The server refuses moderation of a member ranked at or above the actor
  // and any role assignment at or above the actor's own rank; mirror both so
  // the menu never offers a request that cannot succeed. Unknown positions
  // (an older server) leave the decision to the server.
  const actorPosition = topPositionFor(roleList, actor?.role_ids, actorRole);
  const targetPosition = topPositionFor(roleList, member.roleIds, member.role);
  const outranks = outranksPosition(actorPosition, targetPosition);
  // Roles come from the server's `ready` payload — a hardcoded list made
  // custom roles unreachable and, worse, unresolvable to a role id, so
  // picking one silently did nothing.
  const availableRoles = assignableRoleNames(actorPosition);
  const gates = applyOutrank(baseGates, outranks, availableRoles.length > 0);
  const showAdminActions = !isSelf && anyGate(gates);
  return { gates, availableRoles, outranks, showAdminActions };
}
