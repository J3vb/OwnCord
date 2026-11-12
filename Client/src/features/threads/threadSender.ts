/**
 * Sending into a thread: the optimistic row, the `chat_send` frame, and the
 * drafts that let a failed send go again. The dispatcher's `chat_send_ok` and
 * error handlers settle the row by its correlation id; this keeps what a
 * retry, or a file the server did not take, needs from the original send.
 */

import { WsErrorCode } from "@lib/protocolTypes";
import {
  acknowledgePendingMessage,
  newClientMessageId,
  pendingMessageExpired,
  pendingMessageRetryFloor,
  recoveredPendingText,
  savePendingText,
  supportsMessageDeduplication,
  type PendingMessageOwner,
} from "@lib/pendingMessages";
import type { Disposable } from "@lib/disposable";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { MessageUser } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import {
  addOptimisticMessage,
  getChannelMessages,
  markSendFailed,
  removeOptimistic,
} from "@stores/messages.store";
import { findSticker } from "@stores/stickers.store";
import type { SentAttachment } from "../messaging/MessageInput";
import { messagingText } from "../../i18n/messaging";
import { stickersText } from "../../i18n/stickers";

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

/**
 * The drafts of each thread, kept beyond one panel: a failed row survives the
 * panel closing and reopening, and its Retry needs the draft that is held here.
 */
const draftsByThread = new Map<number, Map<string, SendDraft>>();

/** How long a sent reply may wait for the server before its row offers Retry. */
export const THREAD_SEND_UNCONFIRMED_MS = 20_000;

/** The unconfirmed timer of each sent row, kept beyond one panel like the drafts. */
const sendTimers = new Map<string, number>();

/**
 * Each thread's sends in order: a reply whose text is still being saved holds
 * back the sends after it, so a quick second send cannot overtake it.
 */
const sendChains = new Map<number, { tail: Promise<void>; depth: number }>();

/** Bumped by each session reset, so a send still waiting on its save never reaches the next session. */
let sessionEpoch = 0;

void registerSessionReset("threads:sendDrafts", () => {
  sessionEpoch += 1;
  draftsByThread.clear();
  for (const timer of sendTimers.values()) window.clearTimeout(timer);
  sendTimers.clear();
  sendChains.clear();
}); // app-lifetime

function clearSendTimer(correlationId: string): void {
  const timer = sendTimers.get(correlationId);
  if (timer === undefined) return;
  sendTimers.delete(correlationId);
  window.clearTimeout(timer);
}

/** A live socket can lose an acknowledgement without closing: end the spinner honestly. */
function startSendTimer(threadId: number, correlationId: string, userId: number): void {
  clearSendTimer(correlationId);
  const timer = window.setTimeout(() => {
    sendTimers.delete(correlationId);
    if (currentUserId() !== userId) return;
    const row = getChannelMessages(threadId).find((m) => m.correlationId === correlationId);
    if (row?.status === "pending") markSendFailed(correlationId, "UNCONFIRMED");
  }, THREAD_SEND_UNCONFIRMED_MS);
  sendTimers.set(correlationId, timer);
}

/** Run `send` after the thread's earlier sends and after `persist`, when there is one. */
function enqueueSend(
  threadId: number,
  persist: (() => Promise<unknown>) | undefined,
  send: () => void,
): void {
  const busy = sendChains.get(threadId);
  if (persist === undefined && busy === undefined) {
    send();
    return;
  }
  const chain = busy ?? { tail: Promise.resolve(), depth: 0 };
  sendChains.set(threadId, chain);
  chain.depth += 1;
  chain.tail = chain.tail
    .then(() => persist?.())
    .then(send)
    .catch(() => undefined)
    .finally(() => {
      chain.depth -= 1;
      if (chain.depth === 0 && sendChains.get(threadId) === chain) sendChains.delete(threadId);
    });
}

/** The thread's drafts, without those whose row is gone (settled while the panel was closed). */
function draftsFor(threadId: number): Map<string, SendDraft> {
  let drafts = draftsByThread.get(threadId);
  if (drafts === undefined) {
    drafts = new Map<string, SendDraft>();
    draftsByThread.set(threadId, drafts);
  }
  // A row settled while no panel was open keeps its correlation id, so only
  // rows still unsettled keep their draft.
  const live = new Set(
    getChannelMessages(threadId)
      .filter((m) => m.status !== "sent")
      .map((m) => m.correlationId),
  );
  for (const cid of drafts.keys()) if (!live.has(cid)) drafts.delete(cid);
  return drafts;
}

