/**
 * ThreadPanel — a thread beside the channel: its starter message on
 * top, the thread's own message list below it, and a composer.
 *
 * The list is an ordinary `createMessageList` keyed by the thread's id (the
 * messages store is keyed by channel, so a second instance mounts beside the
 * channel's). A thread is never in `channelsStore`, so the pieces that read a
 * channel row (send permission, the moderator verdict) read the parent's.
 *
 * Sending is optimistic, the same shape as the channel composer's: the
 * dispatcher's `chat_send_ok` / error handlers settle the row by its
 * correlation id. Files upload as in a channel (paste, drop, the + menu); a
 * send with uploads still running waits for them (threadSendQueue). Typing
 * frames and draft stashing are not wired here; a closed panel drops its
 * unsent text and files.
 *
 * Loaded on first use (ThreadPanelHost), so none of this is in the startup
 * closure.
 */

import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import type { MountableComponent } from "@lib/text/safeRender";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { VoiceUploadMeta } from "@lib/types";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import {
  getChannelMessages,
  isWindowDetached,
  messagesStore,
  reattachToPresent,
} from "@stores/messages.store";
import { getThread, threadsStore } from "@stores/threads.store";
import { createConfirmModal } from "../dialogs/confirmModal";
import { safetyStore } from "../safety/store";
import { formatUntil, safetyText } from "../../i18n/safety";
import { threadComposerReason } from "./threadCommands";
import { createMessageList, type MessageListComponent } from "../messaging/MessageList";
import { createMessageInput, type MessageInputComponent } from "../messaging/MessageInput";
import { createThreadJump } from "./threadJump";
import {
  bindTrackedFailures,
  createTrackedStore,
  restoreFailedEdits,
  sendTrackedDelete,
  sendTrackedEdit,
  settleTrackedError,
  togglePin,
  type TrackedEdit,
} from "../messaging/trackedActions";
import { createThreadSendQueue } from "./threadSendQueue";
import { importedName } from "../messaging/importedAuthor";
import type { MessageController } from "../../pages/main-page/MessageController";
import { messagingText } from "../../i18n/messaging";
import { shellText } from "../../i18n/shell";
import { threadsText } from "../../i18n/threads";
import { createThreadHeader } from "./threadHeader";
import { createThreadSender, currentUser, currentUserId, type ThreadSender } from "./threadSender";
import { createThreadStarter } from "./threadStarter";

export interface ThreadPanelOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly msgCtrl: MessageController;
  readonly threadId: number;
  /** Toggles reactions for this thread's messages; the panel destroys it with itself. */
  readonly reactions: { handleReaction(msgId: number, emoji: string): void; destroy(): void };
  readonly showToast: (msg: string, type: "success" | "error" | "info") => void;
  /** The panel's own close button. */
  readonly onClose: () => void;
}

export type ThreadPanelComponent = MountableComponent & {
  /** Put the caret in the thread's composer. */
  focusComposer(): void;
};

const log = createLogger("thread-panel");

