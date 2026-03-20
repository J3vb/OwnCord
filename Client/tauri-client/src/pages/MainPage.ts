// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { createRateLimiterSet } from "@lib/rate-limiter";
import { createServerStrip } from "@components/ServerStrip";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { createUserBar } from "@components/UserBar";
import { createVideoGrid } from "@components/VideoGrid";
import type { VideoGridComponent } from "@components/VideoGrid";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createMemberList } from "@components/MemberList";
import { createServerBanner } from "@components/ServerBanner";
import type { ServerBannerControl } from "@components/ServerBanner";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { createToastContainer } from "@components/Toast";
import type { ToastContainer } from "@components/Toast";
import { authStore, clearAuth, updateUser } from "@stores/auth.store";
import { closeSettings, toggleMemberList, uiStore } from "@stores/ui.store";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import {
  leaveVoice as voiceSessionLeave,
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
  setWsClient,
  setServerHost as setLiveKitServerHost,
  setOnError as setVoiceOnError,
  clearOnError as clearVoiceOnError,
} from "@lib/livekitSession";
import { buildChatHeader } from "./main-page/ChatHeader";
import { setServerHost } from "@components/message-list/renderers";
import {
  createQuickSwitcherManager,
  createInviteManagerController,
  createPinnedPanelController,
  createSearchOverlayController,
} from "./main-page/OverlayManagers";
import type { SearchOverlayController } from "./main-page/OverlayManagers";
import {
  createMessageController,
  createPendingDeleteManager,
} from "./main-page/MessageController";
import type { MessageController } from "./main-page/MessageController";
import { createReactionController } from "./main-page/ReactionController";
import type { ReactionController } from "./main-page/ReactionController";
import { createVideoModeController } from "./main-page/VideoModeController";
import type { VideoModeController } from "./main-page/VideoModeController";
import { createVoiceWidgetCallbacks, createSidebarVoiceCallbacks } from "./main-page/VoiceCallbacks";
import { createChannelController } from "./main-page/ChannelController";
import type { ChannelController } from "./main-page/ChannelController";
import { createUpdateNotifier } from "@components/UpdateNotifier";

const log = createLogger("main-page");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MainPageOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
}

// ---------------------------------------------------------------------------
// MainPage
// ---------------------------------------------------------------------------

