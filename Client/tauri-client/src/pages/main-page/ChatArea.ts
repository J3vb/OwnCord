/**
 * ChatArea — chat column DOM construction and overlay/video wiring.
 * Composes ChatHeader, message/typing/input slots, VideoGrid, pinned panel,
 * search overlay, and MemberList. Extracted from MainPage to reduce orchestrator size.
 */

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { ApiClient } from "@lib/api";
import type { ToastContainer } from "@components/Toast";
import { createVideoGrid } from "@components/VideoGrid";
import type { VideoGridComponent } from "@components/VideoGrid";
import { createMemberList } from "@components/MemberList";
import { authStore } from "@stores/auth.store";
import { toggleMemberList, uiStore } from "@stores/ui.store";
import { buildChatHeader } from "./ChatHeader";
import {
  createPinnedPanelController,
  createSearchOverlayController,
} from "./OverlayManagers";
import type { SearchOverlayController } from "./OverlayManagers";
import type { ChannelController } from "./ChannelController";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatAreaOptions {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getToast: () => ToastContainer | null;
  readonly getChannelCtrl: () => ChannelController | null;
}

export interface ChatAreaResult {
  /** The chat area element (center column). */
  readonly chatArea: HTMLDivElement;
  /** The member list slot element (right column). */
  readonly memberListSlot: HTMLDivElement;
  /** Message/typing/input/videoGrid slots for ChannelController and VideoModeController. */
  readonly slots: {
    readonly messagesSlot: HTMLDivElement;
    readonly typingSlot: HTMLDivElement;
    readonly inputSlot: HTMLDivElement;
    readonly videoGridSlot: HTMLDivElement;
  };
  /** The VideoGrid component instance. */
  readonly videoGrid: VideoGridComponent;
  /** The chat header channel-name element (updated reactively). */
  readonly chatHeaderName: HTMLSpanElement | null;
  /** The search overlay controller. */
  readonly searchCtrl: SearchOverlayController;
  /** All child MountableComponents for cleanup. */
  readonly children: readonly MountableComponent[];
  /** Unsubscribe / cleanup functions. */
  readonly unsubscribers: readonly (() => void)[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatArea(opts: ChatAreaOptions): ChatAreaResult {
  const { api, getRoot, getToast, getChannelCtrl } = opts;

  const children: MountableComponent[] = [];
  const unsubscribers: Array<() => void> = [];

  // --- Overlay controllers ---
  const pinnedCtrl = createPinnedPanelController({
    api,
    getRoot,
    getToast,
    getCurrentChannelId: () => getChannelCtrl()?.currentChannelId ?? null,
    onJumpToMessage: (msgId: number) => {
      const ctrl = getChannelCtrl();
      if (ctrl?.messageList === null || ctrl?.messageList === undefined) return false;
      return ctrl.messageList.scrollToMessage(msgId);
    },
  });
  unsubscribers.push(() => { pinnedCtrl.cleanup(); });

  const searchCtrl = createSearchOverlayController({
    api,
    getRoot,
    getToast,
    getCurrentChannelId: () => getChannelCtrl()?.currentChannelId ?? null,
    onJumpToMessage: (_channelId: number, msgId: number) => {
      const ctrl = getChannelCtrl();
      if (ctrl?.messageList === null || ctrl?.messageList === undefined) return false;
      return ctrl.messageList.scrollToMessage(msgId);
    },
  });
  unsubscribers.push(() => { searchCtrl.cleanup(); });

  // --- Chat header ---
  const chatHeader = buildChatHeader({
    onTogglePins: () => { void pinnedCtrl.toggle(); },
    onToggleMembers: () => toggleMemberList(),
    onSearchFocus: () => { searchCtrl.open(); },
  });
  const chatHeaderName = chatHeader.refs.nameEl;

  // --- Chat area element ---
  const chatArea = createElement("div", {
    class: "chat-area",
    "data-testid": "chat-area",
  }) as HTMLDivElement;
  chatArea.appendChild(chatHeader.element);

  // --- Slots ---
  const messagesSlot = createElement("div", {
    class: "messages-slot",
    "data-testid": "messages-slot",
  }) as HTMLDivElement;
  const typingSlot = createElement("div", {
    class: "typing-slot",
    "data-testid": "typing-slot",
  }) as HTMLDivElement;
  const inputSlot = createElement("div", {
    class: "input-slot",
    "data-testid": "input-slot",
  }) as HTMLDivElement;
  const videoGridSlot = createElement("div", {
    class: "video-grid-slot",
    "data-testid": "video-grid-slot",
    style: "display:none;flex:1;min-height:0",
  }) as HTMLDivElement;

  // --- Video grid ---
  const videoGrid = createVideoGrid();
  videoGrid.mount(videoGridSlot);
  children.push(videoGrid);

  appendChildren(chatArea, messagesSlot, typingSlot, inputSlot, videoGridSlot);

  // --- Member list ---
  const memberListSlot = createElement("div", {}) as HTMLDivElement;
  const memberList = createMemberList({
    currentUserRole: authStore.getState().user?.role ?? "member",
    onKick: async (userId, username) => {
      try {
        await api.adminKickMember(userId);
        getToast()?.show(`Kicked ${username}`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to kick member";
        getToast()?.show(msg, "error");
      }
    },
    onBan: async (userId, username) => {
      try {
        await api.adminBanMember(userId);
        getToast()?.show(`Banned ${username}`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to ban member";
        getToast()?.show(msg, "error");
      }
    },
    onChangeRole: async (userId, username, newRole) => {
      const roleNameToId: Record<string, number> = { owner: 1, admin: 2, moderator: 3, member: 4 };
      const roleId = roleNameToId[newRole];
      if (roleId === undefined) return;
      try {
        await api.adminChangeRole(userId, roleId);
        getToast()?.show(`Changed ${username}'s role to ${newRole}`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to change role";
        getToast()?.show(msg, "error");
      }
    },
  });
  memberList.mount(memberListSlot);
  children.push(memberList);

  const memberListEl = memberListSlot.querySelector(".member-list");
  const unsubMemberList = uiStore.subscribeSelector(
    (s) => s.memberListVisible,
    (visible) => {
      if (memberListEl !== null) {
        memberListEl.classList.toggle("hidden", !visible);
      }
    },
  );
  unsubscribers.push(unsubMemberList);

  return {
    chatArea,
    memberListSlot,
    slots: { messagesSlot, typingSlot, inputSlot, videoGridSlot },
    videoGrid,
    chatHeaderName,
    searchCtrl,
    children,
    unsubscribers,
  };
}
