/**
 * ChannelController — channel switching, component mount/destroy lifecycle.
 * Creates and manages MessageList, TypingIndicator, and MessageInput per channel.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { clearChildren, setText } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import { createMessageList } from "@components/MessageList";
import type { MessageListComponent } from "@components/MessageList";
import { createMessageInput } from "@components/MessageInput";
import type { MessageInputComponent } from "@components/MessageInput";
import { createTypingIndicator } from "@components/TypingIndicator";
import { getChannelMessages } from "@stores/messages.store";
import type { MessageController } from "./MessageController";
import type { PendingDeleteManager } from "./MessageController";
import type { ReactionController } from "./ReactionController";

const log = createLogger("channel-ctrl");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelControllerOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly msgCtrl: MessageController;
  readonly pendingDeleteManager: PendingDeleteManager;
  readonly reactionCtrl: ReactionController;
  readonly typingLimiter: { tryConsume(key?: string): boolean };
  readonly showToast: (msg: string, type: string) => void;
  readonly getCurrentUserId: () => number;
  readonly slots: {
    readonly messagesSlot: HTMLDivElement;
    readonly typingSlot: HTMLDivElement;
    readonly inputSlot: HTMLDivElement;
  };
  readonly chatHeaderName: HTMLSpanElement | null;
}

export interface ChannelController {
  /** Mount components for a channel. No-op if same channel already mounted. */
  mountChannel(channelId: number, channelName: string): void;
  /** Destroy current channel components and reset state. */
  destroyChannel(): void;
  /** Currently mounted channel ID, or null. */
  readonly currentChannelId: number | null;
  /** Currently mounted message list (for scroll-to-message). */
  readonly messageList: MessageListComponent | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChannelController(
  opts: ChannelControllerOptions,
): ChannelController {
  const {
    ws,
    api,
    msgCtrl,
    pendingDeleteManager,
    reactionCtrl,
    typingLimiter,
    showToast,
    getCurrentUserId,
    slots,
    chatHeaderName,
  } = opts;

  let _currentChannelId: number | null = null;
  let channelAbort: AbortController | null = null;
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  let typingIndicator: MountableComponent | null = null;

  function destroyChannel(): void {
    pendingDeleteManager.cleanup();

    if (channelAbort !== null) {
      channelAbort.abort();
      channelAbort = null;
    }

    if (messageList !== null) {
      messageList.destroy?.();
      messageList = null;
    }
    if (typingIndicator !== null) {
      typingIndicator.destroy?.();
      typingIndicator = null;
    }
    if (messageInput !== null) {
      messageInput.destroy?.();
      messageInput = null;
    }
    clearChildren(slots.messagesSlot);
    clearChildren(slots.typingSlot);
    clearChildren(slots.inputSlot);

    _currentChannelId = null;
  }

  function mountChannel(channelId: number, channelName: string): void {
    if (_currentChannelId === channelId) return;

    destroyChannel();
    _currentChannelId = channelId;

    log.info("Switching channel", { channelId, channelName });

    ws.send({
      type: "channel_focus",
      payload: { channel_id: channelId },
    });

    channelAbort = new AbortController();
    const signal = channelAbort.signal;
    const userId = getCurrentUserId();

    void msgCtrl.loadMessages(channelId, signal);

    // MessageList
    messageList = createMessageList({
      channelId,
      currentUserId: userId,
      onScrollTop: () => {
        if (channelAbort !== null) {
          void msgCtrl.loadOlderMessages(channelId, channelAbort.signal);
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
        const result = pendingDeleteManager.tryDelete(msgId);
        if (result === "confirmed") {
          ws.send({
            type: "chat_delete",
            payload: { message_id: msgId },
          });
          showToast("Message deleted", "success");
        } else {
          showToast("Click delete again to confirm", "info");
        }
      },
      onReactionClick: (msgId: number, emoji: string) => {
        reactionCtrl.handleReaction(msgId, emoji);
      },
    });
    messageList.mount(slots.messagesSlot);

    // TypingIndicator
    typingIndicator = createTypingIndicator({
      channelId,
      currentUserId: userId,
    });
    typingIndicator.mount(slots.typingSlot);

    // MessageInput
    messageInput = createMessageInput({
      channelId,
      channelName,
      onSend: (content: string, replyTo: number | null, attachments: readonly string[]) => {
        if (ws.getState() !== "connected") {
          log.warn("Cannot send message: not connected");
          showToast("Not connected — message not sent", "error");
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
        try {
          const result = await api.uploadFile(file);
          return { id: result.id, url: result.url, filename: result.filename };
        } catch (err) {
          log.error("File upload failed", { error: String(err) });
          showToast("File upload failed", "error");
          throw err;
        }
      },
      onTyping: () => {
        if (typingLimiter.tryConsume(String(channelId))) {
          ws.send({
            type: "typing_start",
            payload: { channel_id: channelId },
          });
        }
      },
      onEditMessage: (messageId: number, content: string) => {
        const trimmed = content.trim();
        if (trimmed === "") {
          showToast("Message cannot be empty", "error");
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
        showToast("Message edited", "success");
      },
    });
    messageInput.mount(slots.inputSlot);

    // Update header
    if (chatHeaderName !== null) {
      setText(chatHeaderName, channelName);
    }
  }

  return {
    mountChannel,
    destroyChannel,
    get currentChannelId() {
      return _currentChannelId;
    },
    get messageList() {
      return messageList;
    },
  };
}
