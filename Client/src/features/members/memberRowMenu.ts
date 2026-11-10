/**
 * A member row's behaviour: profile popup, keyboard navigation and the
 * moderation context menu. The open menu is module state, shared by every
 * list through the exports below.
 */

import { authStore } from "@stores/auth.store";
import { blocksStore } from "@stores/blocks.store";
import { channelsStore } from "@stores/channels.store";
import { voiceStore, type VoiceUser } from "@stores/voice.store";
import { memberDisplayName, type Member } from "@stores/members.store";
import { openMenuOnKeyboard, type OpenMenu } from "@lib/ui/contextMenu";
import { multiRoleEnabled } from "@lib/net/serverCapabilities";
import type { VoiceModMenuOptions } from "../channels/sidebar/volumeMenu";
import { withMemberMenu } from "./memberMenuLoader";
import { resolveMenuGates } from "./memberMenuGates";
import { memberTimeoutsStore } from "../moderation/store";
import { canMention, mentionInComposer } from "../messaging/activeComposer";
import { openUserProfilePopup } from "../profiles/openUserProfilePopup";
import { shellText } from "../../i18n/shell";
import type { ListItem } from "./memberModel";
import { ownPopupClosers } from "./memberListModel";
import type { MemberListOptions } from "./memberListOptions";

type VoiceModParam = VoiceModMenuOptions | string;

/** Where a member is connected, when that is a server voice channel (a DM call
 *  is excluded: its participants are not moderated from the roster). */
function serverVoiceTarget(
  userId: number,
): { readonly channelId: number; readonly user: VoiceUser } | undefined {
  const channels = channelsStore.getState().channels;
  for (const [channelId, users] of voiceStore.getState().voiceUsers) {
    const user = users.get(userId);
    if (user !== undefined && channels.get(channelId)?.type === "voice") {
      return { channelId, user };
    }
  }
  return undefined;
}

/** Whether the server says the member is timed out: `unknown` when it publishes
 *  no view (an older server). An entry is the answer; the clock is never read. */
function timeoutStateOf(userId: number): "active" | "none" | "unknown" {
  const map = memberTimeoutsStore.getState();
  if (map === null) return "unknown";
  return map.has(userId) ? "active" : "none";
}

let activeMenu: OpenMenu | null = null;

/** Bumped by every open, close and list teardown. The menu module loads lazily
 *  on the first right-click; a load that finishes after a newer open or a
 *  destroy sees a changed value and renders nothing. */
let menuOpenSeq = 0;

/** Key of the row whose menu is open: the virtual list keeps that row rendered. */
let menuRowKey: string | null = null;

/** Key of the row whose menu is open, or null. */
export function getMenuRowKey(): string | null {
  return menuRowKey;
}

export function closeActiveMenu(): void {
  menuOpenSeq += 1;
  menuRowKey = null;
  if (activeMenu !== null) {
    activeMenu.destroy();
    activeMenu = null;
  }
}

/** What a row needs from the list that owns it: arrow-key moves and its own element. */
export interface RowHooks {
  /** Move focus for an arrow/Home/End/Page key pressed on member `id`'s row. */
  readonly navigate: (key: string, id: number, from: HTMLElement) => void;
  /** Focus member `id`'s row (or the first row when it is gone) and return it. */
  readonly focusMember: (id: number) => HTMLElement | null;
}

/** Keys that move between member rows. */
const NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  // i18n-exempt: KeyboardEvent.key value, not rendered
  "Home",
  // i18n-exempt: KeyboardEvent.key value, not rendered
  "End",
  "PageUp",
  "PageDown",
]);

/** Add a drawn row's behaviour. Handlers read the member through `atEvent`
 *  at event time, never from the render-time model: the row is reused across
 *  store updates. */
