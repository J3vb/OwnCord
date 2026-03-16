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
import { createMessageInput } from "@components/MessageInput";
import type { MessageInputComponent } from "@components/MessageInput";
import { createTypingIndicator } from "@components/TypingIndicator";
import { createServerBanner } from "@components/ServerBanner";
import type { ServerBannerControl } from "@components/ServerBanner";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { createQuickSwitcher } from "@components/QuickSwitcher";
import { authStore, clearAuth } from "@stores/auth.store";
import { closeSettings } from "@stores/ui.store";
import { channelsStore, getActiveChannel, setActiveChannel } from "@stores/channels.store";
import {
  voiceStore,
  leaveVoiceChannel,
  setLocalMuted,
  setLocalDeafened,
} from "@stores/voice.store";
import {
  setMessages,
  prependMessages,
  isChannelLoaded,
  getChannelMessages,
} from "@stores/messages.store";

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

  const limiters = createRateLimiterSet();

  let container: Element | null = null;
  let root: HTMLDivElement | null = null;

  // Child components tracked for cleanup
  const children: MountableComponent[] = [];
  const unsubscribers: Array<() => void> = [];

  // Refs we need to update reactively
  let banner: ServerBannerControl | null = null;
  let messageList: MountableComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  let typingIndicator: MountableComponent | null = null;
  let chatHeaderName: HTMLSpanElement | null = null;
  let chatHeaderTopic: HTMLSpanElement | null = null;

  // Containers for swappable sub-components
  let messagesSlot: HTMLDivElement | null = null;
  let typingSlot: HTMLDivElement | null = null;
  let inputSlot: HTMLDivElement | null = null;

  // Track currently mounted channel to avoid redundant rebuilds
  let currentChannelId: number | null = null;

  // Abort controller for channel-scoped async operations (e.g. message fetch)
  let channelAbort: AbortController | null = null;

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
    if (isChannelLoaded(channelId)) return;
    try {
      const resp = await api.getMessages(channelId, { limit: 50 }, signal);
      if (!signal.aborted) {
        setMessages(channelId, resp.messages, resp.has_more);
      }
    } catch (err) {
      if (!signal.aborted) {
        log.error("Failed to load messages", { channelId, error: String(err) });
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
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Chat header (no standalone component — built inline)
  // ---------------------------------------------------------------------------

  function buildChatHeader(): HTMLDivElement {
    const header = createElement("div", { class: "chat-header" });
    const hash = createElement("span", { class: "ch-hash" }, "#");
    chatHeaderName = createElement("span", { class: "ch-name" }, "general");
    const divider = createElement("div", { class: "ch-divider" });
    chatHeaderTopic = createElement("span", { class: "ch-topic" }, "");

    const tools = createElement("div", { class: "ch-tools" });
    const searchInput = createElement("input", {
      class: "search-input",
      type: "text",
      placeholder: "Search...",
    });
    const membersToggle = createElement("button", {
      type: "button",
      "aria-label": "Toggle member list",
    }, "\uD83D\uDC65");
    appendChildren(tools, searchInput, membersToggle);

    appendChildren(header, hash, chatHeaderName, divider, chatHeaderTopic, tools);
    return header;
  }

  // ---------------------------------------------------------------------------
  // Channel switching — rebuild channel-dependent components
  // ---------------------------------------------------------------------------

  function mountChannelComponents(channelId: number, channelName: string): void {
    // Skip if already mounted for this channel
    if (currentChannelId === channelId) return;
    currentChannelId = channelId;

    // Tear down previous instances
    destroyChannelComponents();

    // New abort controller for this channel's async work
    channelAbort = new AbortController();
    const signal = channelAbort.signal;

    const userId = getCurrentUserId();

    // Load messages from REST
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
        if (emoji === "") return; // empty = open picker (future)
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
    // Topic not yet in Channel store — will be wired when available
  }

  function destroyChannelComponents(): void {
    // Abort any in-flight fetches
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
    // Clear slots
    if (messagesSlot !== null) { clearChildren(messagesSlot); }
    if (typingSlot !== null) { clearChildren(typingSlot); }
    if (inputSlot !== null) { clearChildren(inputSlot); }

    currentChannelId = null;
  }

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(target: Element): void {
    container = target;

    // Outer wrapper
    root = createElement("div", {
      style: "display:flex;flex-direction:column;height:100vh;width:100%",
    });

    // --- Reconnect banner ---
    banner = createServerBanner();
    root.appendChild(banner.element);

    // Wire banner to WS state
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

    // Wire banner to server_restart events
    unsubscribers.push(
      ws.on("server_restart", (payload) => {
        if (banner !== null) {
          banner.showRestart(payload.delay_seconds);
        }
      }),
    );

    // --- Main .app row ---
    const app = createElement("div", { class: "app" });

    // Server strip
    const serverStripSlot = createElement("div", {});
    const serverStrip = createServerStrip();
    serverStrip.mount(serverStripSlot);
    children.push(serverStrip);

    // Channel sidebar (composed: sidebar + voice widget + user bar)
    const sidebarWrapper = createElement("div", { class: "channel-sidebar" });

    const channelSidebarSlot = createElement("div", {});
    const channelSidebar = createChannelSidebar();
    channelSidebar.mount(channelSidebarSlot);
    children.push(channelSidebar);

    // Move the ChannelSidebar's inner elements into our wrapper
    const mountedSidebar = channelSidebarSlot.firstElementChild;
    if (mountedSidebar !== null) {
      while (mountedSidebar.firstChild !== null) {
        sidebarWrapper.appendChild(mountedSidebar.firstChild);
      }
    }

    // Voice widget (hidden when not in voice)
    const voiceWidgetSlot = createElement("div", {});
    const voiceWidget = createVoiceWidget({
      onDisconnect: () => {
        leaveVoiceChannel();
      },
      onMuteToggle: () => {
        if (!limiters.voice.tryConsume()) return;
        const next = !voiceStore.getState().localMuted;
        setLocalMuted(next);
        ws.send({ type: "voice_mute", payload: { muted: next } });
      },
      onDeafenToggle: () => {
        if (!limiters.voice.tryConsume()) return;
        const next = !voiceStore.getState().localDeafened;
        setLocalDeafened(next);
        ws.send({ type: "voice_deafen", payload: { deafened: next } });
      },
      onCameraToggle: () => {
        if (!limiters.voiceVideo.tryConsume()) return;
        ws.send({ type: "voice_camera", payload: { enabled: false } });
      },
      onScreenshareToggle: () => {
        // TODO: screenshare not yet in protocol
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
    const chatArea = createElement("div", { class: "chat-area" });
    chatArea.appendChild(buildChatHeader());

    messagesSlot = createElement("div", { class: "messages-slot" });
    typingSlot = createElement("div", { class: "typing-slot" });
    inputSlot = createElement("div", { class: "input-slot" });
    appendChildren(chatArea, messagesSlot, typingSlot, inputSlot);

    // Member list
    const memberListSlot = createElement("div", {});
    const memberList = createMemberList();
    memberList.mount(memberListSlot);
    children.push(memberList);

    appendChildren(app, serverStripSlot, sidebarWrapper, chatArea, memberListSlot);
    root.appendChild(app);

    // Settings overlay (full-screen, toggled via uiStore.settingsOpen)
    const settingsOverlay = createSettingsOverlay({
      onClose: () => closeSettings(),
      onChangePassword: async () => { /* wired when API integration is complete */ },
      onUpdateProfile: async () => { /* wired when API integration is complete */ },
      onLogout: () => clearAuth(),
    });
    settingsOverlay.mount(root);
    children.push(settingsOverlay);

    // Quick switcher (Ctrl+K)
    let quickSwitcher: MountableComponent | null = null;

    function openQuickSwitcher(): void {
      if (quickSwitcher !== null || root === null) return;
      quickSwitcher = createQuickSwitcher({
        onSelectChannel: (channelId: number) => {
          setActiveChannel(channelId);
        },
        onSearch: () => {},
        onClose: closeQuickSwitcher,
      });
      quickSwitcher.mount(root);
    }

    function closeQuickSwitcher(): void {
      if (quickSwitcher !== null) {
        quickSwitcher.destroy?.();
        quickSwitcher = null;
      }
    }

    const quickSwitcherKeyHandler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (quickSwitcher !== null) {
          closeQuickSwitcher();
        } else {
          openQuickSwitcher();
        }
      }
    };
    document.addEventListener("keydown", quickSwitcherKeyHandler);
    unsubscribers.push(() => {
      document.removeEventListener("keydown", quickSwitcherKeyHandler);
      closeQuickSwitcher();
    });

    container.appendChild(root);

    // --- Subscribe to channel changes ---
    const unsubChannels = channelsStore.subscribe(() => {
      const active = getActiveChannel();
      if (active !== null) {
        mountChannelComponents(active.id, active.name);
      }
    });
    unsubscribers.push(unsubChannels);

    // Mount for current active channel if any
    const active = getActiveChannel();
    if (active !== null) {
      mountChannelComponents(active.id, active.name);
    }
  }

  function destroy(): void {
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
