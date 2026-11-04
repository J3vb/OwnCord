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

import { isImeCommit } from "@lib/text/ime";
import { createElement, setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon, type IconName } from "@lib/icons";
import { createConfirmModal } from "../features/dialogs/confirmModal";
import { openMenuSheet } from "../features/menus/menuSheet";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import type { ContextMenuItem } from "@lib/ui/contextMenu";
import { formatMessageTimestamp, resolveAuthor, userRoleColorVar } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/ui/avatar";
import { readableRoleColor } from "@lib/prefs/themes";
import type { MountableComponent } from "@lib/text/safeRender";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { MessageUser, VoiceUploadMeta } from "@lib/types";
import { WsErrorCode } from "@lib/protocolTypes";
import { createLogger } from "@lib/logger";
import {
  newClientMessageId,
  pendingMessageRetryFloor,
  supportsMessageDeduplication,
} from "@lib/pendingMessages";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import {
  addOptimisticMessage,
  getChannelMessages,
  markSendFailed,
  messagesStore,
  removeOptimistic,
  setMessagePinned,
  type Message,
} from "@stores/messages.store";
import { getThread, isFollowed, threadsStore } from "@stores/threads.store";
import { threadFollowsEnabled } from "@lib/net/serverCapabilities";
import { safetyStore } from "../features/safety/store";
import { formatUntil, safetyText } from "../i18n/safety";
import { messageResponseToMessage } from "../features/messaging/messageModel";
import {
  canManageThread,
  cleanThreadName,
  isThreadModerator,
  sendThreadDelete,
  sendThreadFollow,
  sendThreadUpdate,
  threadComposerReason,
  THREAD_NAME_MAX,
} from "../features/threads/threadCommands";
import { createMessageList, type MessageListComponent } from "./MessageList";
import {
  createMessageInput,
  type MessageInputComponent,
  type SentAttachment,
} from "./MessageInput";
import { createThreadSendQueue } from "../features/threads/threadSendQueue";
import { createArchiveIcon } from "./message-list/threadChip";
import { renderMessageContent } from "../features/messaging/content/contentParser";
import { createAvatarElement, pickAvatarColor } from "../features/profiles/avatar";
import {
  createImportedAvatar,
  createImportedName,
  createImportedTag,
} from "./message-list/importedAuthor";
import { importedName } from "../features/messaging/importedAuthor";
import type { MessageController } from "../pages/main-page/MessageController";
import { messagingText } from "../i18n/messaging";
import { shellText } from "../i18n/shell";
import { threadsText } from "../i18n/threads";
import { stickersText } from "../i18n/stickers";
import { findSticker } from "@stores/stickers.store";

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

/** What a failed optimistic send needs to be sent again. */
interface SendDraft {
  readonly content: string;
  readonly replyTo: number | null;
  readonly replyPing: boolean;
  readonly clientMessageId: string | undefined;
  /** The uploaded files it carried, kept so a retry posts them again. */
  readonly attachments: readonly SentAttachment[];
  /** A sticker send, kept so a retry posts the same sticker. */
  readonly sticker?: { readonly id: number; readonly name: string };
}

const log = createLogger("thread-panel");

const userId = (): number => authStore.getState().user?.id ?? 0;

function currentUser(): MessageUser | null {
  const u = authStore.getState().user;
  return u === null ? null : { id: u.id, username: u.username, avatar: u.avatar };
}