/** True while a draft is held for the thread. */
export const holdsThreadDrafts = (threadId: number): boolean =>
  (draftsByThread.get(threadId)?.size ?? 0) > 0;

type StickerRef = { readonly id: number; readonly name: string };

/**
 * The id under which the encrypted outbox keeps a send: plain text only, the
 * same set the channel composer saves.
 */
function outboxId(draft: SendDraft): string | undefined {
  const plain =
    draft.replyTo === null && draft.attachments.length === 0 && draft.sticker === undefined;
  return plain ? draft.clientMessageId : undefined;
}

export const currentUserId = (): number => authStore.getState().user?.id ?? 0;

export function currentUser(): MessageUser | null {
  const u = authStore.getState().user;
  return u === null ? null : { id: u.id, username: u.username, avatar: u.avatar };
}

/** The part of the optimistic row that depends on whether it is a sticker send. */
function optimisticRow(content: string, sticker: StickerRef | undefined) {
  const live = sticker === undefined ? null : findSticker(sticker.id);
  return {
    content: sticker === undefined ? content : `[Sticker: ${sticker.name}]`,
    ...(live === null ? {} : { sticker: { id: live.id, name: live.name, url: live.url } }),
  };
}

export interface ThreadSender {
  sendText(
    content: string,
    replyTo: number | null,
    replyPing: boolean,
    files: readonly SentAttachment[],
    existingClientMessageId?: string,
    sticker?: StickerRef,
  ): void;
  /** Send a failed draft again; nothing happens when no draft is held for the row. */
  retryDraft(correlationId: string): void;
  /** Drop a failed draft and its row. */
  discardDraft(correlationId: string): void;
  /** Files a send did not carry go back into the composer. */
  watchUnsentFiles(owner: Disposable): void;
}

