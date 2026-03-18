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
import type { ToastContainer } from "@components/Toast";
import { authStore, clearAuth } from "@stores/auth.store";
import { closeSettings, toggleMemberList, uiStore } from "@stores/ui.store";
import { channelsStore, getActiveChannel, setActiveChannel } from "@stores/channels.store";
import {
  voiceStore,
  joinVoiceChannel,
  leaveVoiceChannel,
} from "@stores/voice.store";
import {
  joinVoice,
  leaveVoice as voiceSessionLeave,
  setMuted as voiceSessionSetMuted,
  setDeafened as voiceSessionSetDeafened,
  setWsClient,
} from "@lib/voiceSession";
import {
  setMessages,
  prependMessages,
  isChannelLoaded,
  getChannelMessages,
} from "@stores/messages.store";
import { buildChatHeader } from "./main-page/ChatHeader";
import {
  createQuickSwitcherManager,
  createInviteManagerController,
  createPinnedPanelController,
} from "./main-page/OverlayManagers";

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
        ws.send({
          type: "chat_delete",
          payload: { message_id: msgId },
        });
      },
      onReactionClick: (msgId: number, emoji: string) => {
        if (emoji === "") return;
        if (limiters.reactions.tryConsume()) {
          ws.send({
            type: "reaction_add",
            payload: { message_id: msgId, emoji },
          });
        }
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
      onSend: (content: string, replyTo: number | null) => {
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
            attachments: [],
          },
        });
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
        ws.send({
          type: "chat_edit",
          payload: { message_id: messageId, content },
        });
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
        void joinVoice(payload.channel_id, payload);
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
    const channelSidebar = createChannelSidebar({
      onVoiceJoin: (channelId) => {
        log.info("Joining voice channel", { channelId });
        joinVoiceChannel(channelId);
        ws.send({ type: "voice_join", payload: { channel_id: channelId } });
      },
      onVoiceLeave: () => {
        log.info("Leaving voice channel");
        voiceSessionLeave();
        leaveVoiceChannel();
        ws.send({ type: "voice_leave", payload: {} });
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
        voiceSessionLeave();
        leaveVoiceChannel();
        ws.send({ type: "voice_leave", payload: {} });
      },
      onMuteToggle: () => {
        if (!limiters.voice.tryConsume()) return;
        const next = !voiceStore.getState().localMuted;
        voiceSessionSetMuted(next);
        ws.send({ type: "voice_mute", payload: { muted: next } });
      },
      onDeafenToggle: () => {
        if (!limiters.voice.tryConsume()) return;
        const next = !voiceStore.getState().localDeafened;
        voiceSessionSetDeafened(next);
        ws.send({ type: "voice_deafen", payload: { deafened: next } });
      },
      onCameraToggle: () => {
        if (!limiters.voiceVideo.tryConsume()) return;
        ws.send({ type: "voice_camera", payload: { enabled: false } });
      },
      onScreenshareToggle: () => {},
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
      onChangePassword: async () => {},
      onUpdateProfile: async () => {},
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
