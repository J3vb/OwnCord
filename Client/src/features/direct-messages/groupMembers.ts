// Group DM member management: the panel's view model, the gates for
// Add People / Remove / Make Group Owner, and the three REST actions with their
// error texts. The panel, the picker and the page controller all go through
// here, so the rules live in one place.
//
// The actions never write a store. Each commits on the server, which then fans
// out a dm_channel_open to every member; that frame reaches dmStore through the
// dispatcher (the same contract as renaming a group), so a 200 body and a 204
// are handled alike and the response is only used for the error path.

import { ApiClientError, type ApiClient } from "@lib/api";
import { MAX_GROUP_DM_PARTICIPANTS } from "@lib/constants";
import { dmStore, type DmChannel } from "@stores/dm.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { resolveDisplayName } from "@lib/ui/avatar";
import { connectText } from "../../i18n/connect";
import { accountText } from "../../i18n/account";
import { groupDmText } from "../../i18n/groupDm";
import { RestErrorCode } from "@lib/protocolTypes";

/** One row of the member panel. */
export interface GroupMemberView {
  readonly id: number;
  readonly name: string;
  readonly username: string;
  readonly avatar: string | null;
  readonly status: string;
  /** On the Android app (the live member entry says so). */
  readonly mobile: boolean;
  readonly isOwner: boolean;
  readonly isSelf: boolean;
}

/** Everything the panel draws, derived from the live stores. */
export interface GroupPanelView {
  readonly channelId: number;
  /** The group's name, "" when unnamed. */
  readonly groupName: string;
  readonly members: readonly GroupMemberView[];
  /** Add People is offered: the server reports an owner and there is room. */
  readonly canAdd: boolean;
  /** How many more people fit; 0 when the group is full. */
  readonly slotsLeft: number;
  /** The viewer owns the group: Remove and Make Group Owner are offered. */
  readonly canManage: boolean;
}

/** The members of `dm` including the viewer. */
export function groupMemberCount(dm: DmChannel): number {
  return dm.participants.length + 1;
}

/**
 * Whether the viewer may add people to `dm`. Needs the owner field: its absence
 * means the server predates member management and has no add route.
 */
export function canAddPeople(dm: DmChannel): boolean {
  return dm.isGroup && dm.ownerId !== undefined && groupMemberCount(dm) < MAX_GROUP_DM_PARTICIPANTS;
}

/** Whether the viewer is the owner of `dm` (and so may remove people and hand it on). */
export function isGroupOwner(dm: DmChannel, viewerId: number): boolean {
  return dm.isGroup && dm.ownerId !== undefined && dm.ownerId === viewerId;
}

/** The panel's view of group `channelId`; null when it is not a group DM (any more). */
export function buildGroupPanelView(channelId: number): GroupPanelView | null {
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  if (dm === undefined || !dm.isGroup) return null;
  const viewer = authStore.getState().user;
  const viewerId = viewer?.id ?? 0;
  const members = membersStore.getState().members;

  const self: GroupMemberView | null =
    viewer === null
      ? null
      : (() => {
          const live = members.get(viewer.id);
          return {
            id: viewer.id,
            name:
              live !== undefined
                ? memberDisplayName(live)
                : resolveDisplayName({
                    username: viewer.username,
                    displayName: viewer.display_name ?? null,
                  }),
            username: viewer.username,
            avatar: live?.avatar ?? viewer.avatar,
            status: live?.status ?? viewer.status ?? "online",
            mobile: live?.mobile === true,
            isOwner: dm.ownerId === viewer.id,
            isSelf: true,
          };
        })();

  const others: GroupMemberView[] = dm.participants.map((p) => {
    const live = members.get(p.id);
    return {
      id: p.id,
      // The live member list wins (a fresh nickname); the DM's own copy covers
      // someone who is not in it.
      name: live !== undefined ? memberDisplayName(live) : resolveDisplayName(p),
      username: p.username,
      avatar: live?.avatar ?? (p.avatar === "" ? null : p.avatar),
      status: live?.status ?? p.status,
      mobile: live === undefined ? p.mobile === true : live.mobile === true,
      isOwner: dm.ownerId === p.id,
      isSelf: false,
    };
  });

  const list = self === null ? others : [self, ...others];
  return {
    channelId,
    groupName: dm.name,
    members: list,
    canAdd: canAddPeople(dm),
    slotsLeft: Math.max(0, MAX_GROUP_DM_PARTICIPANTS - groupMemberCount(dm)),
    canManage: isGroupOwner(dm, viewerId),
  };
}

export type GroupAction = "add" | "remove" | "owner" | "icon";

/** The text for a failed Add / Remove / Make Owner call, or a group icon change (`icon`, open to every member, so a 403 is not "owner only"). */
export function groupActionErrorText(err: unknown, action: GroupAction): string {
  if (!(err instanceof ApiClientError)) return groupDmText("error.generic");
  if (err.status === 429 || err.code === RestErrorCode.RATE_LIMITED)
    return connectText("error.rateLimited");
  if (err.code === RestErrorCode.GROUP_DM_FULL) return groupDmText("error.full");
  if (err.code === RestErrorCode.TIMED_OUT) return groupDmText("error.timedOut");
  if (action === "icon") {
    // The icon is open to every member, so a 403 is not "owner only"; the
    // server's 400 text is its raw image-rule message, so show our own.
    if (err.status === 400) return accountText("avatar.unreadable");
    return groupDmText("error.generic");
  }
  if (err.status === 403) {
    return action === "add" ? groupDmText("error.cantAdd") : groupDmText("error.notOwner");
  }
  if (err.status === 404) {
    return action === "add" ? groupDmText("error.cantAddMissing") : groupDmText("error.notInGroup");
  }
  return groupDmText("error.generic");
}

/** Add people to a group. Resolves to null on success, else the text to show. */
export async function addGroupMembers(
  api: ApiClient,
  channelId: number,
  userIds: readonly number[],
): Promise<string | null> {
  try {
    await api.addGroupDmMembers(channelId, userIds);
    return null;
  } catch (err) {
    return groupActionErrorText(err, "add");
  }
}

/** Remove another member (owner only). Resolves to null on success, else the text to show. */
export async function removeGroupMember(
  api: ApiClient,
  channelId: number,
  userId: number,
): Promise<string | null> {
  try {
    await api.removeGroupDmMember(channelId, userId);
    return null;
  } catch (err) {
    return groupActionErrorText(err, "remove");
  }
}

/** Hand the group to another member (owner only). Resolves to null on success, else the text to show. */
export async function transferGroupOwner(
  api: ApiClient,
  channelId: number,
  userId: number,
): Promise<string | null> {
  try {
    await api.setGroupDmOwner(channelId, userId);
    return null;
  } catch (err) {
    return groupActionErrorText(err, "owner");
  }
}
