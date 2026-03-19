// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.

import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
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
import { createVoiceWidget } from "@components/VoiceWidget";
import { createMemberList } from "@components/MemberList";
import { createMessageList } from "@components/MessageList";
import type { MessageListComponent } from "@components/MessageList";
import { createMessageInput } from "@components/MessageInput";
import type { MessageInputComponent } from "@components/MessageInput";
import { createTypingIndicator } from "@components/TypingIndicator";
import { createServerBanner } from "@components/ServerBanner";
import type { ServerBannerControl } from "@components/ServerBanner";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { createToastContainer } from "@components/Toast";
import { createEmojiPicker } from "@components/EmojiPicker";
import type { ToastContainer } from "@components/Toast";
import { authStore, clearAuth, updateUser } from "@stores/auth.store";
import { closeSettings, toggleMemberList, uiStore } from "@stores/ui.store";
import { channelsStore, getActiveChannel, setActiveChannel } from "@stores/channels.store";
import {
  voiceStore,
  joinVoiceChannel,
  leaveVoiceChannel,
  setLocalCamera,
  setLocalScreenshare,
} from "@stores/voice.store";
import {
  joinVoice,
  leaveVoice as voiceSessionLeave,
  setMuted as voiceSessionSetMuted,
  setDeafened as voiceSessionSetDeafened,
  setWsClient,
  setOnError as setVoiceOnError,
  clearOnError as clearVoiceOnError,
} from "@lib/voiceSession";
import {
  setMessages,
  prependMessages,
  isChannelLoaded,
  getChannelMessages,
} from "@stores/messages.store";
import { buildChatHeader } from "./main-page/ChatHeader";
import { setServerHost } from "@components/message-list/renderers";
import {
  createQuickSwitcherManager,
  createInviteManagerController,
  createPinnedPanelController,
} from "./main-page/OverlayManagers";
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

  // Set server host for resolving relative attachment URLs
  const apiConfig = api.getConfig();
  if (apiConfig.host) {
    setServerHost(apiConfig.host);
  }

  const limiters = createRateLimiterSet();

  let container: Element | null = null;
  let root: HTMLDivElement | null = null;

  // Child components tracked for cleanup
  const children: MountableComponent[] = [];
  const unsubscribers: Array<() => void> = [];

  // Refs we need to update reactively
  let banner: ServerBannerControl | null = null;
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  let typingIndicator: MountableComponent | null = null;
  let chatHeaderName: HTMLSpanElement | null = null;

  // Containers for swappable sub-components
  let messagesSlot: HTMLDivElement | null = null;
  let typingSlot: HTMLDivElement | null = null;
  let inputSlot: HTMLDivElement | null = null;

  // Track currently mounted channel to avoid redundant rebuilds
  let currentChannelId: number | null = null;

  // Pending delete confirmations (double-click to delete pattern)
  const pendingDeletes = new Map<number, number>();

  // Abort controller for channel-scoped async operations (e.g. message fetch)
  let channelAbort: AbortController | null = null;

  // Toast container for user-facing error feedback
  let toast: ToastContainer | null = null;

  // Overlay controllers — created in mount()
  let pinnedCtrl: ReturnType<typeof createPinnedPanelController> | null = null;
  let inviteCtrl: ReturnType<typeof createInviteManagerController> | null = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getCurrentUserId(): number {
    return authStore.getState().user?.id ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Message loading (REST)
  // ---------------------------------------------------------------------------

  async function loadMessages(channelId: number, signal: AbortSignal): Promise<void> {
    if (isChannelLoaded(channelId)) {
      log.debug("Messages already loaded", { channelId });
      return;
    }
    try {
      const resp = await api.getMessages(channelId, { limit: 50 }, signal);
      if (!signal.aborted) {
        log.info("Messages loaded", { channelId, count: resp.messages.length, hasMore: resp.has_more });
        setMessages(channelId, resp.messages, resp.has_more);
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load messages", { channelId, error: String(err) });
        toast?.show("Failed to load messages", "error");
      }
    }
  }

  async function loadOlderMessages(channelId: number, signal: AbortSignal): Promise<void> {
    const messages = getChannelMessages(channelId);
    if (messages.length === 0) return;
    const oldest = messages[0];
    if (oldest === undefined) return;
    try {
      const resp = await api.getMessages(
        channelId,
        { before: oldest.id, limit: 50 },
        signal,
      );
      if (!signal.aborted) {
        prependMessages(channelId, resp.messages, resp.has_more);
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load older messages", { channelId, error: String(err) });
        toast?.show("Failed to load older messages", "error");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Channel switching — rebuild channel-dependent components
  // ---------------------------------------------------------------------------

  function mountChannelComponents(channelId: number, channelName: string): void {
    if (currentChannelId === channelId) return;

    destroyChannelComponents();
    currentChannelId = channelId;

    log.info("Switching channel", { channelId, channelName });

    // Notify server which channel we're viewing so channel-scoped
    // broadcasts (chat_message, typing, etc.) are delivered to us.
    ws.send({
      type: "channel_focus",
      payload: { channel_id: channelId },
    });

    channelAbort = new AbortController();
    const signal = channelAbort.signal;
    const userId = getCurrentUserId();

    void loadMessages(channelId, signal);

    // MessageList
    messageList = createMessageList({
      channelId,
      currentUserId: userId,
      onScrollTop: () => {
        if (channelAbort !== null) {
          void loadOlderMessages(channelId, channelAbort.signal);
        }
      },
      onReplyClick: (msgId: number) => {
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        messageInput?.setReplyTo(msgId, msg?.user.username ?? "");
      },
      onEditClick: (msgId: number) => {
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        if (msg !== undefined) {
          messageInput?.startEdit(msgId, msg.content);
        }
      },
      onDeleteClick: (msgId: number) => {
        if (pendingDeletes.has(msgId)) {
          window.clearTimeout(pendingDeletes.get(msgId));
          pendingDeletes.delete(msgId);
          ws.send({
            type: "chat_delete",
            payload: { message_id: msgId },
          });
          toast?.show("Message deleted", "success");
        } else {
          toast?.show("Click delete again to confirm", "info");
          const tid = window.setTimeout(() => pendingDeletes.delete(msgId), 5000);
          pendingDeletes.set(msgId, tid);
        }
      },
      onReactionClick: (msgId: number, emoji: string) => {
        if (emoji === "") {
          // Open emoji picker for reaction selection
          const reactBtn = document.querySelector(`[data-testid="msg-react-${msgId}"]`);
          if (reactBtn === null) return;

          // Close any existing reaction picker
          const existingWrap = document.querySelector(".reaction-picker-wrap");
          if (existingWrap !== null) { existingWrap.remove(); return; }

          let pickerDestroy: (() => void) | null = null;

          const wrap = createElement("div", {
            class: "reaction-picker-wrap",
          });

          // Backdrop to close on click-outside
          const backdrop = createElement("div", {
            style: "position: fixed; inset: 0; z-index: 299;",
          });
          backdrop.addEventListener("click", () => {
            pickerDestroy?.();
            wrap.remove();
          });

          const picker = createEmojiPicker({
            onSelect: (selectedEmoji: string) => {
              pickerDestroy?.();
              wrap.remove();
              if (!limiters.reactions.tryConsume()) {
                toast?.show("Slow down! Please wait before reacting again.", "error");
                return;
              }
              const msgs = getChannelMessages(channelId);
              const m = msgs.find((x) => x.id === msgId);
              const existing = m?.reactions.find((r) => r.emoji === selectedEmoji);
              const type = existing?.me ? "reaction_remove" : "reaction_add";
              ws.send({ type, payload: { message_id: msgId, emoji: selectedEmoji } });
            },
            onClose: () => { pickerDestroy?.(); wrap.remove(); },
          });
          pickerDestroy = picker.destroy;

          // Position the picker to the left of the react button, top-aligned
          const rect = reactBtn.getBoundingClientRect();
          const pickerW = 320;
          let left = rect.left - pickerW - 8;
          let top = rect.top;
          if (left < 8) left = rect.right + 8;
          if (top + 420 > window.innerHeight - 8) top = window.innerHeight - 420 - 8;
          if (top < 8) top = 8;

          // Override the picker's default absolute positioning
          picker.element.style.position = "fixed";
          picker.element.style.left = `${left}px`;
          picker.element.style.top = `${top}px`;
          picker.element.style.bottom = "auto";
          picker.element.style.right = "auto";
          picker.element.style.zIndex = "300";
          picker.element.style.margin = "0";

          wrap.appendChild(backdrop);
          wrap.appendChild(picker.element);
          document.body.appendChild(wrap);

          return;
        }
        if (!limiters.reactions.tryConsume()) {
          toast?.show("Slow down! Please wait before reacting again.", "error");
          return;
        }
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        const existing = msg?.reactions.find((r) => r.emoji === emoji);
        const type = existing?.me ? "reaction_remove" : "reaction_add";
        ws.send({ type, payload: { message_id: msgId, emoji } });
      },
    });
    if (messagesSlot !== null) {
      messageList.mount(messagesSlot);
    }
    children.push(messageList);

    // TypingIndicator
    typingIndicator = createTypingIndicator({
      channelId,
      currentUserId: userId,
    });
    if (typingSlot !== null) {
      typingIndicator.mount(typingSlot);
    }
    children.push(typingIndicator);

    // MessageInput
    messageInput = createMessageInput({
      channelId,
      channelName,
      onSend: (content: string, replyTo: number | null, attachments: readonly string[]) => {
        if (ws.getState() !== "connected") {
          log.warn("Cannot send message: not connected");
          toast?.show("Not connected — message not sent", "error");
          return;
        }
        ws.send({
          type: "chat_send",
          payload: {
            channel_id: channelId,
            content,
            reply_to: replyTo,
            attachments,
          },
        });
      },
      onUploadFile: async (file: File) => {
        const result = await api.uploadFile(file);
        return { id: result.id, url: result.url, filename: result.filename };
      },
      onTyping: () => {
        if (limiters.typing.tryConsume(String(channelId))) {
          ws.send({
            type: "typing_start",
            payload: { channel_id: channelId },
          });
        }
      },
      onEditMessage: (messageId: number, content: string) => {
        const trimmed = content.trim();
        if (trimmed === "") {
          toast?.show("Message cannot be empty", "error");
          return;
        }
        const msgs = getChannelMessages(channelId);
        const original = msgs.find((m) => m.id === messageId);
        if (original !== undefined && original.content === trimmed) {
          return;
        }
        ws.send({
          type: "chat_edit",
          payload: { message_id: messageId, content: trimmed },
        });
        toast?.show("Message edited", "success");
      },
    });
    if (inputSlot !== null) {
      messageInput.mount(inputSlot);
    }
    children.push(messageInput);

    // Update header
    if (chatHeaderName !== null) {
      setText(chatHeaderName, channelName);
    }
  }

  function destroyChannelComponents(): void {
    for (const tid of pendingDeletes.values()) {
      window.clearTimeout(tid);
    }
    pendingDeletes.clear();

    if (channelAbort !== null) {
      channelAbort.abort();
      channelAbort = null;
    }

    if (messageList !== null) {
      messageList.destroy?.();
      const idx = children.indexOf(messageList);
      if (idx !== -1) children.splice(idx, 1);
      messageList = null;
    }
    if (typingIndicator !== null) {
      typingIndicator.destroy?.();
      const idx = children.indexOf(typingIndicator);
      if (idx !== -1) children.splice(idx, 1);
      typingIndicator = null;
    }
    if (messageInput !== null) {
      messageInput.destroy?.();
      const idx = children.indexOf(messageInput as MountableComponent);
      if (idx !== -1) children.splice(idx, 1);
      messageInput = null;
    }
    if (messagesSlot !== null) { clearChildren(messagesSlot); }
    if (typingSlot !== null) { clearChildren(typingSlot); }
    if (inputSlot !== null) { clearChildren(inputSlot); }

    currentChannelId = null;
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

    // --- Voice config: trigger WebRTC join flow ---
    unsubscribers.push(
      ws.on("voice_config", (payload) => {
        void joinVoice(payload.channel_id, payload, async () => {
          const creds = await api.getVoiceCredentials();
          return creds.ice_servers;
        });
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
    let activeModal: MountableComponent | null = null;

    const channelSidebar = createChannelSidebar({
      onVoiceJoin: (channelId) => {
        log.info("Joining voice channel", { channelId });
        joinVoiceChannel(channelId);
        ws.send({ type: "voice_join", payload: { channel_id: channelId } });
      },
      onVoiceLeave: () => {
        log.info("Leaving voice channel");
        voiceSessionLeave(false); // false: we send voice_leave below
        leaveVoiceChannel();
        ws.send({ type: "voice_leave", payload: {} });
      },
      onCreateChannel: (category) => {
        if (activeModal !== null) {
          return;
        }
        const modal = createCreateChannelModal({
          category,
          onCreate: async (data) => {
            await api.adminCreateChannel(data);
            // Server broadcasts channel_create via WS — store updates automatically
            modal.destroy?.();
            activeModal = null;
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
            await api.adminUpdateChannel(channel.id, data);
            // Server broadcasts channel_update via WS — store updates automatically
            modal.destroy?.();
            activeModal = null;
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
            await api.adminDeleteChannel(channel.id);
            // Server broadcasts channel_delete via WS — store updates automatically
            modal.destroy?.();
            activeModal = null;
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
    const voiceWidget = createVoiceWidget({
      onDisconnect: () => {
        if (voiceStore.getState().currentChannelId === null) return;
        log.info("Leaving voice channel (widget disconnect)");
        voiceSessionLeave(false); // false: we send voice_leave below
        leaveVoiceChannel();
        ws.send({ type: "voice_leave", payload: {} });
      },
      onMuteToggle: () => {
        if (!limiters.voice.tryConsume()) return;
        const state = voiceStore.getState();
        if (state.localMuted) {
          // Unmuting: also undeafen if deafened
          voiceSessionSetMuted(false);
          ws.send({ type: "voice_mute", payload: { muted: false } });
          if (state.localDeafened) {
            voiceSessionSetDeafened(false);
            ws.send({ type: "voice_deafen", payload: { deafened: false } });
          }
        } else {
          voiceSessionSetMuted(true);
          ws.send({ type: "voice_mute", payload: { muted: true } });
        }
      },
      onDeafenToggle: () => {
        if (!limiters.voice.tryConsume()) return;
        const state = voiceStore.getState();
        if (state.localDeafened) {
          // Undeafening: also unmute mic
          voiceSessionSetDeafened(false);
          ws.send({ type: "voice_deafen", payload: { deafened: false } });
          voiceSessionSetMuted(false);
          ws.send({ type: "voice_mute", payload: { muted: false } });
        } else {
          // Deafening: also mute mic
          voiceSessionSetDeafened(true);
          ws.send({ type: "voice_deafen", payload: { deafened: true } });
          if (!state.localMuted) {
            voiceSessionSetMuted(true);
            ws.send({ type: "voice_mute", payload: { muted: true } });
          }
        }
      },
      onCameraToggle: () => {
        if (!limiters.voiceVideo.tryConsume()) return;
        const next = !voiceStore.getState().localCamera;
        setLocalCamera(next);
        ws.send({ type: "voice_camera", payload: { enabled: next } });
      },
      onScreenshareToggle: () => {
        if (!limiters.voiceVideo.tryConsume()) return;
        const next = !voiceStore.getState().localScreenshare;
        setLocalScreenshare(next);
        ws.send({ type: "voice_screenshare", payload: { enabled: next } });
      },
    });
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
      getCurrentChannelId: () => currentChannelId,
      onJumpToMessage: (msgId: number) => {
        if (messageList === null) return false;
        return messageList.scrollToMessage(msgId);
      },
    });
    unsubscribers.push(() => { pinnedCtrl?.cleanup(); });

    const chatHeader = buildChatHeader({
      onTogglePins: () => { void pinnedCtrl!.toggle(); },
      onToggleMembers: () => toggleMemberList(),
    });
    chatHeaderName = chatHeader.refs.nameEl;
    chatArea.appendChild(chatHeader.element);

    messagesSlot = createElement("div", { class: "messages-slot", "data-testid": "messages-slot" });
    typingSlot = createElement("div", { class: "typing-slot", "data-testid": "typing-slot" });
    inputSlot = createElement("div", { class: "input-slot", "data-testid": "input-slot" });
    appendChildren(chatArea, messagesSlot, typingSlot, inputSlot);

    // Member list
    const memberListSlot = createElement("div", {});
    const memberList = createMemberList();
    memberList.mount(memberListSlot);
    children.push(memberList);

    const memberListEl = memberListSlot.querySelector(".member-list");
    const unsubMemberList = uiStore.subscribe((state) => {
      if (memberListEl !== null) {
        memberListEl.classList.toggle("hidden", !state.memberListVisible);
      }
    });
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

    // Wire voice error callback to toast
    setVoiceOnError((msg) => toast?.show(msg, "error"));

    // Auto-update notifier — checks server for newer client version
    if (apiConfig.host) {
      const serverUrl = `https://${apiConfig.host}`;
      const updateNotifier = createUpdateNotifier({ serverUrl });
      updateNotifier.mount(root);
      children.push(updateNotifier);
    }

    container.appendChild(root);

    // --- Subscribe to channel changes ---
    const unsubChannels = channelsStore.subscribe(() => {
      const active = getActiveChannel();
      if (active !== null) {
        mountChannelComponents(active.id, active.name);
      }
    });
    unsubscribers.push(unsubChannels);

    const active = getActiveChannel();
    if (active !== null) {
      mountChannelComponents(active.id, active.name);
    }
  }

  function destroy(): void {
    log.info("MainPage destroying");
    // Clean up voice session before destroying UI — prevents stale
    // module-level state persisting across logout/reconnect cycles.
    voiceSessionLeave(false);
    clearVoiceOnError();
    destroyChannelComponents();

    for (const child of children) {
      child.destroy?.();
    }
    children.length = 0;

    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;

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