export function createThreadPanel(options: ThreadPanelOptions): ThreadPanelComponent {
  const { ws, api, msgCtrl, threadId, reactions, showToast, onClose } = options;
  const disposable = new Disposable();
  const { signal } = disposable;
  let root: HTMLElement | null = null;
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;

  const thread = () => getThread(threadId);
  const parentId = (): number => thread()?.parent_id ?? 0;

  const header = createThreadHeader({
    ws,
    threadId,
    signal,
    showToast,
    onClose,
    setRootLabel: (name) => root?.setAttribute("aria-label", name),
  });
  const starter = createThreadStarter({ api, threadId, signal });
  const sender = createThreadSender({
    ws,
    api,
    threadId,
    signal,
    showToast,
    restoreUnsent: (files, reason) => messageInput?.restoreUnsent(files, reason),
  });

  // ── Uploads ───────────────────────────────────────────────────────────────

  async function uploadFile(
    file: File,
    uploadSignal?: AbortSignal,
    onProgress?: (fraction: number) => void,
    voice?: VoiceUploadMeta,
  ): Promise<{ id: string; url: string; filename: string }> {
    try {
      const result = await api.uploadFile(file, uploadSignal, onProgress, voice);
      return { id: result.id, url: result.url, filename: result.filename };
    } catch (err) {
      // The composer reports a failure inline; a cancel is not one.
      if (uploadSignal?.aborted !== true) log.error("File upload failed", { error: String(err) });
      throw err;
    }
  }

  /** A reply sent from a window that stops short of the newest message
   *  reattaches first, so it lands at the end of what is shown. */
  const sendReply: ThreadSender["sendText"] = (...args) => {
    if (isWindowDetached(threadId) && !signal.aborted) {
      reattachToPresent(threadId);
      void msgCtrl.loadMessages(threadId, signal);
    }
    sender.sendText(...args);
  };

  const queue = createThreadSendQueue({
    threadId,
    signal,
    currentUser,
    upload: uploadFile,
    discard: (id) => void api.discardUpload(id).catch(() => {}),
    putBack: (files) => messageInput?.restoreUnsent(files, "skipped"),
    dispatch: (content, replyTo, replyPing, files) => {
      const live =
        replyTo === null ||
        getChannelMessages(threadId).some((m) => m.id === replyTo && m.deleted !== true);
      sendReply(content, live ? replyTo : null, live && replyPing, files);
    },
  });

  // ── Composer state ────────────────────────────────────────────────────────

  function composerReason(): string | null {
    const status = uiStore.getState().connectionStatus;
    if (status === "reconnecting") return shellText("channel.reconnecting");
    if (status === "disconnected") return shellText("channel.notConnected");
    const timeout = safetyStore.getState().timeout;
    if (timeout !== null) {
      return safetyText("timeout.composer", { time: formatUntil(timeout.expiresAt) });
    }
    const t = thread();
    if (t === undefined) return null;
    const parent = channelsStore.getState().channels.get(t.parent_id);
    if (parent !== undefined && !parent.canSend) return messagingText("composer.noPermission");
    return threadComposerReason(t);
  }

  function paintComposer(): void {
    messageInput?.setDisabled(composerReason());
    const t = thread();
    messageInput?.setSlowModeNote(
      t?.archived === true ? threadsText("composer.archivedNote") : null,
    );
  }

  // ── Delete a message ──────────────────────────────────────────────────────

  const tracked = createTrackedStore();
  const pinsInFlight = new Set<string>();

  function sendDelete(messageId: number): void {
    sendTrackedDelete(tracked, ws, showToast, threadId, messageId);
  }

  function confirmDeleteMessage(messageId: number): void {
    createConfirmModal({
      title: messagingText("delete.title"),
      titleId: `thread-msg-delete-title-${messageId}`,
      body: messagingText("delete.body"),
      confirmLabel: messagingText("delete.confirm"),
      confirmTestId: "thread-msg-delete-confirm",
      signal,
      onConfirm: () => sendDelete(messageId),
    });
  }

  const jumpTo = createThreadJump({
    api,
    threadId,
    signal,
    getList: () => messageList,
    showToast,
  });

  const restoreEdits = (edits: readonly TrackedEdit[], toast: boolean): void =>
    restoreFailedEdits(
      {
        currentChannelId: () => threadId,
        messageList: () => messageList,
        messageInput: () => messageInput,
        showToast,
      },
      edits,
      toast,
    );

  // ── Mount ─────────────────────────────────────────────────────────────────

  function mount(container: Element): void {
    const t = thread();
    root = createElement("section", {
      class: "thread-panel",
      "data-testid": "thread-panel",
      "data-thread-id": String(threadId),
      "aria-label": t?.name ?? threadsText("panel.label"),
    });
    const messagesSlot = createElement("div", {
      class: "thread-panel-messages",
      "data-testid": "thread-panel-messages",
    });
    const inputSlot = createElement("div", { class: "thread-panel-input" });
    root.append(header.element, starter.element, messagesSlot, inputSlot);
    container.appendChild(root);

    messageList = createMessageList({
      channelId: threadId,
      channelName: t?.name ?? "",
      channelType: "thread",
      currentUserId: currentUserId(),
      onScrollTop: () => msgCtrl.loadOlderMessages(threadId, signal),
      onScrollBottom: () => msgCtrl.loadNewerMessages(threadId, signal),
      onRetryLoad: () => void msgCtrl.loadMessages(threadId, signal),
      onJumpToPresent: () => {
        // Dropping the detached flag clears "loaded", so the reload refetches the live tail.
        reattachToPresent(threadId);
        void msgCtrl.loadMessages(threadId, signal);
      },
      onReplyClick: (messageId) => {
        const msg = getChannelMessages(threadId).find((m) => m.id === messageId);
        if (msg === undefined) return;
        messageInput?.setReplyTo(
          msg.id,
          msg.importedAuthor !== undefined
            ? importedName(msg.importedAuthor)
            : msg.user.display_name || msg.user.username,
          {
            self: msg.importedAuthor !== undefined || msg.user.id === currentUserId(),
          },
        );
      },
      onEditClick: (messageId) => void messageList?.startEdit(messageId),
      onEditSave: (messageId, content) => {
        const original = getChannelMessages(threadId).find((m) => m.id === messageId);
        if (original?.content === content) return true;
        return sendTrackedEdit(tracked, ws, showToast, threadId, messageId, content);
      },
      onEmptyEdit: (messageId) => {
        messageList?.cancelEdit();
        confirmDeleteMessage(messageId);
      },
      onEditEnd: () => messageInput?.focus(),
      onDeleteClick: (messageId, shiftKey) => {
        if (shiftKey) sendDelete(messageId);
        else confirmDeleteMessage(messageId);
      },
      onReactionClick: (messageId, emoji) => reactions.handleReaction(messageId, emoji),
      onPinClick: (messageId, channelId, currentlyPinned) =>
        togglePin(pinsInFlight, api, showToast, messageId, channelId, currentlyPinned),
      onJumpToMessage: (messageId) => void jumpTo(messageId),
      onRetry: (correlationId) => {
        if (!queue.retry(correlationId)) sender.retryDraft(correlationId);
      },
      renderUploadStrip: queue.renderUploadStrip,
      onDeleteDraft: (correlationId) => {
        if (!queue.remove(correlationId)) sender.discardDraft(correlationId);
      },
    });
    messageList.mount(messagesSlot);
    void msgCtrl.loadMessages(threadId, signal);

    messageInput = createMessageInput({
      channelId: threadId,
      channelName: t?.name ?? "",
      gifApi: api,
      onSend: (content, replyTo, _attachments, files, replyPing, queued) => {
        if (queued === undefined) sendReply(content, replyTo, replyPing, files);
        else queue.enqueue(content, replyTo, replyPing, queued);
      },
      onSendSticker: (sticker, replyTo, replyPing) => {
        sendReply("", replyTo, replyPing, [], undefined, sticker);
      },
      onUploadFile: uploadFile,
      onDiscardUpload: (id) => api.discardUpload(id),
      onTyping: () => {},
      onReplyTargetChange: (messageId) => messageList?.setReplyTarget(messageId),
      placeholder: threadsText("composer.placeholder"),
      dropZone: ".thread-panel",
    });
    sender.watchUnsentFiles(disposable);
    for (const unsub of bindTrackedFailures(tracked, ws, showToast, restoreEdits)) {
      disposable.addCleanup(unsub);
    }
    // A refused edit restores the text; the dispatcher's own chain shows the one error.
    disposable.addCleanup(
      ws.on("error", (_payload, correlationId) => {
        if (correlationId !== undefined) settleTrackedError(tracked, restoreEdits, correlationId);
      }),
    );
    disposable.addCleanup(() => {
      for (const timer of tracked.trackTimers.values()) window.clearTimeout(timer);
      tracked.trackTimers.clear();
    });
    messageInput.mount(inputSlot);

    header.paint();
    starter.paint();
    starter.fetchIfMissing();
    paintComposer();

    // Everything the panel shows follows the stores it reads.
    disposable.onStoreChange(
      threadsStore,
      (s) => s.byId.get(threadId),
      () => {
        header.paint();
        starter.paint();
        paintComposer();
      },
    );
    disposable.onStoreChange(threadsStore, (s) => s.followed.has(threadId), header.paint);
    disposable.onStoreChange(
      messagesStore,
      (s) => s.messagesByChannel.get(thread()?.parent_id ?? 0),
      () => starter.paint(),
    );
    disposable.onStoreChange(
      channelsStore,
      (s) => s.channels.get(parentId()),
      () => {
        header.paint();
        paintComposer();
      },
    );
    disposable.onStoreChange(uiStore, (s) => s.connectionStatus, paintComposer);
    disposable.onStoreChange(safetyStore, (s) => s.timeout, paintComposer);
  }

  function destroy(): void {
    reactions.destroy();
    messageList?.destroy?.();
    messageList = null;
    messageInput?.destroy?.();
    messageInput = null;
    disposable.destroy();
    root?.remove();
    root = null;
  }

  return {
    mount,
    destroy,
    focusComposer: () => messageInput?.focus(),
  };
}
