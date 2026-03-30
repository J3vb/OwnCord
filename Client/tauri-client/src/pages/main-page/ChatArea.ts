/**
 * ChatArea — chat column DOM construction and overlay/video wiring.
 * Composes ChatHeader, message/typing/input slots, VideoGrid, pinned panel,
 * and search overlay. Extracted from MainPage to reduce orchestrator size.
 */

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { ApiClient } from "@lib/api";
import type { ToastContainer } from "@components/Toast";
import { createVideoGrid } from "@components/VideoGrid";
import type { VideoGridComponent } from "@components/VideoGrid";
import { buildChatHeader } from "./ChatHeader";
import type { ChatHeaderRefs } from "./ChatHeader";
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
  /** Full chat header refs (hash, name, topic) for DM mode updates. */
  readonly chatHeaderRefs: ChatHeaderRefs;
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
  const { api, getRoot, getChannelCtrl } = opts;

  const children: MountableComponent[] = [];
  const unsubscribers: Array<() => void> = [];

  // --- Overlay controllers ---
  const pinnedCtrl = createPinnedPanelController({
    api,
    getRoot,
    getCurrentChannelId: () => getChannelCtrl()?.currentChannelId ?? null,
    onJumpToMessage: (msgId: number) => {
      const ctrl = getChannelCtrl();
      if (ctrl == null || ctrl.messageList == null) return false;
      return ctrl.messageList.scrollToMessage(msgId);
    },
  });
  unsubscribers.push(() => { pinnedCtrl.cleanup(); });

  const searchCtrl = createSearchOverlayController({
    api,
    getRoot,
    getCurrentChannelId: () => getChannelCtrl()?.currentChannelId ?? null,
    onJumpToMessage: (_channelId: number, msgId: number) => {
      const ctrl = getChannelCtrl();
      if (ctrl == null || ctrl.messageList == null) return false;
      return ctrl.messageList.scrollToMessage(msgId);
    },
  });
  unsubscribers.push(() => { searchCtrl.cleanup(); });

  // --- Chat header ---
  const chatHeader = buildChatHeader({
    onTogglePins: () => { void pinnedCtrl.toggle(); },
    onSearchFocus: () => { searchCtrl.open(); },
  });
  const chatHeaderName = chatHeader.refs.nameEl;

  // --- Chat area element ---
  const chatArea = createElement("div", {
    class: "chat-area",
    "data-testid": "chat-area",
  });
  chatArea.appendChild(chatHeader.element);

  // --- Slots ---
  const messagesSlot = createElement("div", {
    class: "messages-slot",
    "data-testid": "messages-slot",
  });
  const typingSlot = createElement("div", {
    class: "typing-slot",
    "data-testid": "typing-slot",
  });
  const inputSlot = createElement("div", {
    class: "input-slot",
    "data-testid": "input-slot",
  });
  const videoGridSlot = createElement("div", {
    class: "video-grid-slot",
    "data-testid": "video-grid-slot",
    style: "display:none;flex:1;min-height:0",
  });

  // --- Video grid ---
  const videoGrid = createVideoGrid();
  videoGrid.mount(videoGridSlot);
  children.push(videoGrid);

  appendChildren(chatArea, messagesSlot, typingSlot, inputSlot, videoGridSlot);

  return {
    chatArea,
    slots: { messagesSlot, typingSlot, inputSlot, videoGridSlot },
    videoGrid,
    chatHeaderName,
    chatHeaderRefs: chatHeader.refs,
    searchCtrl,
    children,
    unsubscribers,
  };
}
