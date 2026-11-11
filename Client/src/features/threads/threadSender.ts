/**
 * Sending into a thread: the optimistic row, the `chat_send` frame, and the
 * drafts that let a failed send go again. The dispatcher's `chat_send_ok` and
 * error handlers settle the row by its correlation id; this keeps what a
 * retry, or a file the server did not take, needs from the original send.
 */

import { WsErrorCode } from "@lib/protocolTypes";
import {
  newClientMessageId,
  pendingMessageRetryFloor,
  supportsMessageDeduplication,
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
void registerSessionReset("threads:sendDrafts", () => draftsByThread.clear()); // app-lifetime

/** The thread's drafts, without those whose row is gone (settled while the panel was closed). */
function draftsFor(threadId: number): Map<string, SendDraft> {
  let drafts = draftsByThread.get(threadId);
  if (drafts === undefined) {
    drafts = new Map<string, SendDraft>();
    draftsByThread.set(threadId, drafts);
  }
  const live = new Set(getChannelMessages(threadId).map((m) => m.correlationId));
  for (const cid of drafts.keys()) if (!live.has(cid)) drafts.delete(cid);
  return drafts;
}

/** True while a draft is held for the thread. */
export const holdsThreadDrafts = (threadId: number): boolean =>
  (draftsByThread.get(threadId)?.size ?? 0) > 0;

type StickerRef = { readonly id: number; readonly name: string };

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

  function retryDraft(correlationId: string): void {
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

  function discardDraft(correlationId: string): void {
    drafts.delete(correlationId);
    removeOptimistic(correlationId);
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
