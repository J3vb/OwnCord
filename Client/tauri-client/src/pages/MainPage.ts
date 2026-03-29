// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.
// Delegates sidebar and chat-area DOM construction to sub-orchestrators.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { createRateLimiterSet } from "@lib/rate-limiter";
import type { VideoGridComponent } from "@components/VideoGrid";
import { createServerBanner } from "@components/ServerBanner";
import type { ServerBannerControl } from "@components/ServerBanner";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { createToastContainer } from "@components/Toast";
import type { ToastContainer } from "@components/Toast";
import { initToast, teardownToast, showToast } from "@lib/toast";
import { authStore, clearAuth, updateUser } from "@stores/auth.store";
import { closeSettings } from "@stores/ui.store";
import { updatePresence } from "@stores/members.store";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import {
  leaveVoice as voiceSessionLeave,
  cleanupAll as voiceCleanupAll,
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
  setWsClient,
  setServerHost as setLiveKitServerHost,
  setOnError as setVoiceOnError,
  clearOnError as clearVoiceOnError,
} from "@lib/livekitSession";
import { setServerHost } from "@components/message-list/renderers";
import { createQuickSwitcherManager } from "./main-page/OverlayManagers";
import {
  createMessageController,
  createPendingDeleteManager,
} from "./main-page/MessageController";
import type { MessageController } from "./main-page/MessageController";
import { createReactionController } from "./main-page/ReactionController";
import type { ReactionController } from "./main-page/ReactionController";
import { createVideoModeController } from "./main-page/VideoModeController";
import type { VideoModeController } from "./main-page/VideoModeController";
import { createChannelController } from "./main-page/ChannelController";
import type { ChannelController } from "./main-page/ChannelController";
import { createUpdateNotifier } from "@components/UpdateNotifier";
import { createSidebarArea } from "./main-page/SidebarArea";
import { createChatArea } from "./main-page/ChatArea";

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

  // Video grid (owned by ChatArea, referenced for remote video wiring)
  let videoGrid: VideoGridComponent | null = null;

  // Pending delete confirmations (double-click to delete pattern)
  const pendingDeleteManager = createPendingDeleteManager();

  // Extracted controllers (created in mount)
  let msgCtrl: MessageController | null = null;
  let reactionCtrl: ReactionController | null = null;
  let videoModeCtrl: VideoModeController | null = null;
  let channelCtrl: ChannelController | null = null;

  // Toast container for user-facing error feedback
  let toast: ToastContainer | null = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getCurrentUserId(): number {
    return authStore.getState().user?.id ?? 0;
  }

  /** Resolve display name for a channel — for DMs, use recipient username from DM store. */
  function resolveChannelName(channelId: number, channelName: string, channelType?: string): string {
    if (channelType === "dm" && (!channelName || channelName === "")) {
      const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
      if (dm !== undefined) return dm.recipient.username;
    }
    return channelName;
  }

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
        try {
          if (banner === null) return;
          if (wsState === "reconnecting") {
            banner.showReconnecting();
          } else if (wsState === "connected") {
            banner.hide();
          }
        } catch (err) {
          log.error("State change handler error", err);
        }
      }),
    );

    unsubscribers.push(
      ws.on("server_restart", (payload) => {
        try {
          if (banner !== null) {
            banner.showRestart(payload.delay_seconds);
          }
        } catch (err) {
          log.error("Server restart handler error", err);
        }
      }),
    );

    // --- Main .app row ---
    const app = createElement("div", { class: "app", "data-testid": "app-layout" });

    // --- Sidebar (server strip + channel sidebar + voice widget + user bar) ---
    const sidebar = createSidebarArea({
      ws,
      api,
      limiters,
      getRoot: () => root,
      getToast: () => toast,
      onWatchStream: (userId) => {
        if (videoModeCtrl === null) return;
        videoModeCtrl.showVideoGrid();
        videoModeCtrl.setFocus(userId);
      },
    });
    children.push(...sidebar.children);
    unsubscribers.push(...sidebar.unsubscribers);

    // --- Chat area ---
    const chatAreaResult = createChatArea({
      api,
      getRoot: () => root,
      getToast: () => toast,
      getChannelCtrl: () => channelCtrl,
    });
    children.push(...chatAreaResult.children);
    unsubscribers.push(...chatAreaResult.unsubscribers);
    videoGrid = chatAreaResult.videoGrid;

    // Video mode controller (chat/video toggle + tile management)
    videoModeCtrl = createVideoModeController({
      slots: chatAreaResult.slots,
      videoGrid: chatAreaResult.videoGrid,
      getCurrentUserId,
    });

    appendChildren(
      app,
      sidebar.sidebarWrapper,
      chatAreaResult.chatArea,
    );
    root.appendChild(app);

    // Settings overlay
    const settingsOverlay = createSettingsOverlay({
      onClose: () => closeSettings(),
      onChangePassword: async (oldPassword, newPassword) => {
        try {
          await api.changePassword(oldPassword, newPassword);
          showToast("Password changed successfully", "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to change password";
          showToast(msg, "error");
          throw err;
        }
      },
      onUpdateProfile: async (username) => {
        try {
          const updated = await api.updateProfile({ username });
          updateUser({ username: updated.username });
          showToast("Profile updated", "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to update profile";
          showToast(msg, "error");
          throw err;
        }
      },
      onLogout: () => clearAuth(),
      onDeleteAccount: async (password) => {
        await api.deleteAccount(password);
        clearAuth();
        showToast("Account deleted successfully", "success");
      },
      onStatusChange: (status) => {
        const userId = getCurrentUserId();
        if (userId !== 0) {
          updatePresence(userId, status);
        }
        if (limiters.presence.tryConsume()) {
          ws.send({ type: "presence_update", payload: { status } });
        }
      },
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
    initToast(toast);

    // Message loading controller
    msgCtrl = createMessageController({
      api,
      showError: (msg) => showToast(msg, "error"),
    });

    // Reaction controller
    reactionCtrl = createReactionController({
      ws,
      reactionsLimiter: limiters.reactions,
      getChannelId: () => channelCtrl?.currentChannelId ?? 0,
      showError: (msg) => showToast(msg, "error"),
    });

    // Channel controller (mount/destroy MessageList, TypingIndicator, MessageInput per channel)
    channelCtrl = createChannelController({
      ws,
      api,
      msgCtrl: msgCtrl!,
      pendingDeleteManager,
      reactionCtrl: reactionCtrl!,
      typingLimiter: limiters.typing,
      showToast: (msg, type) => showToast(msg, type as "success" | "error" | "info"),
      getCurrentUserId,
      slots: {
        messagesSlot: chatAreaResult.slots.messagesSlot,
        typingSlot: chatAreaResult.slots.typingSlot,
        inputSlot: chatAreaResult.slots.inputSlot,
      },
      chatHeaderName: chatAreaResult.chatHeaderName,
      chatHeaderRefs: chatAreaResult.chatHeaderRefs,
    });

    // Wire voice error callback to toast
    setVoiceOnError((msg) => showToast(msg, "error"));

    // Wire remote video callbacks to video grid
    const SCREENSHARE_TILE_ID_OFFSET = 1_000_000;
    setOnRemoteVideo((userId, stream, isScreenshare) => {
      if (videoGrid === null) return;
      const voice = voiceStore.getState();
      const channelId = voice.currentChannelId;
      if (channelId === null) return;
      const channelUsers = voice.voiceUsers.get(channelId);
      const user = channelUsers?.get(userId);
      const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
      const username = isScreenshare
        ? (user?.username ? `${user.username} (Screen)` : `User ${userId} (Screen)`)
        : (user?.username ?? `User ${userId}`);
      videoGrid.addStream(tileId, username, stream, {
        isSelf: false,
        audioUserId: userId,
        isScreenshare,
      });
      videoModeCtrl?.checkVideoMode();
    });
    setOnRemoteVideoRemoved((userId, isScreenshare) => {
      const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
      videoGrid?.removeStream(tileId);
      videoModeCtrl?.checkVideoMode();
    });
    unsubscribers.push(() => clearOnRemoteVideo());

    // Subscribe to voice store for camera/screenshare state changes only (not speaking ticks)
    let prevVideoSignature = "";
    unsubscribers.push(voiceStore.subscribe((state) => {
      try {
        // Build a lightweight signature of video-relevant state (camera + screenshare)
        let sig = (state.localCamera ? "c" : "") + (state.localScreenshare ? "s" : "");
        const channelId = state.currentChannelId;
        if (channelId !== null) {
          const users = state.voiceUsers.get(channelId);
          if (users) {
            for (const [uid, u] of users) {
              if (u.camera) sig += `:c${uid}`;
              if (u.screenshare) sig += `:s${uid}`;
            }
          }
        }
        if (sig !== prevVideoSignature) {
          prevVideoSignature = sig;
          videoModeCtrl?.checkVideoMode();
        }
      } catch (err) {
        log.error("Voice store subscription error", err);
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
        try {
          const active = getActiveChannel();
          if (active !== null) {
            if (active.type === "text") {
              videoModeCtrl?.showChat();
            }
            channelCtrl!.mountChannel(active.id, resolveChannelName(active.id, active.name, active.type), active.type);
          }
        } catch (err) {
          log.error("Channel mount failed", err);
        }
      },
    );
    unsubscribers.push(unsubChannels);

    const active = getActiveChannel();
    if (active !== null) {
      channelCtrl!.mountChannel(active.id, resolveChannelName(active.id, active.name, active.type), active.type);
    }
  }

  function destroy(): void {
    log.info("MainPage destroying");
    try {
      teardownToast();
      // Full voice cleanup — tears down room, callbacks, ws ref, serverHost.
      // Prevents stale module-level state persisting across logout/reconnect cycles.
      voiceCleanupAll();
      channelCtrl?.destroyChannel();
      channelCtrl = null;

      reactionCtrl?.destroy();
      reactionCtrl = null;
      msgCtrl = null;
      videoModeCtrl?.destroy();
      videoModeCtrl = null;

      videoGrid = null;

      for (const child of children) {
        try {
          child.destroy?.();
        } catch (err) {
          log.error("Child destroy error", err);
        }
      }
      children = [];

      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch (err) {
          log.error("Unsubscribe error", err);
        }
      }
      unsubscribers = [];

      if (banner !== null) {
        banner.destroy();
        banner = null;
      }
    } finally {
      if (root !== null) {
        root.remove();
        root = null;
      }
      container = null;
    }
  }

  return { mount, destroy };
}

export type MainPage = ReturnType<typeof createMainPage>;
