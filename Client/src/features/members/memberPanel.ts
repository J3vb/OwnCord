/**
 * The member panel: the member list (search + roster) and the banned section,
 * with every moderation and DM callback wired once. It is a plain element the
 * host places and scrolls; the host owns the chrome around it (the sidebar's
 * collapsible header today, a right-hand column later). One panel at a time:
 * MemberList keeps module-level popup state, so two live instances would close
 * each other's menus.
 */

import { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import type { createMemberList } from "@components/MemberList";
import type { buildVoiceModOptions, VoiceModerationCallbacks } from "@components/ChannelSidebar";
import { parseTimestamp } from "@lib/text/formatting";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { currentUserRoleHasPermission, topPositionFor } from "@lib/permissions";
import { Permission, type AdminUser } from "@lib/types";
import { type ApiClient, ApiClientError, errorText } from "@lib/api";
import type { ToastContainer } from "@components/Toast";
import { reportEntryText } from "../../i18n/reportEntry";
import { shellText } from "../../i18n/shell";
import { moderationText } from "../../i18n/moderation";
import type { BlockDeps } from "../blocks/blockActions";
import {
  addMemberRole,
  changeMemberRole,
  outranksPosition,
  removeMemberRole,
  type RoleChangeDeps,
  type RoleMembershipDeps,
} from "../moderation/roleAssignment";
import { TIMEOUT_PRESETS } from "../moderation/timeoutPresets";

/** The two UI-layer functions the panel needs. Injected rather than imported:
 *  `features/` is a lower layer and may not statically import `components/`.
 *  The host (`pages/`) passes the real ones. */
export interface MemberPanelUi {
  readonly createMemberList: typeof createMemberList;
  readonly buildVoiceModOptions: typeof buildVoiceModOptions;
}

export interface MemberPanelOptions {
  readonly ui: MemberPanelUi;
  readonly api: ApiClient;
  readonly getToast: () => ToastContainer | null;
  /** Start a DM with a user (profile popup's Message button). */
  readonly onMessageUser?: (userId: number) => void;
  /** Call a user: open/create the 1:1 DM and start a call in it (profile
   *  popup's Call button). */
  readonly onCallUser?: (userId: number) => void;
  /** Senders for the voice moderation rows (Server Mute, Deafen, Disconnect);
   *  without them the member menu offers none. */
  readonly onVoiceModerate?: VoiceModerationCallbacks;
}

export interface MemberPanel {
  /** `<div class="member-panel">`: not a scroller, the host scrolls it. */
  readonly element: HTMLDivElement;
  /** Remove both store subscriptions, close popups it opened and abort its
   *  dialogs. Safe to call twice. */
  readonly destroy: () => void;
}

/** Whether a ban is still in force. The server never clears `banned` when a
 *  temporary ban runs out: the account is active again the moment
 *  `ban_expires` passes (auth.IsEffectivelyBanned), so the flag alone would
 *  list served bans forever. An expiry that does not parse keeps the ban in
 *  force, as it does on the server. */
function isBanInForce(user: AdminUser): boolean {
  if (!user.banned) return false;
  if (!user.ban_expires) return true;
  const expires = parseTimestamp(user.ban_expires).getTime();
  return Number.isNaN(expires) || expires > Date.now();
}

export function createMemberPanel(opts: MemberPanelOptions): MemberPanel {
  const { api, getToast, onMessageUser, onCallUser, onVoiceModerate, ui } = opts;
  const roleDeps: RoleChangeDeps & RoleMembershipDeps = {
    api,
    notify: (msg, type) => getToast()?.show(msg, type),
  };
  const blockDeps: BlockDeps = { api, notify: (msg, type) => getToast()?.show(msg, type) };
  const unsubs: Array<() => void> = [];
  // The lifetime of the dialogs this panel opens.
  const owner = new Disposable();
  const element = createElement("div", { class: "member-panel" });

  // --- Banned members ---
  // A banned user leaves the roster outright (dispatcher's MEMBER_BAN removes
  // them), so the context menu that issued the ban is the only place they ever
  // appeared — and it is gone with the row. This list, fed by the admin users
  // page, is what makes a ban reversible from the desktop client.
  const bannedSection = createElement("div", {
    class: "sidebar-banned-section",
    "data-testid": "sidebar-banned",
  });
  let bannedUsers: readonly AdminUser[] = [];

  function renderBanned(): void {
    bannedSection.replaceChildren();
    if (bannedUsers.length === 0) {
      bannedSection.style.display = "none";
      return;
    }
    bannedSection.style.display = "";
    bannedSection.appendChild(
      createElement("div", { class: "banned-header" }, shellText("members.bannedHeading")),
    );
    // The server refuses an unban of a member ranked at or above the actor, as
    // it does every other moderation; offer the button only where it can work.
    const roles = channelsStore.getState().roles;
    const actor = authStore.getState().user;
    const actorPosition = topPositionFor(roles, actor?.role_ids, actor?.role ?? "member");
    for (const user of bannedUsers) {
      const row = createElement("div", { class: "banned-row" });
      row.appendChild(createElement("span", { class: "banned-name" }, user.username));
      bannedSection.appendChild(row);
      const targetPosition = topPositionFor(roles, user.role_ids, user.role_name);
      if (!outranksPosition(actorPosition, targetPosition)) continue;
      const unbanBtn = createElement(
        "button",
        { class: "banned-unban-btn", "data-testid": "unban-member" },
        shellText("members.unban"),
      );
      unbanBtn.addEventListener("click", () => {
        void unbanMember(user.id, user.username);
      });
      row.appendChild(unbanBtn);
    }
  }

  /** Refetch, or give up quietly: this list is an affordance for moderators,
   *  and a toast on every mount would be noise for the majority of members,
   *  who never see the section at all. */
  async function fetchBanned(): Promise<void> {
    // Read the role live, like MemberList's menu gates do: a role change
    // arrives as a store update, and this section is not remounted for it.
    if (!currentUserRoleHasPermission(Permission.BAN_MEMBERS)) {
      bannedUsers = [];
      renderBanned();
      return;
    }
    try {
      bannedUsers = (await api.adminListUsers()).filter(isBanInForce);
    } catch {
      return;
    }
    renderBanned();
  }

  // One walk of the user list at a time. A burst of roster changes would
  // otherwise start a fetch each, and an older response landing last would win;
  // a change that arrives mid-walk buys exactly one more walk after it.
  let refreshing = false;
  let refreshQueued = false;
  async function refreshBanned(): Promise<void> {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshQueued = false;
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: one walk at a time
        await fetchBanned();
      } while (refreshQueued);
    } finally {
      refreshing = false;
    }
  }

  // Another moderator's ban or unban reaches this client only as a roster
  // change: member_ban drops the row and the unban's member_join restores it.
  // roleRevision moves on exactly those (and on role and profile changes, never
  // on presence or typing), and it is monotonic, so a ban and a join batched
  // into one notification still register.
  // ponytail: every roster change re-walks the user list for a moderator; a
  // banned-only server query is the upgrade if that ever costs something.
  unsubs.push(
    membersStore.subscribeSelector(
      (state) => state.roleRevision,
      () => void refreshBanned(),
    ),
  );
  // A roles_update only touches channelsStore, so a role edit that grants (or
  // revokes) BAN_MEMBERS on the viewer's role would never reach the bans list.
  unsubs.push(
    channelsStore.subscribeSelector(
      (state) => state.roles,
      () => void refreshBanned(),
    ),
  );

  async function unbanMember(userId: number, username: string): Promise<void> {
    try {
      await api.adminUnbanMember(userId);
      getToast()?.show(shellText("members.unbanned", { username }), "success");
      // No roster update needed: the server's member_join broadcast puts them
      // back, and that roster change refreshes this list too. Refresh anyway —
      // the REST call can succeed while the socket is down.
      await refreshBanned();
    } catch (err) {
      const msg = errorText(err, shellText("members.unbanFailed"));
      getToast()?.show(msg, "error");
    }
  }

  // --- Member list component ---
  const memberList = ui.createMemberList({
    currentUserRole: authStore.getState().user?.role ?? "member",
    ...(onMessageUser !== undefined ? { onMessageUser } : {}),
    ...(onCallUser !== undefined ? { onCallUser } : {}),
    ...(onVoiceModerate !== undefined
      ? {
          voiceModFor: (channelId, user) =>
            ui.buildVoiceModOptions(channelId, user, onVoiceModerate),
        }
      : {}),
    onReportUser: (userId, name) => {
      // The dialog lives as long as this panel (owner is its lifetime).
      import("../../features/reports/openers").then(
        ({ openUserReport }) => {
          if (!owner.signal.aborted) {
            openUserReport({ api, userId, name, signal: owner.signal, list: element });
          }
        },
        () => getToast()?.show(reportEntryText("reportLoadFailed"), "error"),
      );
    },
    // "Force Logout", not "Kick": the endpoint revokes the target's sessions
    // and nothing stops them signing back in — there is no membership to remove.
    onKick: async (userId, username) => {
      try {
        await api.adminKickMember(userId);
        getToast()?.show(shellText("members.forcedLogout", { username }), "success");
      } catch (err) {
        const msg = errorText(err, shellText("members.forceLogoutFailed"));
        getToast()?.show(msg, "error");
      }
    },
    // Loaded on first use: the dialog stays out of MainPage. It lives as long
    // as this panel, like the report dialog.
    onBan: (userId, username, displayName) => {
      import("../../features/moderation/BanDialog").then(
        ({ openBanDialog }) => {
          if (owner.signal.aborted) return;
          openBanDialog({
            name: displayName,
            username,
            // The server also requires MANAGE_MESSAGES to delete history.
            canDeleteMessages: currentUserRoleHasPermission(Permission.MANAGE_MESSAGES),
            submit: (req) =>
              api.adminBanMember(
                userId,
                req.reason,
                req.durationHours,
                undefined,
                req.deleteMessageSeconds,
              ),
            // The row is about to vanish from the roster; the ban has to appear
            // somewhere or it cannot be undone from here.
            onBanned: () => void refreshBanned(),
            notify: (msg, type) => getToast()?.show(msg, type),
            signal: owner.signal,
            fallbackFocus: () => memberList.focusMember(userId),
          });
        },
        () => getToast()?.show(shellText("members.banFailed"), "error"),
      );
    },
    // Loaded on first use, like the Ban dialog. The row changes when the
    // server's user_update arrives, not when the request answers.
    onChangeNickname: (userId, username, current) => {
      const member = membersStore.getState().members.get(userId);
      const name = member === undefined ? username : memberDisplayName(member);
      import("../../features/moderation/NicknameDialog").then(
        ({ openNicknameDialog }) => {
          if (owner.signal.aborted) return;
          openNicknameDialog({
            name,
            username,
            current,
            submit: (displayName) => api.setMemberNickname(userId, displayName),
            notify: (msg, type) => getToast()?.show(msg, type),
            signal: owner.signal,
            fallbackFocus: () => memberList.focusMember(userId),
          });
        },
        () => getToast()?.show(moderationText("nicknameDialog.failed"), "error"),
      );
    },
    // Loaded on first use: the dialog and request code stay out of MainPage.
    onToggleBlock: async (userId, username, block) => {
      try {
        const { toggleBlock } = await import("../../features/blocks/blockActions");
        await toggleBlock(blockDeps, userId, username, block);
      } catch {
        getToast()?.show(
          shellText(block ? "members.blockFailed" : "members.unblockFailed"),
          "error",
        );
      }
    },
    onBlockFromPopup: (userId, username, block) => {
      void import("../../features/blocks/blockActions").then(
        ({ confirmAndToggleBlock }) => confirmAndToggleBlock(blockDeps, userId, username, block),
        () =>
          getToast()?.show(
            shellText(block ? "members.blockFailed" : "members.unblockFailed"),
            "error",
          ),
      );
    },
    onChangeRole: (userId, username, newRole) =>
      changeMemberRole(roleDeps, userId, username, newRole),
    onAddRole: (userId, username, roleId) => addMemberRole(roleDeps, userId, username, roleId),
    onRemoveRole: (userId, username, roleId) =>
      removeMemberRole(roleDeps, userId, username, roleId),
    // No reason dialog yet: the menu sends an empty reason, which the server accepts.
    onTimeoutMember: async (userId, username, seconds) => {
      try {
        await api.timeoutMember(userId, seconds, "");
        const preset = TIMEOUT_PRESETS.find((p) => p.seconds === seconds);
        getToast()?.show(
          shellText("members.timedOut", {
            username,
            length: preset === undefined ? String(seconds) : shellText(preset.key),
          }),
          "success",
        );
      } catch (err) {
        getToast()?.show(errorText(err, shellText("members.timeoutFailed")), "error");
      }
    },
    onRemoveTimeout: async (userId, username) => {
      try {
        await api.liftTimeout(userId);
        getToast()?.show(shellText("members.timeoutRemoved", { username }), "success");
      } catch (err) {
        // Lifted by someone else, or expired before the click: the next
        // member_timeouts frame corrects the menu, so this is not an error.
        if (err instanceof ApiClientError && err.status === 404) {
          getToast()?.show(shellText("members.notTimedOut", { username }), "info");
          return;
        }
        getToast()?.show(errorText(err, shellText("members.removeTimeoutFailed")), "error");
      }
    },
  });
  memberList.mount(element);
  // Appended after MemberList's own root: its re-renders replace only the
  // inside of that root, so this sibling survives every roster change.
  element.appendChild(bannedSection);
  void refreshBanned();

  let destroyed = false;
  return {
    element,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const unsub of unsubs) unsub();
      owner.destroy();
      memberList.destroy?.();
    },
  };
}