export function createThreadPanel(options: ThreadPanelOptions): ThreadPanelComponent {
  const { ws, api, msgCtrl, threadId, reactions, showToast, onClose } = options;
  const disposable = new Disposable();
  const { signal } = disposable;
  let root: HTMLElement | null = null;
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  const drafts = new Map<string, SendDraft>();

  const thread = () => getThread(threadId);
  const parentId = (): number => thread()?.parent_id ?? 0;

  // ── Header ────────────────────────────────────────────────────────────────

  const nameEl = createElement("span", { class: "thread-panel-name" });
  const parentEl = createElement("span", { class: "thread-panel-parent" });
  const statusEl = createElement("span", {
    class: "thread-panel-status",
    "data-testid": "thread-panel-status",
  });
  /** A forum post's tags; empty and hidden on any other thread. */
  const tagsEl = createElement("span", {
    class: "forum-tags thread-panel-tags",
    "data-testid": "thread-panel-tags",
  });
  const actionsEl = createElement("div", { class: "thread-panel-actions" });
  const titleEl = createElement("div", { class: "thread-panel-title" });
  const renameForm = createElement("form", { class: "thread-panel-rename" });
  renameForm.hidden = true;

  function iconButton(
    icon: IconName | "archive",
    testId: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = createElement("button", {
      type: "button",
      class: "thread-panel-btn",
      "data-testid": testId,
    });
    btn.appendChild(icon === "archive" ? createArchiveIcon(16) : createIcon(icon, 16));
    btn.addEventListener("click", onClick, { signal });
    return btn;
  }

  const renameBtn = iconButton("pencil", "thread-rename", () => startRename());
  const archiveBtn = iconButton("archive", "thread-archive", () => {
    const t = thread();
    if (t !== undefined) update({ archived: !t.archived });
  });
  const lockBtn = iconButton("lock", "thread-lock", () => {
    const t = thread();
    if (t !== undefined) update({ locked: !t.locked });
  });
  // Follow / Following: the state comes back as thread_follow_update.
  const followBtn = createElement("button", {
    type: "button",
    class: "thread-panel-btn thread-panel-follow",
    "data-testid": "thread-follow",
  });
  followBtn.addEventListener(
    "click",
    () => {
      if (!sendThreadFollow(ws, threadId, !isFollowed(threadId))) {
        showToast(threadsText("toast.notConnected"), "error");
      }
    },
    { signal },
  );
  const deleteBtn = iconButton("trash-2", "thread-delete", () => confirmDelete());
  deleteBtn.classList.add("danger");
  const closeBtn = iconButton("x", "thread-close", onClose);
  closeBtn.classList.add("thread-panel-close");
  closeBtn.title = threadsText("panel.close");
  closeBtn.setAttribute("aria-label", threadsText("panel.close"));
  // A phone shows only this and Close; the actions open in one sheet.
  const moreBtn = iconButton("ellipsis", "thread-more", () => openActionsSheet());
  moreBtn.classList.add("thread-panel-more");
  moreBtn.title = threadsText("panel.more");
  moreBtn.setAttribute("aria-label", threadsText("panel.more"));
  moreBtn.setAttribute("aria-haspopup", "true");
  moreBtn.setAttribute("aria-expanded", "false");

  /** Where focus lands after an action, on whichever layout shows it. */
  const actionFocus = (desktopBtn: HTMLButtonElement): HTMLButtonElement =>
    isPhoneLayout() ? moreBtn : desktopBtn;

  /** The header actions this viewer may use, as sheet rows in the desktop order. */
  function actionItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    const row = (btn: HTMLButtonElement, item: ContextMenuItem): void => {
      if (!btn.hidden) items.push(item);
    };
    row(followBtn, {
      label: threadsText("follow.follow"),
      checked: isFollowed(threadId),
      testId: "thread-sheet-follow",
      onClick: () => followBtn.click(),
    });
    row(renameBtn, {
      label: threadsText("action.rename"),
      testId: "thread-sheet-rename",
      onClick: () => startRename(),
    });
    row(archiveBtn, {
      label: archiveBtn.getAttribute("aria-label") ?? "",
      testId: "thread-sheet-archive",
      onClick: () => archiveBtn.click(),
    });
    row(lockBtn, {
      label: lockBtn.getAttribute("aria-label") ?? "",
      testId: "thread-sheet-lock",
      onClick: () => lockBtn.click(),
    });
    row(deleteBtn, {
      label: threadsText("action.delete"),
      danger: true,
      testId: "thread-sheet-delete",
      onClick: () => confirmDelete(),
    });
    return items;
  }

  function openActionsSheet(): void {
    const items = actionItems();
    if (items.length === 0) return;
    moreBtn.setAttribute("aria-expanded", "true");
    openMenuSheet({
      items,
      label: threadsText("panel.more"),
      testId: "thread-actions-sheet",
      signal,
      fallbackFocus: () => (moreBtn.isConnected ? moreBtn : null),
      onClosed: () => moreBtn.setAttribute("aria-expanded", "false"),
    });
  }

  function update(fields: Parameters<typeof sendThreadUpdate>[2]): void {
    if (!sendThreadUpdate(ws, threadId, fields)) {
      showToast(threadsText("toast.notConnected"), "error");
    }
  }

  const renameInput = createElement("input", {
    type: "text",
    class: "thread-panel-rename-input",
    maxlength: String(THREAD_NAME_MAX),
    "aria-label": threadsText("rename.label"),
    "data-testid": "thread-rename-input",
  });
  const renameSave = createElement(
    "button",
    { type: "submit", class: "thread-panel-btn", "data-testid": "thread-rename-save" },
    threadsText("rename.save"),
  );
  const renameCancel = createElement(
    "button",
    { type: "button", class: "thread-panel-btn", "data-testid": "thread-rename-cancel" },
    threadsText("rename.cancel"),
  );
  renameForm.append(renameInput, renameSave, renameCancel);

  function startRename(): void {
    renameInput.value = thread()?.name ?? "";
    renameForm.hidden = false;
    titleEl.hidden = true;
    renameInput.focus();
    renameInput.select();
  }
  function endRename(): void {
    renameForm.hidden = true;
    titleEl.hidden = false;
    actionFocus(renameBtn).focus();
  }
  renameCancel.addEventListener("click", endRename, { signal });
  renameInput.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !isImeCommit(e)) {
        e.stopPropagation();
        endRename();
      }
    },
    { signal },
  );
  renameForm.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const name = cleanThreadName(renameInput.value);
      if (name === null) return;
      if (name !== thread()?.name) update({ name });
      endRename();
    },
    { signal },
  );

  function confirmDelete(): void {
    const t = thread();
    if (t === undefined) return;
    createConfirmModal({
      title: threadsText("delete.title"),
      titleId: `thread-delete-title-${threadId}`,
      body: threadsText("delete.body", { name: t.name }),
      confirmLabel: threadsText("delete.confirm"),
      testId: "thread-delete-modal",
      confirmTestId: "thread-delete-confirm",
      cancelTestId: "thread-delete-cancel",
      signal,
      fallbackFocus: () => actionFocus(deleteBtn),
      onConfirm: () => {
        if (!sendThreadDelete(ws, threadId)) {
          showToast(threadsText("toast.notConnected"), "error");
        }
      },
    });
  }

  /** The name, status and the actions this viewer may use, from the thread's current state. */
  function paintHeader(): void {
    const t = thread();
    if (t === undefined) return;
    setText(nameEl, t.name);
    const parent = channelsStore.getState().channels.get(t.parent_id);
    setText(
      parentEl,
      parent === undefined ? "" : threadsText("panel.in", { channel: parent.name }),
    );
    const marks = [
      t.archived ? threadsText("status.archived") : "",
      t.locked ? threadsText("status.locked") : "",
    ].filter((m) => m !== "");
    setText(statusEl, marks.join(" · "));
    statusEl.hidden = marks.length === 0;
    const forumTags = channelsStore.getState().channels.get(t.parent_id)?.forum?.tags ?? [];
    tagsEl.replaceChildren(
      ...forumTags
        .filter((tag) => t.post?.tag_ids.includes(tag.id) === true)
        .map((tag) =>
          createElement("span", { class: "forum-tag" }, `${tag.emoji ?? ""} ${tag.name}`.trim()),
        ),
    );
    tagsEl.hidden = tagsEl.childElementCount === 0;

    const following = isFollowed(threadId);
    followBtn.hidden = !threadFollowsEnabled();
    followBtn.textContent = threadsText(following ? "follow.following" : "follow.follow");
    followBtn.setAttribute("aria-pressed", String(following));
    followBtn.title = threadsText(following ? "follow.unfollowHint" : "follow.followHint");

    const manage = canManageThread(t, userId());
    const moderator = isThreadModerator(t);
    renameBtn.hidden = !manage;
    archiveBtn.hidden = !manage;
    lockBtn.hidden = !moderator;
    deleteBtn.hidden = !moderator;
    moreBtn.hidden = [followBtn, renameBtn, archiveBtn, lockBtn, deleteBtn].every((b) => b.hidden);
    const archiveLabel = threadsText(t.archived ? "action.unarchive" : "action.archive");
    archiveBtn.title = archiveLabel;
    archiveBtn.setAttribute("aria-label", archiveLabel);
    const lockLabel = threadsText(t.locked ? "action.unlock" : "action.lock");
    lockBtn.title = lockLabel;
    lockBtn.setAttribute("aria-label", lockLabel);
    renameBtn.title = threadsText("action.rename");
    renameBtn.setAttribute("aria-label", threadsText("action.rename"));
    deleteBtn.title = threadsText("action.delete");
    deleteBtn.setAttribute("aria-label", threadsText("action.delete"));
    root?.setAttribute("aria-label", t.name);
  }

  // ── Starter message ───────────────────────────────────────────────────────

  const starterEl = createElement("div", {
    class: "thread-starter",
    "data-testid": "thread-starter",
  });
  /** The starter when it is not in the parent's loaded window (opened from the thread list). */
  let fetchedStarter: Message | null = null;
  let starterFetchedFor = 0;

  function findStarter(): Message | undefined {
    const t = thread();
    if (t === undefined || t.starter_message_id === null) return undefined;
    const id = t.starter_message_id;
    return getChannelMessages(t.parent_id).find((m) => m.id === id) ?? fetchedStarter ?? undefined;
  }

  function fetchStarterIfMissing(): void {
    const t = thread();
    if (t === undefined || t.starter_message_id === null) return;
    const id = t.starter_message_id;
    if (starterFetchedFor === id) return;
    if (getChannelMessages(t.parent_id).some((m) => m.id === id)) return;
    starterFetchedFor = id;
    api.getMessagesAround(t.parent_id, id, { limit: 1 }, signal).then(
      (resp) => {
        const found = resp.messages.find((m) => m.id === id);
        if (found === undefined || signal.aborted) return;
        fetchedStarter = messageResponseToMessage(found);
        paintStarter();
      },
      () => {
        // The placeholder stays; the thread itself is unaffected.
      },
    );
  }

  function paintStarter(): void {
    const t = thread();
    starterEl.replaceChildren();
    // A forum post has no starter message: its opening message is the first
    // one in the list below, so there is nothing to state here.
    starterEl.hidden = t?.post !== undefined;
    if (t === undefined || t.post !== undefined) return;
    const msg = findStarter();
    if (t.starter_message_id === null || msg?.deleted === true) {
      starterEl.appendChild(
        createElement("div", { class: "thread-starter-note" }, threadsText("starter.deleted")),
      );
      return;
    }
    if (msg === undefined) {
      starterEl.appendChild(
        createElement("div", { class: "thread-starter-note" }, threadsText("starter.unavailable")),
      );
      return;
    }
    const author = resolveAuthor(msg.user);
    const color = userRoleColorVar(msg.user.id);
    const imported = msg.importedAuthor;
    starterEl.appendChild(
      imported !== undefined
        ? createImportedAvatar(imported, "msg-avatar thread-starter-avatar")
        : createAvatarElement(author, {
            className: "msg-avatar thread-starter-avatar",
            background: pickAvatarColor(author.username),
          }),
    );
    const main = createElement("div", { class: "thread-starter-main" });
    const head = createElement("div", { class: "thread-starter-head" });
    head.appendChild(
      imported !== undefined
        ? createImportedName(imported, "msg-author msg-author--imported")
        : createElement(
            "span",
            {
              class: "msg-author",
              style: `color: ${readableRoleColor(color)}`,
              "data-role-color": color,
            },
            resolveDisplayName(author),
          ),
    );
    if (imported !== undefined) head.appendChild(createImportedTag());
    head.appendChild(
      createElement("span", { class: "msg-time" }, formatMessageTimestamp(msg.timestamp)),
    );
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(
      renderMessageContent(
        msg.content,
        {
          mentions: msg.mentions,
          mentionsEveryone: msg.mentionsEveryone,
          mentionRoles: msg.mentionRoles,
        },
        msg.id === 0 ? undefined : `${msg.id}\u0000${msg.editedAt ?? ""}`,
      ),
    );
    main.append(head, text);
    starterEl.appendChild(main);
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  function sendText(
    content: string,
    replyTo: number | null,
    replyPing: boolean,
    files: readonly SentAttachment[],
    existingClientMessageId?: string,
    sticker?: { readonly id: number; readonly name: string },
  ): void {
    const user = currentUser();
    if (user === null || signal.aborted) return;
    const owner = { host: api.getConfig?.().host ?? "", userId: user.id };
    const clientMessageId =
      existingClientMessageId ??
      (supportsMessageDeduplication(owner)
        ? newClientMessageId(pendingMessageRetryFloor(owner))
        : undefined);
    // A sticker send commits with its receipt, so the server requires the id.
    if (sticker !== undefined && clientMessageId === undefined) {
      showToast(stickersText("send.unsupported"), "error");
      return;
    }
    const timestamp = new Date().toISOString();
    const draft: SendDraft = {
      content,
      replyTo,
      replyPing,
      clientMessageId,
      attachments: files,
      ...(sticker === undefined ? {} : { sticker }),
    };
    const live = sticker === undefined ? null : findSticker(sticker.id);
    const row = {
      content: sticker === undefined ? content : `[Sticker: ${sticker.name}]`,
      ...(live === null ? {} : { sticker: { id: live.id, name: live.name, url: live.url } }),
    };
    if (uiStore.getState().connectionStatus !== "connected") {
      const cid = crypto.randomUUID();
      addOptimisticMessage({
        correlationId: cid,
        clientMessageId,
        channelId: threadId,
        user,
        ...row,
        replyTo,
        timestamp,
      });
      drafts.set(cid, draft);
      markSendFailed(cid, "OFFLINE");
      return;
    }
    const cid = ws.send({
      type: "chat_send",
      payload: {
        channel_id: threadId,
        content: sticker === undefined ? content : "",
        ...(sticker === undefined ? {} : { sticker_id: sticker.id }),
        reply_to: replyTo,
        ...(replyTo === null ? {} : { reply_ping: replyPing }),
        attachments: files.map((f) => f.id),
        ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
      },
    });
    addOptimisticMessage({
      correlationId: cid,
      clientMessageId,
      channelId: threadId,
      user,
      ...row,
      replyTo,
      timestamp,
    });
    drafts.set(cid, draft);
  }

  function retrySend(correlationId: string): void {
    if (queue.retry(correlationId)) return;
    const draft = drafts.get(correlationId);
    if (draft === undefined) return;
    // A refused reply may point at a message deleted outside the loaded
    // window: nothing was stored, so it goes again as a plain message.
    const refusedReply =
      draft.replyTo !== null &&
      getChannelMessages(threadId).find((m) => m.correlationId === correlationId)?.errorCode ===
        WsErrorCode.BAD_REQUEST;
    drafts.delete(correlationId);
    removeOptimistic(correlationId);
    sendText(
      draft.content,
      refusedReply ? null : draft.replyTo,
      !refusedReply && draft.replyPing,
      draft.attachments,
      draft.clientMessageId,
      draft.sticker,
    );
  }

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
      sendText(content, live ? replyTo : null, live && replyPing, files);
    },
  });

  /** Files a send did not carry go back into the composer. */
  function watchUnsentFiles(): void {
    disposable.addCleanup(
      ws.on("chat_send_ok", (payload, correlationId) => {
        const draft = correlationId === undefined ? undefined : drafts.get(correlationId);
        if (draft === undefined || correlationId === undefined) return;
        // Delivered: nothing will retry it, so its files are not held on to.
        drafts.delete(correlationId);
        const skipped = new Set(payload.skipped_attachment_ids ?? []);
        const unsent = draft.attachments.filter((a) => skipped.has(a.id));
        if (unsent.length > 0) messageInput?.restoreUnsent(unsent, "skipped");
      }),
    );
    disposable.addCleanup(
      ws.on("error", (payload, correlationId) => {
        if (payload.code !== WsErrorCode.ATTACHMENTS_UNAVAILABLE || correlationId === undefined) {
          return;
        }
        const draft = drafts.get(correlationId);
        if (draft === undefined) return;
        // Nothing was stored and the dispatcher drops the row; a Retry with
        // the same ids would fail the same way.
        drafts.delete(correlationId);
        messageInput?.restoreUnsent(draft.attachments, "unavailable");
      }),
    );
  }

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

  function sendDelete(messageId: number): void {
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(messagingText("toast.deleteFailed"), "error");
      return;
    }
    ws.send({ type: "chat_delete", payload: { message_id: messageId } });
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

  // ── Mount ─────────────────────────────────────────────────────────────────

  function mount(container: Element): void {
    const t = thread();
    root = createElement("section", {
      class: "thread-panel",
      "data-testid": "thread-panel",
      "data-thread-id": String(threadId),
      "aria-label": t?.name ?? threadsText("panel.label"),
    });
    const header = createElement("div", { class: "thread-panel-header" });
    titleEl.append(nameEl, parentEl, statusEl, tagsEl);
    actionsEl.append(followBtn, renameBtn, archiveBtn, lockBtn, deleteBtn, moreBtn, closeBtn);
    header.append(titleEl, renameForm, actionsEl);
    const messagesSlot = createElement("div", {
      class: "thread-panel-messages",
      "data-testid": "thread-panel-messages",
    });
    const inputSlot = createElement("div", { class: "thread-panel-input" });
    root.append(header, starterEl, messagesSlot, inputSlot);
    container.appendChild(root);

    messageList = createMessageList({
      channelId: threadId,
      channelName: t?.name ?? "",
      channelType: "thread",
      currentUserId: userId(),
      onScrollTop: () => msgCtrl.loadOlderMessages(threadId, signal),
      onRetryLoad: () => void msgCtrl.loadMessages(threadId, signal),
      onReplyClick: (messageId) => {
        const msg = getChannelMessages(threadId).find((m) => m.id === messageId);
        if (msg === undefined) return;
        messageInput?.setReplyTo(
          msg.id,
          msg.importedAuthor !== undefined
            ? importedName(msg.importedAuthor)
            : msg.user.display_name || msg.user.username,
          {
            self: msg.importedAuthor !== undefined || msg.user.id === userId(),
          },
        );
      },
      onEditClick: (messageId) => void messageList?.startEdit(messageId),
      onEditSave: (messageId, content) => {
        const original = getChannelMessages(threadId).find((m) => m.id === messageId);
        if (original?.content === content) return true;
        if (uiStore.getState().connectionStatus !== "connected") {
          showToast(messagingText("toast.editFailed"), "error");
          return false;
        }
        ws.send({ type: "chat_edit", payload: { message_id: messageId, content } });
        return true;
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
      onPinClick: (messageId, channelId, currentlyPinned) => {
        setMessagePinned(channelId, messageId, !currentlyPinned);
        const request = currentlyPinned
          ? api.unpinMessage(channelId, messageId)
          : api.pinMessage(channelId, messageId);
        request.catch(() => {
          setMessagePinned(channelId, messageId, currentlyPinned);
          showToast(messagingText("toast.pinFailed"), "error");
        });
      },
      onRetry: retrySend,
      renderUploadStrip: queue.renderUploadStrip,
      onDeleteDraft: (correlationId) => {
        if (queue.remove(correlationId)) return;
        drafts.delete(correlationId);
        removeOptimistic(correlationId);
      },
    });
    messageList.mount(messagesSlot);
    void msgCtrl.loadMessages(threadId, signal);

    messageInput = createMessageInput({
      channelId: threadId,
      channelName: t?.name ?? "",
      gifApi: api,
      onSend: (content, replyTo, _attachments, files, replyPing, queued) => {
        if (queued === undefined) sendText(content, replyTo, replyPing, files);
        else queue.enqueue(content, replyTo, replyPing, queued);
      },
      onSendSticker: (sticker, replyTo, replyPing) => {
        sendText("", replyTo, replyPing, [], undefined, sticker);
      },
      onUploadFile: uploadFile,
      onDiscardUpload: (id) => api.discardUpload(id),
      onTyping: () => {},
      placeholder: threadsText("composer.placeholder"),
      dropZone: ".thread-panel",
    });
    watchUnsentFiles();
    messageInput.mount(inputSlot);

    paintHeader();
    paintStarter();
    fetchStarterIfMissing();
    paintComposer();

    // Everything the panel shows follows the stores it reads.
    disposable.onStoreChange(
      threadsStore,
      (s) => s.byId.get(threadId),
      () => {
        paintHeader();
        paintStarter();
        paintComposer();
      },
    );
    disposable.onStoreChange(threadsStore, (s) => s.followed.has(threadId), paintHeader);
    disposable.onStoreChange(
      messagesStore,
      (s) => s.messagesByChannel.get(thread()?.parent_id ?? 0),
      () => paintStarter(),
    );
    disposable.onStoreChange(
      channelsStore,
      (s) => s.channels.get(parentId()),
      () => {
        paintHeader();
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
    drafts.clear();
  }

  return {
    mount,
    destroy,
    focusComposer: () => messageInput?.focus(),
  };
}
