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
import { positionForRole, roleHasPermission } from "@lib/permissions";
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
): readonly string[] | null {
  const me = authStore.getState().user;
  if (me === null || me.id === targetUserId) return null;
  if (!roleHasPermission(me.role, Permission.MANAGE_ROLES)) return null;
  const actorPosition = positionForRole(me.role);
  if (!outranksPosition(actorPosition, positionForRole(targetRole))) return null;
  const choices = assignableRoleNames(actorPosition);
  return choices.length > 0 ? choices : null;
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
