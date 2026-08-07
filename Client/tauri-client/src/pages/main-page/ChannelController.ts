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
import type { ChannelType } from "@lib/types";
import { createMessageList } from "@components/MessageList";
import type { MessageListComponent } from "@components/MessageList";
import { createMessageInput } from "@components/MessageInput";
import type { MessageInputComponent } from "@components/MessageInput";
import { createTypingIndicator } from "@components/TypingIndicator";
import { createNsfwGate } from "@components/NsfwGate";
import { nsfwGateRequired } from "@lib/nsfw-gate";
import {
  getChannelMessages,
  setMessagePinned,
  addOptimisticMessage,
  markSendFailed,
  removeOptimistic,
  reattachToPresent,
  isWindowDetached,
} from "@stores/messages.store";
import { jumpToMessage } from "@lib/message-navigation";
import { authStore } from "@stores/auth.store";
import type { MessageUser } from "@lib/types";
import type { MessageController } from "./MessageController";
import type { PendingDeleteManager } from "./MessageController";
import type { ReactionController } from "./ReactionController";
import { updateChatHeaderForDm } from "./ChatHeader";
import type { ChatHeaderRefs } from "./ChatHeader";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { canManageMessages } from "@lib/permissions";
import { blocksStore, dmComposerBlockReason } from "@stores/blocks.store";
import { membersStore } from "@stores/members.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";

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
  readonly chatHeaderRefs: ChatHeaderRefs | null;
}

