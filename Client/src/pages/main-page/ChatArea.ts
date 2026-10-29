/**
 * ChatArea — chat column DOM construction and overlay/video wiring.
 * Composes ChatHeader, message/typing/input slots, VideoGrid, pinned panel,
 * and search overlay. Extracted from MainPage to reduce orchestrator size.
 */

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { ApiClient } from "@lib/api";
import type { ToastContainer } from "@components/Toast";
import { createLazyVideoGrid } from "./lazyVideoGrid";
import type { LazyVideoGrid } from "./lazyVideoGrid";
import { buildChatHeader } from "./ChatHeader";
import type { ChatHeaderRefs } from "./ChatHeader";
import { createPinnedPanelController, createSearchOverlayController } from "./OverlayManagers";
import type { SearchOverlayController } from "./OverlayManagers";
import type { ChannelController } from "./ChannelController";
import { createMessageJumper } from "./MessageJump";
import { setMessageJumpHandler } from "@lib/message-navigation";
import { navigateToChannel } from "@lib/channel-navigation";
import { channelsStore } from "@stores/channels.store";
import { channelBitOrRole } from "@lib/permissions";
import { nsfwConsentRequired } from "../../features/content-consent/nsfw";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatAreaOptions {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getToast: () => ToastContainer | null;
  readonly getChannelCtrl: () => ChannelController | null;
  readonly onToggleDmProfile?: () => void;
  /** Show or hide the group DM member panel. */
  readonly onToggleMemberList?: () => void;
  readonly onToggleGuildMemberList?: () => void;
  /** Start a call in the current DM (join its voice channel + ring). */
  readonly onStartCall?: () => void;
  /** Start a call in the current DM with the camera on. */
  readonly onStartVideoCall?: () => void;
  /** Rename the open group DM (the header's group name click). */
  readonly onRenameGroup?: () => void;
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
  /** Holds the DM call panel, between the header and the messages. */
  readonly callPanelSlot: HTMLDivElement;
  /** The VideoGrid component instance. */
  readonly videoGrid: LazyVideoGrid;
  /** The chat header channel-name element (updated reactively). */
  readonly chatHeaderName: HTMLSpanElement | null;
  /** Full chat header refs (hash, name, topic) for DM mode updates. */
  readonly chatHeaderRefs: ChatHeaderRefs;
  /** The header's narrow-width sidebar toggle, for the drawer controller. */
  readonly sidebarToggle: HTMLButtonElement;
  /** The search overlay controller. */
  readonly searchCtrl: SearchOverlayController;
  /** Close the pinned-messages panel if it is open. */
  readonly closePinnedPanel: () => void;
  /** Open the pinned-messages panel; a no-op when it is already open. */
  readonly openPinnedPanel: () => Promise<void>;
  /** Where a thread's side panel mounts, beside the chat area. */
  readonly threadSlot: HTMLDivElement;
  /** Slot for the DM profile sidebar (right panel, sibling of chat area). */
  readonly dmProfileSlot: HTMLDivElement;
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

  // --- Message jumping ---
  // One implementation for every jump affordance. Registering it globally lets
  // parts that have no handle on this page — permalink chips inside a rendered
  // message, owncord://message links from the OS — reach the same path.
  const jumper = createMessageJumper({ api, getChannelCtrl });
  unsubscribers.push(
    setMessageJumpHandler((channelId, messageId) => {
      // No message: a call notification, which opens the DM itself.
      if (messageId === undefined) navigateToChannel(channelId);
      else void jumper.jumpTo(channelId, messageId);
    }),
  );

  // --- Overlay controllers ---
  const pinnedCtrl = createPinnedPanelController({
    api,
    getRoot,
    getCurrentChannelId: () => getChannelCtrl()?.currentChannelId ?? null,
    // A DM participant may pin; a channel follows the server's per-channel
    // can_pin (MANAGE_MESSAGES on an older server) — mirroring the server's gate so the panel is read-only rather than
    // offering an unpin the server refuses (F1).
    canPin: (channelId: number) => {
      const channel = channelsStore.getState().channels.get(channelId);
      return channel?.type === "dm" || channelBitOrRole(channel?.canPin);
    },
    // The panel forwards the channel it was opened for (captured at open
    // time), not whatever is active now — the active channel can change
    // while the panel is sitting open, and re-deriving it live here would
    // silently jump in the wrong channel.
    onJumpToMessage: (channelId: number, msgId: number) => {
      void jumper.jumpTo(channelId, msgId);
    },
  });
  unsubscribers.push(() => {
    pinnedCtrl.cleanup();
  });

  const searchCtrl = createSearchOverlayController({
    api,
    getRoot,
    getCurrentChannelId: () => getChannelCtrl()?.currentChannelId ?? null,
    onJumpToMessage: (channelId: number, msgId: number) => {
      void jumper.jumpTo(channelId, msgId);
    },
  });
  unsubscribers.push(() => {
    searchCtrl.cleanup();
  });

  // A channel that becomes gated takes its content out of the overlays,
  // mounted or not: the pins panel outlives a channel switch and a
  // server-wide search spans every channel.
  let knownChannels = channelsStore.getState().channels;
  unsubscribers.push(
    channelsStore.subscribeSelector(
      (s) => s.channels,
      (channels) => {
        const previous = knownChannels;
        knownChannels = channels;
        for (const [id, channel] of channels) {
          const before = previous.get(id);
          if (before === undefined || nsfwConsentRequired(before)) continue;
          if (!nsfwConsentRequired(channel)) continue;
          pinnedCtrl.closeFor(id);
          searchCtrl.cleanup();
        }
      },
    ),
  );

  // --- Chat header ---
  const chatHeader = buildChatHeader({
    onTogglePins: () => {
      void pinnedCtrl.toggle();
    },
    onToggleThreads: (anchor) => getChannelCtrl()?.toggleThreadList(anchor),
    onSearchFocus: () => {
      searchCtrl.open();
    },
    onToggleDmProfile: opts.onToggleDmProfile,
    onToggleMemberList: opts.onToggleMemberList,
    onToggleGuildMemberList: opts.onToggleGuildMemberList,
    onStartCall: opts.onStartCall,
    onStartVideoCall: opts.onStartVideoCall,
    onRenameGroup: opts.onRenameGroup,
  });
  const chatHeaderName = chatHeader.refs.nameEl;

  // --- Chat area element ---
  const chatArea = createElement("div", {
    class: "chat-area",
    "data-testid": "chat-area",
  });
  chatArea.appendChild(chatHeader.element);

  // --- Slots ---
  const callPanelSlot = createElement("div", {
    class: "call-panel-slot",
    "data-testid": "call-panel-slot",
    style: "display:contents",
  });
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
  // The grid's code loads on first use; the proxy answers until then.
  const videoGrid = createLazyVideoGrid();
  videoGrid.mount(videoGridSlot);
  children.push(videoGrid);

  appendChildren(chatArea, callPanelSlot, messagesSlot, typingSlot, inputSlot, videoGridSlot);

  // --- Thread panel slot (sibling of chatArea; hidden until a thread is open) ---
  const threadSlot = createElement("div", {
    class: "thread-panel-slot",
    "data-testid": "thread-panel-slot",
  });

  // --- DM profile sidebar slot (sits beside chatArea in the .app flex row) ---
  const dmProfileSlot = createElement("div", {
    class: "dm-profile-slot",
    "data-testid": "dm-profile-slot",
  });

  return {
    chatArea,
    slots: { messagesSlot, typingSlot, inputSlot, videoGridSlot },
    callPanelSlot,
    videoGrid,
    chatHeaderName,
    chatHeaderRefs: chatHeader.refs,
    sidebarToggle: chatHeader.refs.sidebarToggle,
    searchCtrl,
    closePinnedPanel: pinnedCtrl.cleanup,
    openPinnedPanel: pinnedCtrl.open,
    threadSlot,
    dmProfileSlot,
    children,
    unsubscribers,
  };
}
