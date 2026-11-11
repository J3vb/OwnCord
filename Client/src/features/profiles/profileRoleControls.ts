/**
 * The live role sources the user profile popup reads while it is open: the
 * single-role picker and the multi-role chips. Both re-read the stores every
 * time, so a role change on either side (the member's, the viewer's own, or
 * the role list) re-filters or removes the picker while the card is open.
 */
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import { membersStore, type Member } from "../../stores/members.store";
import { multiRoleEnabled } from "../../lib/net/serverCapabilities";
import { memberRolesState, roleChangeChoices } from "../moderation/roleAssignment";
import type { ProfileRoleControl, ProfileRolesControl } from "./userProfileTypes";

type ChangeRole = (userId: number, username: string, newRole: string) => Promise<void>;
type RoleIdChange = (userId: number, username: string, roleId: number) => Promise<void>;

/** The viewer's own role set and the role list, which decide what they may assign. */
function viewerRoleKey(st: ReturnType<typeof authStore.getState>): string {
  return `${st.user?.role ?? ""}|${st.user?.role_ids?.join(",") ?? ""}`;
}

/** Subscribe `listener` to the member's role selector plus the viewer's roles. */
function subscribeRoleSources<T>(
  memberSelector: (st: ReturnType<typeof membersStore.getState>) => T,
  listener: () => void,
): () => void {
  const unsubs = [
    membersStore.subscribeSelector(memberSelector, listener),
    authStore.subscribeSelector(viewerRoleKey, listener),
    channelsStore.subscribeSelector((st) => st.roles, listener),
  ];
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

/** The member's current username, or the one the card opened with. */
function currentUsername(userId: number, live: Member): string {
  return membersStore.getState().members.get(userId)?.username ?? live.username;
}

export function buildRoleControl(
  userId: number,
  live: Member,
  onChangeRole: ChangeRole | undefined,
): ProfileRoleControl {
  return {
    read: () => {
      const member = membersStore.getState().members.get(userId);
      const role = member?.role ?? live.role;
      // A member who left or was banned while the card is open has no role to change.
      return {
        role,
        choices:
          onChangeRole === undefined || member === undefined
            ? null
            : roleChangeChoices(userId, role, member.roleIds),
      };
    },
    subscribe: (listener) => subscribeRoleSources((st) => st.members.get(userId)?.role, listener),
    change: async (role) => {
      await onChangeRole?.(userId, currentUsername(userId, live), role);
    },
  };
}

/** The chips replace the single-role picker only on a server that holds
 *  several roles per member; any other server keeps the picker. */
export function buildRolesControl(
  userId: number,
  live: Member,
  onAddRole: RoleIdChange | undefined,
  onRemoveRole: RoleIdChange | undefined,
): ProfileRolesControl | undefined {
  if (!multiRoleEnabled() || onAddRole === undefined || onRemoveRole === undefined) {
    return undefined;
  }
  return {
    read: () => {
      const member = membersStore.getState().members.get(userId);
      return memberRolesState(
        userId,
        member?.role ?? live.role,
        member === undefined ? live.roleIds : member.roleIds,
      );
    },
    subscribe: (listener) =>
      subscribeRoleSources(
        (st) => st.members.get(userId)?.roleIds ?? st.members.get(userId)?.role,
        listener,
      ),
    add: async (roleId) => {
      await onAddRole(userId, currentUsername(userId, live), roleId);
    },
    remove: async (roleId) => {
      await onRemoveRole(userId, currentUsername(userId, live), roleId);
    },
  };
}