export interface ChannelController {
  /** Mount components for a channel. No-op if same channel already mounted. */
  mountChannel(channelId: number, channelName: string, channelType?: ChannelType): void;
  /** Destroy current channel components and reset state. */
  destroyChannel(): void;
  /** Currently mounted channel ID, or null. */
  readonly currentChannelId: number | null;
  /** Currently mounted message list (for scroll-to-message). */
  readonly messageList: MessageListComponent | null;
  /** Open the composer's attachment picker (Ctrl+U). No-op with no composer. */
  openFilePicker(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChannelController(opts: ChannelControllerOptions): ChannelController {
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
    chatHeaderRefs,
  } = opts;

  let _currentChannelId: number | null = null;
  let channelAbort: AbortController | null = null;
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  let typingIndicator: MountableComponent | null = null;
  // The age gate covering the message area of an NSFW channel, while it is up.
  let nsfwGate: MountableComponent | null = null;
  // Store/ws subscriptions that keep the composer's disabled state in sync.
  let composerGatingUnsubs: (() => void)[] = [];

  function destroyChannel(): void {
    pendingDeleteManager.cleanup();

    for (const unsub of composerGatingUnsubs) unsub();
    composerGatingUnsubs = [];

    if (channelAbort !== null) {
      channelAbort.abort();
      channelAbort = null;
    }

    if (nsfwGate !== null) {
      nsfwGate.destroy?.();
      nsfwGate = null;
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

  function mountChannel(channelId: number, channelName: string, channelType?: ChannelType): void {
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

    // Optimistic send: keep the raw payload per correlation id so a failed
    // send can be retried (including its attachments). Channel-scoped — cleared
    // when the channel unmounts.
    const draftByCorrelation = new Map<
      string,
      { content: string; replyTo: number | null; attachments: readonly string[] }
    >();

    function currentMessageUser(): MessageUser | null {
      const u = authStore.getState().user;
      if (u === null) return null;
      return { id: u.id, username: u.username, avatar: u.avatar };
    }

    function performSend(
      content: string,
      replyTo: number | null,
      attachments: readonly string[],
    ): void {
      const user = currentMessageUser();
      if (user === null) return;
      // Sending while viewing a detached history window jumps to present: the
      // optimistic row belongs in the live tail, and addMessage would refuse
      // to append the echo into a detached window anyway. Mirrors
      // onJumpToPresent — reattach clears "loaded" so the tail is refetched.
      if (isWindowDetached(channelId)) {
        reattachToPresent(channelId);
        if (channelAbort !== null) {
          void msgCtrl.loadMessages(channelId, channelAbort.signal);
        }
      }
      const timestamp = new Date().toISOString();
      if (uiStore.getState().connectionStatus !== "connected") {
        // Composer gating normally prevents this, but stay consistent: show a
        // failed row with retry rather than silently dropping the message.
        const cid = crypto.randomUUID();
        addOptimisticMessage({ correlationId: cid, channelId, user, content, replyTo, timestamp });
        draftByCorrelation.set(cid, { content, replyTo, attachments });
        markSendFailed(cid, "OFFLINE");
        return;
      }
      const cid = ws.send({
        type: "chat_send",
        payload: { channel_id: channelId, content, reply_to: replyTo, attachments },
      });
      addOptimisticMessage({ correlationId: cid, channelId, user, content, replyTo, timestamp });
      draftByCorrelation.set(cid, { content, replyTo, attachments });
    }

    function retrySend(correlationId: string): void {
      const draft = draftByCorrelation.get(correlationId);
      draftByCorrelation.delete(correlationId);
      removeOptimistic(correlationId);
      if (draft !== undefined) {
        performSend(draft.content, draft.replyTo, draft.attachments);
      }
    }

    function deleteDraft(correlationId: string): void {
      draftByCorrelation.delete(correlationId);
      removeOptimistic(correlationId);
    }

    void msgCtrl.loadMessages(channelId, signal);

    // MessageList
    messageList = createMessageList({
      channelId,
      channelName,
      channelType,
      currentUserId: userId,
      onScrollTop: () => {
        if (channelAbort !== null) {
          return msgCtrl.loadOlderMessages(channelId, channelAbort.signal);
        }
        return undefined;
      },
      onRetryLoad: () => {
        if (channelAbort !== null) {
          void msgCtrl.loadMessages(channelId, channelAbort.signal);
        }
      },
      // A reply bar (and any other in-row jump) goes through the same jumper
      // as search hits and permalinks, so an out-of-window target fetches its
      // around-window instead of silently doing nothing.
      onJumpToMessage: (msgId: number) => {
        jumpToMessage(channelId, msgId);
      },
      onJumpToPresent: () => {
        // Dropping the detached flag also clears "loaded", so loadMessages
        // refetches the live tail instead of short-circuiting.
        reattachToPresent(channelId);
        if (channelAbort !== null) {
          void msgCtrl.loadMessages(channelId, channelAbort.signal);
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
      onPinClick: (msgId: number, chId: number, currentlyPinned: boolean) => {
        const action = currentlyPinned
          ? api.unpinMessage(chId, msgId)
          : api.pinMessage(chId, msgId);
        action
          .then(() => {
            setMessagePinned(chId, msgId, !currentlyPinned);
            showToast(currentlyPinned ? "Message unpinned" : "Message pinned", "success");
          })
          .catch((err) => {
            log.error("Pin/unpin failed", { error: String(err) });
            showToast("Failed to pin/unpin message", "error");
          });
      },
      onRetry: (correlationId: string) => retrySend(correlationId),
      onDeleteDraft: (correlationId: string) => deleteDraft(correlationId),
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
      gifApi: api,
      onSend: (content: string, replyTo: number | null, attachments: readonly string[]) => {
        performSend(content, replyTo, attachments);
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

    // Composer gating: express permission + connection as affordance. The
    // composer disables (with a reason) when the socket is down or the user
    // may not post here, instead of accepting a click and failing. For DM
    // channels the reason also covers block state (channels-members-dms.md §3.2).
    // Block gating is a 1:1 rule (Discord semantics, mirrored by the server's
    // requireDMNotBlocked): a group DM is a shared room, and gating one
    // member's composer over a block with one other member would leave the
    // group reading a conversation that person cannot join.
    const gatedDm =
      channelType === "dm"
        ? dmStore.getState().channels.find((c) => c.channelId === channelId)
        : undefined;
    const dmRecipientId = gatedDm !== undefined && !gatedDm.isGroup ? gatedDm.recipient.id : null;
    // Slow mode as affordance: after an accepted send the composer disables
    // itself for the channel's cooldown with a live countdown, instead of
    // taking a message the server will bounce with SLOW_MODE (UX spec §5,
    // "do not drop the drafted message" — the draft stays in the textarea).
    let slowModeUntil = 0;
    let slowModeTicker: ReturnType<typeof setInterval> | null = null;

    const stopSlowModeTicker = (): void => {
      if (slowModeTicker !== null) {
        clearInterval(slowModeTicker);
        slowModeTicker = null;
      }
    };

    const slowModeRemaining = (): number =>
      slowModeUntil === 0 ? 0 : Math.max(0, Math.ceil((slowModeUntil - Date.now()) / 1000));

    const computeComposerReason = (): string | null => {
      const status = uiStore.getState().connectionStatus;
      if (status === "reconnecting") return "Reconnecting…";
      if (status === "disconnected") return "Not connected";
      if (dmRecipientId !== null) {
        const blockReason = dmComposerBlockReason(blocksStore.getState(), dmRecipientId);
        if (blockReason !== null) return blockReason;
      }
      const ch = channelsStore.getState().channels.get(channelId);
      if (ch === undefined) return null;
      if (!ch.canSend) {
        return ch.type === "announcement"
          ? "Only moderators can post in announcement channels"
          : "You don't have permission to send messages here";
      }
      const remaining = slowModeRemaining();
      if (remaining > 0) return `Slow mode — ${remaining}s`;
      return null;
    };
    const refreshComposerState = (): void => {
      messageInput?.setDisabled(computeComposerReason());
    };

    /**
     * Begin (or restart) the slow-mode cooldown for this channel. Moderators
     * bypass slow mode server-side, so they never get gated here either.
     */
    const startSlowMode = (seconds: number): void => {
      if (seconds <= 0 || canManageMessages()) return;
      slowModeUntil = Date.now() + seconds * 1000;
      refreshComposerState();
      stopSlowModeTicker();
      slowModeTicker = setInterval(() => {
        if (slowModeRemaining() <= 0) {
          slowModeUntil = 0;
          stopSlowModeTicker();
        }
        refreshComposerState();
      }, 1000);
    };
    composerGatingUnsubs.push(stopSlowModeTicker);

    // The server accepted a message — the next one is subject to the cooldown.
    composerGatingUnsubs.push(
      ws.on("chat_send_ok", () => {
        const ch = channelsStore.getState().channels.get(channelId);
        if (ch !== undefined && ch.id === channelsStore.getState().activeChannelId) {
          startSlowMode(ch.slowMode);
        }
      }),
    );
    // A refused send restarts the full window: the server's limiter is the
    // authority on when the next one is allowed.
    composerGatingUnsubs.push(
      ws.on("error", (payload) => {
        if (payload.code !== "SLOW_MODE") return;
        const ch = channelsStore.getState().channels.get(channelId);
        if (ch !== undefined) startSlowMode(ch.slowMode);
      }),
    );

    refreshComposerState();
    composerGatingUnsubs.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        () => refreshComposerState(),
      ),
    );
    composerGatingUnsubs.push(
      channelsStore.subscribeSelector(
        (s) => s.channels.get(channelId)?.canSend ?? true,
        () => refreshComposerState(),
      ),
    );
    if (dmRecipientId !== null) {
      // Un-gate live when the block clears (unblock) and gate on a refused send.
      composerGatingUnsubs.push(
        blocksStore.subscribeSelector(
          (s) => dmComposerBlockReason(s, dmRecipientId),
          () => refreshComposerState(),
        ),
      );
    }

    // Arrow-up edit: listen for edit-last-message bubbling from MessageInput
    slots.inputSlot.addEventListener(
      "edit-last-message",
      () => {
        const msgs = getChannelMessages(channelId);
        const myId = getCurrentUserId();
        // Find the last message sent by the current user (array is chronological)
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!;
          if (m.user.id === myId && !m.deleted) {
            messageInput?.startEdit(m.id, m.content);
            break;
          }
        }
      },
      { signal },
    );

    // Age gate. Mounted over the message area — the channel is live underneath,
    // so accepting reveals it without a refetch, and declining leaves the
    // channel rather than pretending it is empty. Only the first open of a
    // flagged channel in a session shows it (see @lib/nsfw-gate).
    const storedChannel = channelsStore.getState().channels.get(channelId);
    if (storedChannel !== undefined && nsfwGateRequired(storedChannel)) {
      const gate = createNsfwGate({
        channelId,
        channelName,
        onContinue: () => {
          gate.destroy?.();
          if (nsfwGate === gate) nsfwGate = null;
        },
        onCancel: () => {
          // Leave the channel entirely: keeping the gate up over a channel the
          // reader declined would strand them on a screen with no way out that
          // is not also "continue".
          destroyChannel();
          setActiveChannel(null);
        },
      });
      gate.mount(slots.messagesSlot);
      nsfwGate = gate;
    }

    // Update header
    if (chatHeaderRefs !== null && channelType === "dm") {
      const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
      // A group has no single presence to show, so the subtitle lists who is
      // in it instead — that is the fact a group header is asked for, and a
      // first member's status presented as the group's would be a lie.
      let subtitle = "Offline";
      if (dmChannel !== undefined && dmChannel.isGroup) {
        const names = dmChannel.participants.map((p) => (p.displayName ?? "") || p.username);
        subtitle = `${names.length + 1} members: You, ${names.join(", ")}`;
      } else if (dmChannel !== undefined) {
        const member = membersStore.getState().members.get(dmChannel.recipient.id);
        const status = member?.status ?? dmChannel.recipient.status ?? "Offline";
        subtitle = status.charAt(0).toUpperCase() + status.slice(1);
      }
      const headerName = dmChannel !== undefined ? dmDisplayName(dmChannel) : channelName;
      updateChatHeaderForDm(chatHeaderRefs, { username: headerName, status: subtitle });
    } else if (chatHeaderRefs !== null) {
      updateChatHeaderForDm(chatHeaderRefs, null);
      if (chatHeaderName !== null) {
        setText(chatHeaderName, channelName);
      }
      // Show the channel topic and keep it live across channel_update events.
      const topicEl = chatHeaderRefs.topicEl;
      setText(topicEl, channelsStore.getState().channels.get(channelId)?.topic ?? "");
      composerGatingUnsubs.push(
        channelsStore.subscribeSelector(
          (s) => s.channels.get(channelId)?.topic ?? "",
          (topic) => setText(topicEl, topic),
        ),
      );
    } else if (chatHeaderName !== null) {
      setText(chatHeaderName, channelName);
    }
  }

  return {
    mountChannel,
    destroyChannel,
    openFilePicker: () => messageInput?.openFilePicker(),
    get currentChannelId() {
      return _currentChannelId;
    },
    get messageList() {
      return messageList;
    },
  };
}