export function createMemberItem(
  item: HTMLElement,
  atEvent: () => ListItem,
  opts: MemberListOptions,
  hooks: RowHooks,
  signal: AbortSignal,
): HTMLElement {
  const liveMember = (): Member => {
    const live = atEvent();
    // i18n-exempt: developer diagnostic for a programming error, never shown
    if (live.kind !== "row") throw new Error("member row bound to a non-row item");
    return live.member;
  };

  // Left-click, Enter or Space opens the profile popup (previously dead code —
  // built and tested but never mounted from anywhere). The row is a button so
  // the profile, and its Report action, is reachable from the keyboard.
  const openProfile = (anchorX: number, anchorY: number): void => {
    closeActiveMenu();
    const member = liveMember();
    const close = openUserProfilePopup({
      userId: member.id,
      anchorX,
      anchorY,
      fallbackUser: member,
      signal,
      callbacks: {
        ...(opts.onMessageUser === undefined ? {} : { onMessage: opts.onMessageUser }),
        ...(opts.onCallUser === undefined ? {} : { onCall: opts.onCallUser }),
        ...(opts.onReportUser === undefined ? {} : { onReport: opts.onReportUser }),
        ...(opts.onBlockFromPopup === undefined ? {} : { onToggleBlock: opts.onBlockFromPopup }),
        onChangeRole: opts.onChangeRole,
        ...(opts.onAddRole === undefined ? {} : { onAddRole: opts.onAddRole }),
        ...(opts.onRemoveRole === undefined ? {} : { onRemoveRole: opts.onRemoveRole }),
      },
      fallbackFocus: () => hooks.focusMember(member.id),
    });
    ownPopupClosers.add(close);
  };
  item.addEventListener("click", (e) => openProfile(e.clientX, e.clientY), { signal });
  item.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      openProfile(rect.right, rect.top);
    },
    { signal },
  );

  // Arrow keys move between member rows. Only keys pressed on the row itself
  // count (a menu or popup lives outside it), and a modified key is left alone.
  item.addEventListener(
    "keydown",
    (e) => {
      if (e.target !== item || !NAV_KEYS.has(e.key)) return;
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      hooks.navigate(e.key, liveMember().id, item);
    },
    { signal },
  );

  // Context menu for admin actions. `openContextMenu` takes viewport
  // coordinates; the keyboard path (Shift+F10 / the Menu key) anchors to the
  // row's own edge instead of a pointer position.
  /** The menu parameters that exist only when the owner supplied the matching handler. */
  const optionalMenuParams = (member: Member, voiceMod: VoiceModParam | undefined) => {
    const { onTimeoutMember, onRemoveTimeout, onMessageUser, onCallUser, onChangeNickname } = opts;
    return {
      ...(canMention() ? {} : { mentionDisabledReason: shellText("member.mentionUnavailable") }),
      ...(onMessageUser === undefined ? {} : { onMessage: () => onMessageUser(member.id) }),
      ...(onCallUser === undefined ? {} : { onCall: () => onCallUser(member.id) }),
      ...(voiceMod === undefined ? {} : { voiceMod }),
      ...(onTimeoutMember === undefined
        ? {}
        : {
            onTimeout: (seconds: number) => onTimeoutMember(member.id, member.username, seconds),
          }),
      ...(onRemoveTimeout === undefined
        ? {}
        : { onRemoveTimeout: () => onRemoveTimeout(member.id, member.username) }),
      ...(onChangeNickname === undefined
        ? {}
        : {
            onChangeNickname: () =>
              onChangeNickname(member.id, member.username, member.displayName ?? null),
          }),
    };
  };

  const openContextMenu = (clientX: number, clientY: number): void => {
    const member = liveMember();
    const isSelf = member.id === (authStore.getState().user?.id ?? 0);
    const { gates, availableRoles, outranks, showAdminActions } = resolveMenuGates(
      member,
      isSelf,
      opts.currentUserRole,
    );

    closeActiveMenu();
    const seq = menuOpenSeq;
    menuRowKey = `u:${member.id}`;

    const isBlocked = blocksStore.getState().blockedByMe.has(member.id);
    const voiceTarget = isSelf || !outranks ? undefined : serverVoiceTarget(member.id);
    const voiceMod =
      voiceTarget === undefined || opts.voiceModFor === undefined
        ? undefined
        : opts.voiceModFor(voiceTarget.channelId, voiceTarget.user);

    withMemberMenu(({ createMemberContextMenu }) => {
      if (seq !== menuOpenSeq || signal.aborted || !item.isConnected) {
        if (seq === menuOpenSeq) menuRowKey = null;
        return;
      }
      const optional = optionalMenuParams(member, voiceMod);
      // Kept on screen and re-placed when it resizes, so the ban form expanding
      // cannot push Confirm Ban and Block off the bottom at the 940x500 minimum.
      const created = createMemberContextMenu({
        x: clientX,
        y: clientY,
        userId: member.id,
        username: member.username,
        currentRole: member.role,
        availableRoles,
        showAdminActions,
        canKick: gates.canKick,
        canBan: gates.canBan,
        // PATCH role_id replaces every role, so a multi-role server manages
        // roles from the profile popup's chips instead.
        canManageRoles: gates.canManageRoles && !multiRoleEnabled(),
        canTimeout: gates.canTimeout,
        canManageNicknames: gates.canManageNicknames,
        isSelf,
        isBlocked,
        timeoutState: timeoutStateOf(member.id),
        onProfile: () => openProfile(clientX, clientY),
        onMention: () => {
          mentionInComposer(member.username);
        },
        ...optional,
        onToggleBlock: () => opts.onToggleBlock(member.id, memberDisplayName(member), !isBlocked),
        onKick: () => opts.onKick(member.id, member.username),
        onBan: () => opts.onBan(member.id, member.username, memberDisplayName(member)),
        onChangeRole: (newRole: string) => opts.onChangeRole(member.id, member.username, newRole),
        restoreFocusTo: () => hooks.focusMember(member.id),
        onClosed: () => {
          if (activeMenu !== created) return;
          activeMenu = null;
          menuRowKey = null;
        },
      });
      activeMenu = created;
    });
  };
  item.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY);
    },
    { signal },
  );
  // Keyboard entry point (A11Y-01): Shift+F10 / Menu key opens the menu,
  // focused on its first item, and Escape restores focus to this row.
  openMenuOnKeyboard(item, openContextMenu, signal);

  return item;
}
