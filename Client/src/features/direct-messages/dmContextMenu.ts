/**
 * The DM row context menu, shared by the full DM list (DmSidebar) and the
 * compact preview above the channels (SidebarDmSection) so the two never drift.
 * Also owns the destructive group-leave confirm both menus open.
 */

import { createConfirmModal } from "../dialogs/confirmModal";
import type { ModalInstance } from "@lib/ui/modalFactory";
import { showContextMenu, type ContextMenuItem } from "@lib/ui/contextMenu";
import { requestsText } from "../../i18n/requests";
import { shellText } from "../../i18n/shell";
import { muteChoices, mutedUntilLabel } from "../channels/muteMenu";
import { blocksStore } from "@stores/blocks.store";
import { callUnavailableReason } from "../profiles/openUserProfilePopup";
import { copyWithToast, isDeveloperMode } from "../developer-mode/developerTools";

/** What a DM row's menu needs to know about its conversation. */
export interface DmMenuConvo {
  readonly channelId: number;
  /** The other party of a 1:1 DM; for a group, the first participant. */
  readonly userId: number;
  readonly username: string;
  readonly isGroup: boolean;
  /** The group reports an owner (a server that reports one): the leave copy says it can be rejoined. */
  readonly hasOwner?: boolean;
  /** The group has an uploaded icon: the menu offers Remove Group Icon. */
  readonly hasIcon?: boolean;
  readonly unread: boolean;
  readonly muted: boolean;
  /** When a timed mute ends (epoch ms); null for none or "until turned off". */
  readonly mutedUntil: number | null;
}

/** The actions a menu can offer. An item whose callback is absent is omitted. */
export interface DmMenuActions {
  /** Close a 1:1 DM / leave a group. */
  readonly onCloseDm?: (channelId: number) => void;
  readonly onToggleMute?: (channelId: number) => void;
  /** Set the mute outright (true: until turned off, false: unmute). Preferred
   *  over `onToggleMute`, which acts on whatever state it finds when it runs: a
   *  timed mute that ended while the menu was open would be flipped to
   *  "muted forever" by an Unmute click. */
  readonly onSetMute?: (channelId: number, muted: boolean) => void;
  /** Mute for a fixed time. Absent: the menu offers only the plain toggle. */
  readonly onMuteFor?: (channelId: number, durationMs: number) => void;
  /** Offered only while the conversation is unread. */
  readonly onMarkRead?: (channelId: number) => void;
  /** 1:1 only: open this person's profile panel. */
  readonly onOpenProfile?: (channelId: number) => void;
  /** 1:1 only: start a call in this DM. */
  readonly onCall?: (channelId: number) => void;
  /** 1:1 only: Block (`block` true) or Unblock the other person. */
  readonly onToggleBlock?: (userId: number, username: string, block: boolean) => void;
  readonly onRenameGroup?: (channelId: number) => void;
  /** Groups on a 3B-10 server only: pick and upload a new group icon. */
  readonly onChangeGroupIcon?: (channelId: number) => void;
  /** Offered only while the group has an icon. */
  readonly onRemoveGroupIcon?: (channelId: number) => void;
}

export type DmConfirmLeave = (convo: DmMenuConvo, onClose: (channelId: number) => void) => void;

/**
 * The destructive group-leave confirm, on the shared confirm preset: Cancel
 * first and focused, Escape and the backdrop cancel, focus returns to the
 * opener. Tied to the sidebar's lifetime, not the row's: a row is rebuilt on
 * every new message or call change, and that must not dismiss the prompt. The
 * sidebar closes it instead when the row leaves the list.
 */
export function openLeaveConfirm(
  convo: DmMenuConvo,
  onClose: (channelId: number) => void,
  sidebarSignal: AbortSignal,
): ModalInstance {
  return createConfirmModal({
    title: requestsText("dm.leaveConfirmTitle"),
    titleId: `dm-leave-title-${convo.channelId}`,
    body: requestsText(
      convo.hasOwner === true ? "dm.leaveConfirmBodyRejoin" : "dm.leaveConfirmBody",
      { name: convo.username },
    ),
    confirmLabel: requestsText("dm.leaveConfirm"),
    testId: "dm-leave-modal",
    confirmTestId: "dm-leave-confirm",
    cancelTestId: "dm-leave-cancel",
    signal: sidebarSignal,
    onConfirm: () => onClose(convo.channelId),
  });
}

export interface DmContextMenuRequest {
  readonly convo: DmMenuConvo;
  readonly actions: DmMenuActions;
  readonly confirmLeave: DmConfirmLeave;
  readonly x: number;
  readonly y: number;
  readonly signal: AbortSignal;
}

/** Everything one row's builders need; `id` is the conversation's channel id. */
interface RowMenu {
  readonly convo: DmMenuConvo;
  readonly actions: DmMenuActions;
  readonly id: number;
  readonly items: ContextMenuItem[];
}

function pushMarkRead(m: RowMenu): void {
  const { convo, actions, id, items } = m;
  if (convo.unread && actions.onMarkRead !== undefined) {
    const markRead = actions.onMarkRead;
    items.push({
      label: requestsText("dm.markRead"),
      testId: `dm-mark-read-${id}`,
      icon: "check-check",
      onClick: () => markRead(id),
    });
  }
}

function pushProfile(m: RowMenu): void {
  const { convo, actions, id, items } = m;
  if (!convo.isGroup && actions.onOpenProfile !== undefined) {
    const openProfile = actions.onOpenProfile;
    items.push({
      label: requestsText("dm.profile"),
      testId: `dm-profile-${id}`,
      icon: "user",
      onClick: () => openProfile(id),
    });
  }
}