export function createMainPage(options: MainPageOptions): MountableComponent {
  const { ws, api } = options;

  // Let voiceSession send signaling messages over this WS connection
  setWsClient(ws);

  // Set server host for resolving relative attachment URLs and LiveKit proxy
  const apiConfig = api.getConfig();
  if (apiConfig.host) {
    setServerHost(apiConfig.host);
    setLiveKitServerHost(apiConfig.host);
  }

  const limiters = createRateLimiterSet();

  let container: Element | null = null;
  let root: HTMLDivElement | null = null;

  // Child components tracked for cleanup
  let children: MountableComponent[] = [];
  let unsubscribers: Array<() => void> = [];

  // Refs we need to update reactively
  let banner: ServerBannerControl | null = null;
  let chatHeaderName: HTMLSpanElement | null = null;

  // Containers for swappable sub-components
  let messagesSlot: HTMLDivElement | null = null;
  let typingSlot: HTMLDivElement | null = null;
  let inputSlot: HTMLDivElement | null = null;

  // Video grid (owned by mount, controller manages toggle state)
  let videoGrid: VideoGridComponent | null = null;
  let videoGridSlot: HTMLDivElement | null = null;

  // Pending delete confirmations (double-click to delete pattern)
  const pendingDeleteManager = createPendingDeleteManager();

  // Extracted controllers (created in mount)
  let msgCtrl: MessageController | null = null;
  let reactionCtrl: ReactionController | null = null;
  let videoModeCtrl: VideoModeController | null = null;
  let channelCtrl: ChannelController | null = null;

  // Toast container for user-facing error feedback
  let toast: ToastContainer | null = null;

  // Active modal (channel create/edit/delete) — tracked for cleanup
  let activeModal: MountableComponent | null = null;

  // Overlay controllers — created in mount()
  let pinnedCtrl: ReturnType<typeof createPinnedPanelController> | null = null;
  let inviteCtrl: ReturnType<typeof createInviteManagerController> | null = null;
  let searchCtrl: SearchOverlayController | null = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getCurrentUserId(): number {
    return authStore.getState().user?.id ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Channel switching — rebuild channel-dependent components
  // ---------------------------------------------------------------------------

  // mountChannelComponents / destroyChannelComponents delegated to channelCtrl

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(target: Element): void {
    log.info("MainPage mounting");
    container = target;

    root = createElement("div", {
      style: "display:flex;flex-direction:column;height:100vh;width:100%",
    });

    // --- Reconnect banner ---
    banner = createServerBanner();
    root.appendChild(banner.element);

    unsubscribers.push(
      ws.onStateChange((wsState) => {
        if (banner === null) return;
        if (wsState === "reconnecting") {
          banner.showReconnecting();
        } else if (wsState === "connected") {
          banner.hide();
        }
      }),
    );

    unsubscribers.push(
      ws.on("server_restart", (payload) => {
        if (banner !== null) {
          banner.showRestart(payload.delay_seconds);
        }
      }),
    );

    // --- Main .app row ---
    const app = createElement("div", { class: "app", "data-testid": "app-layout" });

    // Server strip
    const serverStripSlot = createElement("div", {});
    const serverStrip = createServerStrip();
    serverStrip.mount(serverStripSlot);
    children.push(serverStrip);

    // Channel sidebar (composed: sidebar + voice widget + user bar)
    const sidebarWrapper = createElement("div", { class: "channel-sidebar", "data-testid": "channel-sidebar" });

    const channelSidebarSlot = createElement("div", {});

    const sidebarVoice = createSidebarVoiceCallbacks(ws);
    const channelSidebar = createChannelSidebar({
      onVoiceJoin: sidebarVoice.onVoiceJoin,
      onVoiceLeave: sidebarVoice.onVoiceLeave,
      onCreateChannel: (category) => {
        if (activeModal !== null) {
          return;
        }
        const modal = createCreateChannelModal({
          category,
          onCreate: async (data) => {
            try {
              await api.adminCreateChannel(data);
              // Server broadcasts channel_create via WS — store updates automatically
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to create channel";
              toast?.show(msg, "error");
            }
          },
          onClose: () => {
            modal.destroy?.();
            activeModal = null;
          },
        });
        activeModal = modal;
        modal.mount(document.body);
      },
      onEditChannel: (channel) => {
        if (activeModal !== null) {
          return;
        }
        const modal = createEditChannelModal({
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          onSave: async (data) => {
            try {
              await api.adminUpdateChannel(channel.id, data);
              // Server broadcasts channel_update via WS — store updates automatically
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to update channel";
              toast?.show(msg, "error");
            }
          },
          onClose: () => {
            modal.destroy?.();
            activeModal = null;
          },
        });
        activeModal = modal;
        modal.mount(document.body);
      },
      onDeleteChannel: (channel) => {
        if (activeModal !== null) {
          return;
        }
        const modal = createDeleteChannelModal({
          channelId: channel.id,
          channelName: channel.name,
          onConfirm: async () => {
            try {
              await api.adminDeleteChannel(channel.id);
              // Server broadcasts channel_delete via WS — store updates automatically
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to delete channel";
              toast?.show(msg, "error");
            }
          },
          onClose: () => {
            modal.destroy?.();
            activeModal = null;
          },
        });
        activeModal = modal;
        modal.mount(document.body);
      },
      onReorderChannel: (reorders) => {
        for (const r of reorders) {
          void api.adminUpdateChannel(r.channelId, { position: r.newPosition });
        }
      },
    });
    channelSidebar.mount(channelSidebarSlot);
    children.push(channelSidebar);

    const mountedSidebar = channelSidebarSlot.firstElementChild;
    if (mountedSidebar !== null) {
      while (mountedSidebar.firstChild !== null) {
        sidebarWrapper.appendChild(mountedSidebar.firstChild);
      }
    }

    // Invite button in sidebar header
    inviteCtrl = createInviteManagerController({
      api,
      getRoot: () => root,
      getToast: () => toast,
    });
    const sidebarHeader = sidebarWrapper.querySelector(".channel-sidebar-header");
    if (sidebarHeader !== null) {
      const inviteBtn = createElement("button", {
        class: "invite-btn",
        title: "Invite",
      }, "Invite");
      inviteBtn.addEventListener("click", () => {
        void inviteCtrl!.open();
      });
      sidebarHeader.appendChild(inviteBtn);
    }
    unsubscribers.push(() => { inviteCtrl?.cleanup(); });

    // Voice widget
    const voiceWidgetSlot = createElement("div", {});
    const voiceWidget = createVoiceWidget(
      createVoiceWidgetCallbacks(ws, limiters),
    );
    voiceWidget.mount(voiceWidgetSlot);
    children.push(voiceWidget);
    sidebarWrapper.appendChild(voiceWidgetSlot);

    // User bar
    const userBarSlot = createElement("div", {});
    const userBar = createUserBar();
    userBar.mount(userBarSlot);
    children.push(userBar);
    sidebarWrapper.appendChild(userBarSlot);

    // Chat area
    const chatArea = createElement("div", { class: "chat-area", "data-testid": "chat-area" });

    pinnedCtrl = createPinnedPanelController({
      api,
      getRoot: () => root,
      getToast: () => toast,
      getCurrentChannelId: () => channelCtrl?.currentChannelId ?? null,
      onJumpToMessage: (msgId: number) => {
        if (channelCtrl?.messageList === null || channelCtrl?.messageList === undefined) return false;
        return channelCtrl.messageList.scrollToMessage(msgId);
      },
    });
    unsubscribers.push(() => { pinnedCtrl?.cleanup(); });

    // Search overlay controller
    searchCtrl = createSearchOverlayController({
      api,
      getRoot: () => root,
      getToast: () => toast,
      getCurrentChannelId: () => channelCtrl?.currentChannelId ?? null,
      onJumpToMessage: (_channelId: number, msgId: number) => {
        if (channelCtrl?.messageList === null || channelCtrl?.messageList === undefined) return false;
        return channelCtrl.messageList.scrollToMessage(msgId);
      },
    });
    unsubscribers.push(() => { searchCtrl?.cleanup(); });

    const chatHeader = buildChatHeader({
      onTogglePins: () => { void pinnedCtrl!.toggle(); },
      onToggleMembers: () => toggleMemberList(),
      onSearchFocus: () => { searchCtrl?.open(); },
    });
    chatHeaderName = chatHeader.refs.nameEl;
    chatArea.appendChild(chatHeader.element);

    messagesSlot = createElement("div", { class: "messages-slot", "data-testid": "messages-slot" });
    typingSlot = createElement("div", { class: "typing-slot", "data-testid": "typing-slot" });
    inputSlot = createElement("div", { class: "input-slot", "data-testid": "input-slot" });

    videoGridSlot = createElement("div", {
      class: "video-grid-slot",
      "data-testid": "video-grid-slot",
      style: "display:none;flex:1;min-height:0",
    }) as HTMLDivElement;
    videoGrid = createVideoGrid();
    videoGrid.mount(videoGridSlot);
    children.push(videoGrid);

    // Video mode controller (chat/video toggle + tile management)
    videoModeCtrl = createVideoModeController({
      slots: {
        messagesSlot: messagesSlot as HTMLDivElement,
        typingSlot: typingSlot as HTMLDivElement,
        inputSlot: inputSlot as HTMLDivElement,
        videoGridSlot: videoGridSlot as HTMLDivElement,
      },
      videoGrid,
      getCurrentUserId,
    });

    appendChildren(chatArea, messagesSlot, typingSlot, inputSlot, videoGridSlot);

    // Member list
    const memberListSlot = createElement("div", {});
    const memberList = createMemberList();
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

    appendChildren(app, serverStripSlot, sidebarWrapper, chatArea, memberListSlot);
    root.appendChild(app);

    // Settings overlay
    const settingsOverlay = createSettingsOverlay({
      onClose: () => closeSettings(),
      onChangePassword: async (oldPassword, newPassword) => {
        try {
          await api.changePassword(oldPassword, newPassword);
          toast?.show("Password changed successfully", "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to change password";
          toast?.show(msg, "error");
          throw err;
        }
      },
      onUpdateProfile: async (username) => {
        try {
          const updated = await api.updateProfile({ username });
          updateUser({ username: updated.username });
          toast?.show("Profile updated", "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to update profile";
          toast?.show(msg, "error");
          throw err;
        }
      },
      onLogout: () => clearAuth(),
    });
    settingsOverlay.mount(root);
    children.push(settingsOverlay);

    // Quick switcher (Ctrl+K)
    const qsManager = createQuickSwitcherManager(() => root);
    unsubscribers.push(qsManager.attach());

    // Toast container
    toast = createToastContainer();
    toast.mount(root);
    children.push(toast);

    // Message loading controller
    msgCtrl = createMessageController({
      api,
      showError: (msg) => toast?.show(msg, "error"),
    });

    // Reaction controller
    reactionCtrl = createReactionController({
      ws,
      reactionsLimiter: limiters.reactions,
      getChannelId: () => channelCtrl?.currentChannelId ?? 0,
      showError: (msg) => toast?.show(msg, "error"),
    });

    // Channel controller (mount/destroy MessageList, TypingIndicator, MessageInput per channel)
    channelCtrl = createChannelController({
      ws,
      api,
      msgCtrl: msgCtrl!,
      pendingDeleteManager,
      reactionCtrl: reactionCtrl!,
      typingLimiter: limiters.typing,
      showToast: (msg, type) => toast?.show(msg, type as "success" | "error" | "info"),
      getCurrentUserId,
      slots: {
        messagesSlot: messagesSlot as HTMLDivElement,
        typingSlot: typingSlot as HTMLDivElement,
        inputSlot: inputSlot as HTMLDivElement,
      },
      chatHeaderName,
    });

    // Wire voice error callback to toast
    setVoiceOnError((msg) => toast?.show(msg, "error"));

    // Wire remote video callbacks to video grid
    setOnRemoteVideo((userId, stream) => {
      if (videoGrid === null) return;
      const voice = voiceStore.getState();
      const channelId = voice.currentChannelId;
      if (channelId === null) return;
      const channelUsers = voice.voiceUsers.get(channelId);
      const user = channelUsers?.get(userId);
      const username = user?.username ?? `User ${userId}`;
      videoGrid.addStream(userId, username, stream);
      videoModeCtrl?.checkVideoMode();
    });
    setOnRemoteVideoRemoved((userId) => {
      videoGrid?.removeStream(userId);
      videoModeCtrl?.checkVideoMode();
    });
    unsubscribers.push(() => clearOnRemoteVideo());

    // Subscribe to voice store for camera state changes only (not speaking ticks)
    let prevLocalCamera = voiceStore.getState().localCamera;
    let prevCameraSignature = "";
    unsubscribers.push(voiceStore.subscribe((state) => {
      // Build a lightweight signature of camera-relevant state
      let sig = state.localCamera ? "1" : "0";
      const channelId = state.currentChannelId;
      if (channelId !== null) {
        const users = state.voiceUsers.get(channelId);
        if (users) {
          for (const [uid, u] of users) {
            if (u.camera) sig += `:${uid}`;
          }
        }
      }
      if (sig !== prevCameraSignature || state.localCamera !== prevLocalCamera) {
        prevCameraSignature = sig;
        prevLocalCamera = state.localCamera;
        videoModeCtrl?.checkVideoMode();
      }
    }));

    // Auto-update notifier — checks server for newer client version
    if (apiConfig.host) {
      const serverUrl = `https://${apiConfig.host}`;
      const updateNotifier = createUpdateNotifier({ serverUrl });
      updateNotifier.mount(root);
      children.push(updateNotifier);
    }

    container.appendChild(root);

    // --- Subscribe to channel changes ---
    const unsubChannels = channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => {
        const active = getActiveChannel();
        if (active !== null) {
          channelCtrl!.mountChannel(active.id, active.name);
        }
      },
    );
    unsubscribers.push(unsubChannels);

    const active = getActiveChannel();
    if (active !== null) {
      channelCtrl!.mountChannel(active.id, active.name);
    }
  }

  function destroy(): void {
    log.info("MainPage destroying");
    // Clean up voice session before destroying UI — prevents stale
    // module-level state persisting across logout/reconnect cycles.
    voiceSessionLeave(false);
    clearVoiceOnError();
    clearOnRemoteVideo();
    channelCtrl?.destroyChannel();
    channelCtrl = null;

    reactionCtrl?.destroy();
    reactionCtrl = null;
    msgCtrl = null;
    videoModeCtrl?.destroy();
    videoModeCtrl = null;

    if (activeModal !== null) {
      activeModal.destroy?.();
      activeModal = null;
    }

    if (videoGrid !== null) {
      videoGrid.destroy?.();
      videoGrid = null;
    }
    videoGridSlot = null;

    for (const child of children) {
      child.destroy?.();
    }
    children = [];

    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers = [];

    if (banner !== null) {
      banner.destroy();
      banner = null;
    }

    if (root !== null) {
      root.remove();
      root = null;
    }
    container = null;
  }

  return { mount, destroy };
}

export type MainPage = ReturnType<typeof createMainPage>;
