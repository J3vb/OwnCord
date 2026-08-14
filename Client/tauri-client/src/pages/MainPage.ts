// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.
// Delegates sidebar and chat-area DOM construction to sub-orchestrators.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { UserStatus } from "@lib/types";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { createRateLimiterSet } from "@lib/rate-limiter";
import type { VideoGridComponent } from "@components/VideoGrid";
import { createServerBanner, applyConnectionStatus } from "@components/ServerBanner";
import type { ServerBannerControl } from "@components/ServerBanner";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { createToastContainer } from "@components/Toast";
import type { ToastContainer } from "@components/Toast";
import { initToast, teardownToast, showToast } from "@lib/toast";
import { logout } from "@lib/logout";
import { authStore, clearAuth, updateUser } from "@stores/auth.store";
import { closeSettings, uiStore } from "@stores/ui.store";
import { updatePresence } from "@stores/members.store";
import { loadUserStatus } from "@lib/userStatus";
import { startAutoIdle, type AutoIdleController } from "@lib/autoIdle";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { clearCustomEmoji } from "@stores/emoji.store";
import {
  cleanupAll as voiceCleanupAll,
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
  setWsClient,
  setServerHost as setLiveKitServerHost,
  setOnError as setVoiceOnError,
} from "@lib/livekitSession";
import { setServerHost } from "@components/message-list/renderers";
import { clearAttachmentCaches } from "@components/message-list/attachments";
import { closeActiveLightbox } from "@components/message-list/media";
import {
  setReactionUsersFetcher,
  clearReactionUsersCache,
} from "@components/message-list/reaction-tooltip";
import { setMarkReadSender } from "@lib/read-state";
import { setChannelMutesHost } from "@lib/channel-mutes";
import { setNsfwGateHost } from "@lib/nsfw-gate";
import { setAudioVolumeHost } from "@lib/audioElements";
import { createQuickSwitcherManager } from "./main-page/OverlayManagers";
import { attachGlobalKeybinds } from "./main-page/GlobalKeybinds";
import { createVoiceWidgetCallbacks } from "./main-page/VoiceCallbacks";
import { createMessageController, createPendingDeleteManager } from "./main-page/MessageController";
import type { MessageController } from "./main-page/MessageController";
import { createReactionController } from "./main-page/ReactionController";
import type { ReactionController } from "./main-page/ReactionController";
import { createVideoModeController } from "./main-page/VideoModeController";
import type { VideoModeController } from "./main-page/VideoModeController";
import { createChannelController } from "./main-page/ChannelController";
import type { ChannelController } from "./main-page/ChannelController";
import { createUpdateNotifier } from "@components/UpdateNotifier";
import { createDmProfileSidebar } from "@components/DmProfileSidebar";
import type { DmProfileSidebarComponent } from "@components/DmProfileSidebar";
import { createIncomingCallBanner } from "@components/IncomingCallBanner";
import type { IncomingCallBannerComponent } from "@components/IncomingCallBanner";
import { createRingController } from "@lib/call-ring";
import type { RingController } from "@lib/call-ring";
import { startRingChime, stopRingChime } from "@lib/notifications";
import { createSidebarVoiceCallbacks } from "./main-page/VoiceCallbacks";
import { createSidebarArea } from "./main-page/SidebarArea";
import { createChatArea } from "./main-page/ChatArea";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";

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

  // Channel ids are only unique per server, so anything persisted under a bare
  // channel id collides across profiles in the multi-server client. Scope both
  // stores to the connected host — including the null case, so a disconnect
  // cannot leave the previous server's scope armed for the next connection.
  setChannelMutesHost(apiConfig.host ?? null);
  setNsfwGateHost(apiConfig.host ?? null);
  setAudioVolumeHost(apiConfig.host ?? null);

  // "Mark as Read" affordances need the socket but are reached from deep inside
  // the sidebar; register the sender once instead of threading ws through.
  setMarkReadSender((channelId) => {
    ws.send({ type: "mark_read", payload: { channel_id: channelId } });
  });

  // The who-reacted tooltip fetches on hover; give it the live REST client the
  // same way the attachment renderer is given the server host.
  clearReactionUsersCache();
  setReactionUsersFetcher(async (channelId, messageId, emoji) => {
    const res = await api.getReactionUsers(channelId, messageId, emoji);
    return res.users;
  });

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
  /** Inactivity watcher that flips the status to idle after ten quiet
   *  minutes. Started once the socket is up, torn down with the page. */
  let autoIdle: AutoIdleController | null = null;

  // Toast container for user-facing error feedback
  let toast: ToastContainer | null = null;

  // DM profile sidebar (right panel, toggled via DM header click)
  let dmProfileSidebar: DmProfileSidebarComponent | null = null;
  let dmProfileSlot: HTMLDivElement | null = null;

  // DM calls: the banner draws a ring, the controller owns its lifetime.
  let callBanner: IncomingCallBannerComponent | null = null;
  let ringCtrl: RingController | null = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getCurrentUserId(): number {
    return authStore.getState().user?.id ?? 0;
  }

  /**
   * Re-assert the status the user picked, if the server disagrees.
   *
   * This used to fire on every connect, because the server stamped everyone
   * online at handshake and the client had to race to correct it — which is
   * what made a chosen Do Not Disturb (and "appear offline") flash online on
   * every reconnect. The server now reads the saved status and announces
   * *that*, so this is a no-op in the normal case and only speaks up when the
   * two genuinely differ (an older server, or a status changed while the
   * socket was down).
   */
  function restoreSavedPresence(): void {
    const status = loadUserStatus();
    const serverStatus = authStore.getState().user?.status;
    if (serverStatus === status) return;
    const userId = getCurrentUserId();
    if (userId !== 0) {
      updatePresence(userId, status);
    }
    if (limiters.presence.tryConsume()) {
      ws.send({ type: "presence_update", payload: { status } });
    }
  }

  /** Send a presence change and reflect it locally. Shared by the settings
   *  tab, the user bar and the auto-idle timer so all three agree. */
  function applyPresence(status: UserStatus): void {
    const userId = getCurrentUserId();
    if (userId !== 0) {
      updatePresence(userId, status);
    }
    if (limiters.presence.tryConsume()) {
      ws.send({ type: "presence_update", payload: { status } });
    }
  }

  /**
   * Resolve a channel's display name. A DM is named by who is in it (or, for a
   * group, by its name), and the store is the authority on that — the channels
   * store carries a synthesised copy that can lag a rename or a departure.
   */
  function resolveChannelName(
    channelId: number,
    channelName: string,
    channelType?: string,
  ): string {
    if (channelType === "dm") {
      const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
      if (dm !== undefined) return dmDisplayName(dm);
    }
    return channelName;
  }

  /** Toggle the DM profile sidebar open/closed for the current DM partner. */
  function toggleDmProfile(): void {
    if (dmProfileSlot === null) return;

    // If already open, close it
    if (dmProfileSidebar !== null) {
      dmProfileSidebar.destroy?.();
      dmProfileSidebar = null;
      return;
    }

    // Only open in DM mode
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;

    const dmChannel = dmStore.getState().channels.find((c) => c.channelId === active.id);
    // A group has no single "recipient" — dm.store.ts documents .recipient as
    // just the first of .participants for a group, with group-correct code
    // expected to read .participants instead. A 1:1 profile panel built from
    // it would present one arbitrary member's identity as the conversation.
    if (dmChannel === undefined || dmChannel.isGroup) return;

    const recipient = dmChannel.recipient;
    const status =
      recipient.status === "online" ||
      recipient.status === "idle" ||
      recipient.status === "dnd" ||
      recipient.status === "offline"
        ? recipient.status
        : ("offline" as const);

    dmProfileSidebar = createDmProfileSidebar({
      user: {
        id: recipient.id,
        username: recipient.username,
        avatar: recipient.avatar || null,
        status,
        about: null,
        joinDate: null,
      },
      onClose: () => {
        dmProfileSidebar?.destroy?.();
        dmProfileSidebar = null;
      },
    });
    dmProfileSidebar.mount(dmProfileSlot);
  }

  /**
   * Start a call in the currently open DM: join its voice channel and ring the
   * other participants.
   *
   * Joining first is deliberate. A "call" is presence in the DM's voice
   * channel, so the ring is only truthful once the caller is actually there —
   * ringing first would offer an empty room to whoever accepts.
   */
  function startCall(): void {
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;
    // onVoiceJoin silently refuses to join when the socket is down
    // (VoiceCallbacks.ts's socketLive() guard) — without this check the ring
    // and "Calling…" toast fire anyway, promising a call nobody can hear.
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast("Not connected", "error");
      return;
    }
    createSidebarVoiceCallbacks(ws).onVoiceJoin(active.id);
    ws.send({ type: "call_ring", payload: { channel_id: active.id } });
    showToast("Calling…", "info");
  }

  /** Close the DM profile sidebar if open. */
  function closeDmProfile(): void {
    if (dmProfileSidebar !== null) {
      dmProfileSidebar.destroy?.();
      dmProfileSidebar = null;
    }
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

    // Banner reacts to the store-backed connection status (single source of
    // truth, docs/architecture/ux §3). "disconnected" keeps the banner visible
    // — a fatal drop navigates away via clearAuth, and anything short of that
    // must not leave a stale "Reconnecting..." on screen.
    unsubscribers.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        (status) => {
          try {
            if (status === "connected") restoreSavedPresence();
            if (banner === null) return;
            applyConnectionStatus(banner, status);
          } catch (err) {
            log.error("Connection status handler error", err);
          }
        },
      ),
    );
    // Synchronous initial sync: the selector subscription baselines on the
    // current value and only fires on change, so a MainPage mounted mid-outage
    // (status already "reconnecting") would otherwise never show the banner —
    // the whole retry cycle maps to the same 3-state value.
    applyConnectionStatus(banner, uiStore.getState().connectionStatus);
    if (uiStore.getState().connectionStatus === "connected") restoreSavedPresence();

    // Auto-idle. It only ever moves a status it is itself responsible for
    // (see @lib/autoIdle) — a manually chosen Idle, Do Not Disturb or
    // Invisible is never touched — so it is safe to leave running for the
    // whole session.
    autoIdle = startAutoIdle({ onStatusChange: (status) => applyPresence(status) });

    unsubscribers.push(
      ws.on("server_restart", (payload) => {
        try {
          // A "shutdown" broadcast kicks back to the login screen (handled in
          // the dispatcher) — no point starting a countdown on a page that is
          // about to unmount.
          if (banner !== null && payload.reason !== "shutdown") {
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
      onToggleDmProfile: () => {
        toggleDmProfile();
      },
      onStartCall: () => {
        startCall();
      },
    });
    dmProfileSlot = chatAreaResult.dmProfileSlot;
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
      chatAreaResult.dmProfileSlot,
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
      onUpdateProfile: async (patch) => {
        try {
          // The username is required by the API but optional in the patch (the
          // profile form only edits the display name and about), so fill it in
          // from the current user rather than making every caller repeat it.
          const username = patch.username ?? authStore.getState().user?.username ?? "";
          const updated = await api.updateProfile({ ...patch, username });
          updateUser({
            username: updated.username,
            display_name: updated.display_name ?? null,
            about: updated.about ?? null,
          });
          showToast("Profile updated", "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to update profile";
          showToast(msg, "error");
          throw err;
        }
      },
      onUploadAvatar: async (file) => {
        try {
          const uploaded = await api.uploadAvatar(file);
          // The server has already pointed the column at the served file and
          // broadcast a user_update; this keeps the local copy from lagging a
          // round-trip behind.
          updateUser({ avatar: uploaded.url });
          showToast("Avatar updated", "success");
          return uploaded.url;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to upload avatar";
          showToast(msg, "error");
          throw err;
        }
      },
      onLogout: () => logout(api),
      onDeleteAccount: async (password) => {
        await api.deleteAccount(password);
        clearAuth();
        showToast("Account deleted successfully", "success");
      },
      onEnableTotp: async (password) => {
        try {
          return await api.enableTotp(password);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to enable 2FA";
          showToast(msg, "error");
          throw err;
        }
      },
      onConfirmTotp: async (password, code) => {
        try {
          await api.confirmTotp(password, code);
          updateUser({ totp_enabled: true });
          showToast("Two-factor authentication enabled", "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to confirm 2FA";
          showToast(msg, "error");
          throw err;
        }
      },
      onDisableTotp: async (password) => {
        try {
          await api.disableTotp(password);
          updateUser({ totp_enabled: false });
          showToast("Two-factor authentication disabled", "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to disable 2FA";
          showToast(msg, "error");
          throw err;
        }
      },
      onStatusChange: (status) => applyPresence(status),
    });
    settingsOverlay.mount(root);
    children.push(settingsOverlay);

    // Quick switcher (Ctrl+K)
    const qsManager = createQuickSwitcherManager(() => root);
    unsubscribers.push(qsManager.attach());

    // The rest of the shortcuts listed on the settings Keybinds tab.
    const voiceKeybindActions = createVoiceWidgetCallbacks(ws, limiters);
    unsubscribers.push(
      attachGlobalKeybinds({
        onSearch: () => chatAreaResult.searchCtrl.open(),
        onToggleMute: () => voiceKeybindActions.onMuteToggle(),
        onToggleDeafen: () => voiceKeybindActions.onDeafenToggle(),
        onToggleCamera: () => voiceKeybindActions.onCameraToggle(),
        onUploadFile: () => channelCtrl?.openFilePicker(),
        // Don't fire app shortcuts while the settings panel is on top of them.
        isSuspended: () => uiStore.getState().settingsOpen,
      }),
    );

    // Toast container
    toast = createToastContainer();
    toast.mount(root);
    children.push(toast);
    initToast(toast);

    // --- DM calls ---
    // The banner is mounted on the page root rather than inside the chat area
    // so a ring stays visible while the user is looking at another channel —
    // which is exactly when a call most needs to be answerable.
    ringCtrl = createRingController({
      onRingStateChange: (state) => callBanner?.setRing(state),
      onChime: (playing) => (playing ? startRingChime() : stopRingChime()),
      onAccept: (channelId) => {
        createSidebarVoiceCallbacks(ws).onVoiceJoin(channelId);
      },
      onDecline: (channelId) => {
        ws.send({ type: "call_decline", payload: { channel_id: channelId } });
      },
    });
    callBanner = createIncomingCallBanner({
      onAccept: () => {
        // ringCtrl.accept() unconditionally consumes the ring
        // (stopRinging) before onVoiceJoin ever runs, and onVoiceJoin itself
        // silently refuses to join while the socket is down (VoiceCallbacks
        // .ts's socketLive() guard) — so accepting while reconnecting would
        // otherwise discard the ring for good with no join and no retry.
        // Guarded here, the banner's only caller of accept(), so the ring
        // survives for the user to accept again once reconnected.
        if (uiStore.getState().connectionStatus !== "connected") {
          showToast("Can't answer while reconnecting", "error");
          return;
        }
        ringCtrl?.accept();
      },
      onDecline: () => ringCtrl?.decline(),
    });
    callBanner.mount(root);
    children.push(callBanner);

    unsubscribers.push(
      ws.on("call_incoming", (payload) => {
        try {
          // A call in the DM you are already sitting in still rings: the
          // channel being open does not mean the app has focus, and Discord
          // rings there too.
          ringCtrl?.incoming({
            channelId: payload.channel_id,
            fromUserId: payload.from_user,
            fromUsername: payload.username,
          });
        } catch (err) {
          log.error("call_incoming handler error", err);
        }
      }),
    );
    unsubscribers.push(
      ws.on("call_declined", (payload) => {
        // Addressed to every other DM participant, not just the caller — the
        // server holds no call state to target with (see handlers_call.go).
        // In a group DM that includes fellow callees who are also ringing;
        // only the actual ringer declining should silence this client's ring.
        const ringing = ringCtrl?.current();
        if (ringing === null || ringing === undefined) return;
        if (payload.from_user === ringing.fromUserId) {
          ringCtrl?.cancel(payload.channel_id);
        }
      }),
    );
    // The ringer hanging up before anyone answered: their voice_leave is the
    // only signal there is that the call is over, because there is no call
    // record to close. Ringing for a room with nobody in it is worse than a
    // missed call, so a leave stops the ring for that channel.
    unsubscribers.push(
      ws.on("voice_leave", (payload) => {
        const ringing = ringCtrl?.current();
        if (ringing === null || ringing === undefined) return;
        if (payload.user_id === ringing.fromUserId) {
          ringCtrl?.cancel(ringing.channelId);
        }
      }),
    );
    unsubscribers.push(() => {
      ringCtrl?.destroy();
      ringCtrl = null;
      callBanner = null;
    });

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
      msgCtrl: msgCtrl,
      pendingDeleteManager,
      reactionCtrl: reactionCtrl,
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
    setOnRemoteVideo((userId, stream, isScreenshare) => {
      if (videoGrid === null) return;
      const voice = voiceStore.getState();
      const channelId = voice.currentChannelId;
      if (channelId === null) return;
      const channelUsers = voice.voiceUsers.get(channelId);
      const user = channelUsers?.get(userId);
      const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
      const username = isScreenshare
        ? user?.username
          ? `${user.username} (Screen)`
          : `User ${userId} (Screen)`
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
    unsubscribers.push(
      voiceStore.subscribe((state) => {
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
      }),
    );

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
            // Voice is the only channel type that should keep the grid up;
            // text, dm and announcement all mount a chat surface and must
            // dismiss it, not just "text" (a dm/announcement switch used to
            // leave the grid covering an unrelated channel's chat).
            if (active.type !== "voice") {
              videoModeCtrl?.showChat();
            }
            // Close DM profile sidebar when switching channels
            if (active.type !== "dm") {
              closeDmProfile();
            } else {
              // Also close when switching to a different DM
              closeDmProfile();
            }
            channelCtrl?.mountChannel(
              active.id,
              resolveChannelName(active.id, active.name, active.type),
              active.type,
            );
          } else {
            // The active channel was cleared with nothing to replace it
            // (deleted, or a DM closed while offline) — without this the
            // previous channel's MessageList/composer stayed mounted and
            // enabled against a channel the server no longer recognizes.
            closeDmProfile();
            channelCtrl?.destroyChannel();
          }
        } catch (err) {
          log.error("Channel mount failed", err);
        }
      },
    );
    unsubscribers.push(unsubChannels);

    const active = getActiveChannel();
    if (active !== null) {
      channelCtrl?.mountChannel(
        active.id,
        resolveChannelName(active.id, active.name, active.type),
        active.type,
      );
    }
  }

  function destroy(): void {
    log.info("MainPage destroying");
    try {
      // closeSettings() is otherwise only ever called from the overlay's own
      // onClose — a non-user-initiated unmount (401, ban, server shutdown)
      // left `settingsOpen` stale, and the next page to mount an (initially
      // hidden) SettingsOverlay off that flag — ConnectPage, after logout —
      // would show it over the login screen.
      closeSettings();
      teardownToast();
      // Full voice cleanup — tears down room, callbacks, ws ref, serverHost.
      // Prevents stale module-level state persisting across logout/reconnect cycles.
      voiceCleanupAll();
      // Custom emoji belong to the server this page was connected to. The set
      // is module-global, so without this a switch to another server would keep
      // rendering the previous one's shortcodes until its own list arrived.
      clearCustomEmoji();
      // Image/video/audio caches are module-global too — without this every
      // clip viewed this session stays pinned (as a blob: URL or a cached
      // data: URI) past logout.
      clearAttachmentCaches();
      // The lightbox is a module-level overlay appended straight to
      // document.body — renderPage only clears #app, so a forced logout with
      // it open would otherwise leave it floating over the login screen with
      // live document listeners and a since-revoked blob URL (B6-15).
      closeActiveLightbox();
      autoIdle?.destroy();
      autoIdle = null;
      channelCtrl?.destroyChannel();
      channelCtrl = null;

      reactionCtrl?.destroy();
      reactionCtrl = null;
      msgCtrl = null;
      videoModeCtrl?.destroy();
      videoModeCtrl = null;

      videoGrid = null;

      closeDmProfile();
      dmProfileSlot = null;

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
