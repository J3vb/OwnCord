/**
 * GroupMemberPanelController -- owns the group DM member panel's lifecycle in
 * the chat layout. It mirrors how MainPage drives the 1:1 profile
 * panel: a lazily imported component mounted in the same right-hand slot, a
 * saved open/closed preference, a header toggle whose `aria-pressed` follows the
 * panel, and a sync that makes the panel match the active conversation without
 * touching the preference.
 *
 * Only one of the two panels shows at a time: the 1:1 panel never opens for a
 * group (it has no single recipient) and this one never opens for a 1:1 DM.
 * While open, the panel repaints from dmStore (a dm_channel_open that adds,
 * removes or re-owns members) and from the members those DMs name.
 */

import { ApiClientError, type ApiClient } from "@lib/api";
import { loadPref, savePref } from "@lib/prefs/preferences";
import type { Member } from "@stores/members.store";
import { membersStore } from "@stores/members.store";
import { getActiveChannel } from "@stores/channels.store";
import { dmStore, type DmChannel } from "@stores/dm.store";
import { openUserProfilePopup } from "../../features/profiles/openUserProfilePopup";
import type { GroupDmMemberPanelComponent } from "@components/GroupDmMemberPanel";
import type * as GroupMembers from "../../features/direct-messages/groupMembers";
import { createMemberPickerModal } from "./MemberPickerModal";
import type { MountableComponent } from "@lib/text/safeRender";
import { RestErrorCode } from "@lib/protocolTypes";

/** Saved preference: the group member panel opens with the conversation. */
export const GROUP_MEMBERS_PREF = "dmMembersOpen";

export interface GroupMemberPanelControllerOptions {
  readonly api: ApiClient;
  /** The slot the 1:1 profile panel also mounts in. Null before the chat area exists. */
  readonly getSlot: () => HTMLElement | null;
  /** The header's "Show Member List" toggle, when it exists. */
  readonly getButton: () => HTMLButtonElement | null;
  /** Show an error text to the user. */
  readonly notify: (message: string) => void;
}

export interface GroupMemberPanelController {
  readonly isOpen: () => boolean;
  /** The header toggle: open the panel for the active group, or close it (remembered). */
  readonly toggle: () => void;
  /** Make the panel match the active conversation; the saved preference is untouched. */
  readonly syncToActive: () => void;
  /** Close the panel (not remembered). */
  readonly close: () => void;
  readonly destroy: () => void;
}

const noop = (): void => undefined;

/** What the member panel draws from a DM: membership, names, avatars, owner. */
function membershipKey(dm: DmChannel | undefined): string {
  if (dm === undefined) return "";
  return JSON.stringify([
    dm.isGroup,
    dm.name,
    dm.ownerId ?? null,
    dm.participants.map((p) => [p.id, p.displayName ?? "", p.avatar, p.status]),
  ]);
}

/** The error the server would answer a full group with. */
function fullError(): ApiClientError {
  return new ApiClientError(409, RestErrorCode.GROUP_DM_FULL, "full");
}

function activeGroupId(): number | null {
  const active = getActiveChannel();
  if (active === null || active.type !== "dm") return null;
  const dm = dmStore.getState().channels.find((c) => c.channelId === active.id);
  return dm !== undefined && dm.isGroup ? active.id : null;
}

function openProfile(
  member: { id: number; username: string; avatar: string | null; status: string; name: string },
  x: number,
  y: number,
): void {
  const fallbackUser: Member = {
    id: member.id,
    username: member.username,
    avatar: member.avatar,
    role: "member",
    status:
      member.status === "online" || member.status === "idle" || member.status === "dnd"
        ? member.status
        : "offline",
    displayName: member.name,
  };
  openUserProfilePopup({
    userId: member.id,
    anchorX: x,
    anchorY: y,
    fallbackUser,
    fallbackFocus: () =>
      document.querySelector<HTMLElement>(`[data-testid="group-member-${member.id}"]`),
  });
}