export function createThreadSender(options: {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly threadId: number;
  readonly signal: AbortSignal;
  readonly showToast: (msg: string, type: "success" | "error" | "info") => void;
  readonly restoreUnsent: (
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
  ) => void;
}): ThreadSender {
  const { ws, api, threadId, signal, showToast, restoreUnsent } = options;
  const drafts = draftsFor(threadId);

  function sendText(
    content: string,
    replyTo: number | null,
    replyPing: boolean,
    files: readonly SentAttachment[],
    existingClientMessageId?: string,
    sticker?: StickerRef,
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
    const row = optimisticRow(content, sticker);
    const persistId = outboxId(draft);
    const persist =
      persistId === undefined ? undefined : () => persistText(owner, persistId, content);
    if (uiStore.getState().connectionStatus !== "connected") {
      sendOffline(user, draft, row, timestamp, persist);
      return;
    }
    // Saved before the frame goes, so a crash after the server stores it but
    // before the acknowledgement brings back the same logical message.
    const epoch = sessionEpoch;
    enqueueSend(threadId, persist, () => {
      if (epoch !== sessionEpoch || currentUserId() !== user.id) return;
      sendNow(draft, row, timestamp);
    });
  }

  /** Composer gating normally prevents this: keep a failed row with Retry rather than drop it. */
  function sendOffline(
    user: MessageUser,
    draft: SendDraft,
    row: ReturnType<typeof optimisticRow>,
    timestamp: string,
    persist: (() => Promise<boolean>) | undefined,
  ): void {
    const cid = crypto.randomUUID();
    addOptimisticMessage({
      correlationId: cid,
      clientMessageId: draft.clientMessageId,
      channelId: threadId,
      user,
      ...row,
      replyTo: draft.replyTo,
      timestamp,
    });
    drafts.set(cid, draft);
    markSendFailed(cid, "OFFLINE");
    // Never handed to a socket: a failed save means it is gone at restart.
    void persist?.().then((saved) => {
      if (!saved && currentUserId() === user.id) markSendFailed(cid, "OFFLINE_NO_RECOVERY");
    });
  }

  /** Resolves false when the save did not land; the toast says so. */
  function persistText(owner: PendingMessageOwner, id: string, content: string): Promise<boolean> {
    return savePendingText(owner, {
      clientMessageId: id,
      channelId: threadId,
      content,
      createdAt: Number(id.split(":", 1)[0]),
    }).then(
      () => true,
      () => {
        if (!signal.aborted) showToast(messagingText("toast.pendingSaveFailed"), "error");
        return false;
      },
    );
  }

  function sendNow(
    draft: SendDraft,
    row: ReturnType<typeof optimisticRow>,
    timestamp: string,
  ): void {
    const { content, replyTo, replyPing, attachments: files, clientMessageId, sticker } = draft;
    const user = currentUser();
    if (user === null) return;
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
    startSendTimer(threadId, cid, user.id);
  }

  /** The held draft, else the text the encrypted outbox brought back after a restart. */
  function draftFor(correlationId: string): SendDraft | undefined {
    const held = drafts.get(correlationId);
    if (held !== undefined) return held;
    const user = currentUser();
    if (user === null) return undefined;
    const recovered = recoveredPendingText(
      { host: api.getConfig?.().host ?? "", userId: user.id },
      correlationId,
    );
    return recovered === undefined
      ? undefined
      : {
          content: recovered.content,
          replyTo: null,
          replyPing: false,
          clientMessageId: recovered.clientMessageId,
          attachments: [],
        };
  }

  /** Why a keyed retry must not go, as a toast; null when it may. */
  function retryRefusal(clientMessageId: string | undefined): string | null {
    if (clientMessageId === undefined) return null;
    const owner = { host: api.getConfig?.().host ?? "", userId: currentUserId() };
    if (pendingMessageExpired(clientMessageId, Date.now(), pendingMessageRetryFloor(owner))) {
      return messagingText("toast.retryExpired");
    }
    if (!supportsMessageDeduplication(owner)) return messagingText("toast.retryUnsupported");
    return null;
  }

  function retryDraft(correlationId: string): void {
    const draft = draftFor(correlationId);
    if (draft === undefined) return;
    const refusal = retryRefusal(draft.clientMessageId);
    if (refusal !== null) {
      showToast(refusal, "error");
      return;
    }
    // A refused reply may point at a message deleted outside the loaded
    // window: nothing was stored, so it goes again as a plain message.
    const refusedReply =
      draft.replyTo !== null &&
      getChannelMessages(threadId).find((m) => m.correlationId === correlationId)?.errorCode ===
        WsErrorCode.BAD_REQUEST;
    drafts.delete(correlationId);
    clearSendTimer(correlationId);
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

  function discardDraft(correlationId: string): void {
    const id =
      drafts.get(correlationId)?.clientMessageId ??
      getChannelMessages(threadId).find((m) => m.correlationId === correlationId)?.clientMessageId;
    drafts.delete(correlationId);
    clearSendTimer(correlationId);
    removeOptimistic(correlationId);
    // Dismissed on purpose: the outbox must not bring it back at the next start.
    acknowledgePendingMessage(id ?? undefined);
  }

  function watchUnsentFiles(owner: Disposable): void {
    owner.addCleanup(
      ws.on("chat_send_ok", (payload, correlationId) => {
        const draft = correlationId === undefined ? undefined : drafts.get(correlationId);
        if (draft === undefined || correlationId === undefined) return;
        // Delivered: nothing will retry it, so its files are not held on to.
        drafts.delete(correlationId);
        const skipped = new Set(payload.skipped_attachment_ids ?? []);
        const unsent = draft.attachments.filter((a) => skipped.has(a.id));
        if (unsent.length > 0) restoreUnsent(unsent, "skipped");
      }),
    );
    owner.addCleanup(
      ws.on("error", (payload, correlationId) => {
        if (payload.code !== WsErrorCode.ATTACHMENTS_UNAVAILABLE || correlationId === undefined) {
          return;
        }
        const draft = drafts.get(correlationId);
        if (draft === undefined) return;
        // Nothing was stored and the dispatcher drops the row; a Retry with
        // the same ids would fail the same way.
        drafts.delete(correlationId);
        restoreUnsent(draft.attachments, "unavailable");
      }),
    );
  }

  return { sendText, retryDraft, discardDraft, watchUnsentFiles };
}