// Someone you blocked (or who blocked you) cannot be called, and nothing
// can be dialled while the socket is down: show Call greyed with why.
function pushCall(m: RowMenu): void {
  const { convo, actions, id, items } = m;
  if (!convo.isGroup && actions.onCall !== undefined) {
    const call = actions.onCall;
    const reason = callUnavailableReason(convo.userId);
    items.push({
      label: requestsText("dm.call"),
      testId: `dm-call-${id}`,
      icon: "phone",
      ...(reason === undefined ? {} : { disabled: true, title: reason }),
      onClick: () => call(id),
    });
  }
}

function pushMute(m: RowMenu): void {
  const { convo, actions, id, items } = m;
  if (actions.onSetMute === undefined && actions.onToggleMute === undefined) return;
  const { onSetMute, onToggleMute } = actions;
  const setMute = (channelId: number, muted: boolean): void =>
    onSetMute !== undefined ? onSetMute(channelId, muted) : onToggleMute?.(channelId);
  const muteFor = actions.onMuteFor;
  const until = convo.muted ? mutedUntilLabel(convo.mutedUntil) : null;
  items.push({
    label: convo.muted ? requestsText("dm.unmute") : requestsText("dm.mute"),
    testId: `dm-mute-${id}`,
    icon: convo.muted ? "bell" : "bell-off",
    ...(until === null ? {} : { detail: until }),
    // The row itself is the default action (mute until turned off); the
    // flyout offers the timed choices.
    ...(convo.muted || muteFor === undefined
      ? {}
      : {
          submenu: muteChoices().map((choice): ContextMenuItem => ({
            label: choice.label,
            testId: `dm-mute-for-${choice.durationMs ?? "forever"}-${id}`,
            onClick: () =>
              choice.durationMs === undefined ? setMute(id, true) : muteFor(id, choice.durationMs),
          })),
        }),
    onClick: () => setMute(id, !convo.muted),
  });
}

function pushGroupItems(m: RowMenu): void {
  const { convo, actions, id, items } = m;
  if (!convo.isGroup) return;
  if (actions.onRenameGroup !== undefined) {
    const rename = actions.onRenameGroup;
    items.push({
      label: requestsText("dm.renameGroup"),
      testId: `dm-rename-${id}`,
      icon: "pencil",
      onClick: () => rename(id),
    });
  }
  // Any member may set or clear the icon, so this is not gated on ownership,
  // only on the server being one that reports an owner.
  if (convo.hasOwner !== true) return;
  const change = actions.onChangeGroupIcon;
  if (change !== undefined) {
    items.push({
      label: requestsText("dm.changeGroupIcon"),
      testId: `dm-change-icon-${id}`,
      icon: "image",
      onClick: () => change(id),
    });
  }
  const remove = actions.onRemoveGroupIcon;
  if (remove !== undefined && convo.hasIcon === true) {
    items.push({
      label: requestsText("dm.removeGroupIcon"),
      testId: `dm-remove-icon-${id}`,
      icon: "trash-2",
      onClick: () => remove(id),
    });
  }
}

function pushBlockAndCopyId(m: RowMenu): void {
  const { convo, actions, id, items } = m;
  if (convo.isGroup) return;
  if (actions.onToggleBlock !== undefined) {
    const toggleBlock = actions.onToggleBlock;
    const blockedByMe = blocksStore.getState().blockedByMe.has(convo.userId);
    items.push({
      label: shellText(blockedByMe ? "member.unblock" : "member.block"),
      danger: !blockedByMe,
      testId: `dm-block-${id}`,
      icon: blockedByMe ? "user" : "user-x",
      onClick: () => toggleBlock(convo.userId, convo.username, !blockedByMe),
    });
  }
  if (isDeveloperMode()) {
    items.push({
      label: shellText("member.copyId"),
      testId: `dm-copy-id-${id}`,
      icon: "copy",
      onClick: () =>
        copyWithToast(String(convo.userId), "toast.userIdCopied", "toast.userIdCopyFailed"),
    });
  }
}

function pushClose(m: RowMenu, confirmLeave: DmConfirmLeave): void {
  const { convo, actions, id, items } = m;
  if (actions.onCloseDm === undefined) return;
  const close = actions.onCloseDm;
  items.push({
    label: convo.isGroup ? requestsText("dm.leaveGroup") : requestsText("dm.close"),
    danger: true,
    testId: `dm-close-${id}`,
    icon: convo.isGroup ? "log-out" : "x",
    // The menu item has no Shift modifier, so a group always confirms here
    // too — the destructive action is destructive whichever path opens it.
    onClick: () => (convo.isGroup ? confirmLeave(convo, close) : close(id)),
  });
}

/** Open the menu for one DM row at (x, y). Opens nothing when it would be empty. */
export function openDmContextMenu(req: DmContextMenuRequest): void {
  const { convo, actions, confirmLeave, signal } = req;
  const items: ContextMenuItem[] = [];
  const m: RowMenu = { convo, actions, id: convo.channelId, items };
  pushMarkRead(m);
  pushProfile(m);
  pushCall(m);
  pushMute(m);
  pushGroupItems(m);
  pushBlockAndCopyId(m);
  pushClose(m, confirmLeave);
  if (items.length === 0) return;
  showContextMenu({
    x: req.x,
    y: req.y,
    items,
    signal,
    className: "dm-context-menu",
  });
}