export function createGroupMemberPanelController(
  opts: GroupMemberPanelControllerOptions,
): GroupMemberPanelController {
  let panel: GroupDmMemberPanelComponent | null = null;
  let members: typeof GroupMembers | null = null;
  /** The in-flight lazy open; a close supersedes it so it cannot mount late. */
  let load: object | null = null;
  let unsub: (() => void) | null = null;
  let boundChannelId = 0;
  let picker: MountableComponent | null = null;
  let destroyed = false;

  const isOpen = (): boolean => panel !== null || load !== null;

  function syncButton(): void {
    opts.getButton()?.setAttribute("aria-pressed", String(isOpen()));
  }

  function closePicker(): void {
    picker?.destroy?.();
    picker = null;
  }

  function refresh(): void {
    if (panel === null || members === null) return;
    const view = members.buildGroupPanelView(boundChannelId);
    if (view !== null) panel.update(view);
  }

  /**
   * Follow `channelId` live: its dmStore entry (a dm_channel_open replaces it)
   * and, keyed on the ids it names, the member entries that supply live names,
   * avatars and presence. Re-binding drops the previous group's subscriptions.
   */
  function bind(channelId: number): void {
    unsub?.();
    boundChannelId = channelId;
    let unsubMembers: () => void = noop;
    let boundIds = "";
    const bindMembers = (): void => {
      const ids =
        dmStore
          .getState()
          .channels.find((c) => c.channelId === channelId)
          ?.participants.map((p) => p.id) ?? [];
      // Re-subscribe only when the people change, not on every DM update.
      const idsKey = ids.join(",");
      if (idsKey === boundIds) return;
      boundIds = idsKey;
      unsubMembers();
      unsubMembers = membersStore.subscribeSelector(
        (s) =>
          ids
            .map((id) => {
              const m = s.members.get(id);
              return `${id}:${m?.status ?? ""}:${m?.displayName ?? ""}:${m?.avatar ?? ""}`;
            })
            .join("|"),
        refresh,
      );
    };
    bindMembers();
    // A string key of what the panel shows, so a new last-message preview or
    // unread count (which replace the channel object) does not fire it.
    const unsubDm = dmStore.subscribeSelector(
      (s) => membershipKey(s.channels.find((c) => c.channelId === channelId)),
      () => {
        bindMembers();
        refresh();
      },
    );
    unsub = () => {
      unsubMembers();
      unsubDm();
    };
  }

  function addPeople(): void {
    if (picker !== null || members === null || panel === null) return;
    const mod = members;
    const channelId = boundChannelId;
    const view = mod.buildGroupPanelView(channelId);
    if (view === null || !view.canAdd) return;
    const exclude = new Set(view.members.map((m) => m.id));
    // The group may have changed while the picker was open: check again on submit.
    const submit = async (ids: readonly number[]): Promise<string | null> => {
      const now = mod.buildGroupPanelView(channelId);
      if (now === null || !now.canAdd) return mod.groupActionErrorText(undefined, "add");
      const taken = new Set(now.members.map((m) => m.id));
      const fresh = ids.filter((id) => !taken.has(id));
      if (fresh.length === 0) return null;
      if (fresh.length > now.slotsLeft) return mod.groupActionErrorText(fullError(), "add");
      return mod.addGroupMembers(opts.api, channelId, fresh);
    };
    const created = createMemberPickerModal({
      onSelect: () => undefined,
      excludeIds: exclude,
      maxSelect: view.slotsLeft,
      onAdd: submit,
      onClose: () => {
        picker = null;
      },
    });
    picker = created;
    created.mount(document.body);
  }

  function openFor(channelId: number, focus: boolean): boolean {
    const slot = opts.getSlot();
    if (slot === null || activeGroupId() !== channelId) return false;
    const token = {};
    load = token;
    boundChannelId = channelId;
    syncButton();
    void Promise.all([
      import("@components/GroupDmMemberPanel"),
      import("../../features/direct-messages/groupMembers"),
    ]).then(
      ([panelMod, membersMod]) => {
        // A close, a newer open or a teardown since the click supersedes this.
        if (destroyed || load !== token) return;
        load = null;
        members = membersMod;
        const view = membersMod.buildGroupPanelView(channelId);
        const mountSlot = opts.getSlot();
        if (view === null || mountSlot === null) {
          syncButton();
          return;
        }
        panel = panelMod.createGroupDmMemberPanel({
          view,
          focus,
          onClose: () => {
            close();
            savePref(GROUP_MEMBERS_PREF, false);
          },
          onAddPeople: addPeople,
          onOpenProfile: (member, x, y) => openProfile(member, x, y),
          onRemove: (cid, member) => {
            void membersMod.removeGroupMember(opts.api, cid, member.id).then((failure) => {
              if (failure !== null) opts.notify(failure);
            });
          },
          onMakeOwner: (cid, member) => {
            void membersMod.transferGroupOwner(opts.api, cid, member.id).then((failure) => {
              if (failure !== null) opts.notify(failure);
            });
          },
        });
        panel.mount(mountSlot);
        bind(channelId);
        syncButton();
      },
      () => {
        // The panel could not load; a later click may retry.
        if (load === token) load = null;
        syncButton();
      },
    );
    return true;
  }

  function close(): void {
    load = null;
    unsub?.();
    unsub = null;
    closePicker();
    if (panel !== null) {
      panel.destroy?.();
      panel = null;
    }
    syncButton();
  }

  function toggle(): void {
    if (isOpen()) {
      close();
      savePref(GROUP_MEMBERS_PREF, false);
      return;
    }
    const id = activeGroupId();
    if (id === null) return;
    if (openFor(id, true)) savePref(GROUP_MEMBERS_PREF, true);
  }

  function syncToActive(): void {
    const id = activeGroupId();
    if (id === null || !loadPref<boolean>(GROUP_MEMBERS_PREF, true)) {
      close();
      return;
    }
    // Already showing: a switch to another group repaints the same panel (no
    // remount, no focus move) and follows the new group live.
    if (panel !== null && members !== null) {
      const view = members.buildGroupPanelView(id);
      if (view !== null) {
        if (id !== boundChannelId) closePicker();
        bind(id);
        panel.update(view);
        return;
      }
    }
    if (load !== null && boundChannelId === id) return;
    close();
    // It opened by itself: never take focus from what the user is typing in.
    openFor(id, false);
  }

  function destroy(): void {
    destroyed = true;
    close();
  }

  return { isOpen, toggle, syncToActive, close, destroy };
}
