/**
 * Send while uploading in a thread panel. A thread message sent with files
 * still uploading becomes a queued send, run by the channel's send queue
 * module: it shows as an "uploading" row with the upload strip and posts once
 * every file has landed. One per panel; its entries die with the panel.
 */

import type { MessageUser } from "@lib/types";
import type { QueuedAttachment, SentAttachment } from "../../components/MessageInput";
import { addOptimisticMessage, markSendFailed, removeOptimistic } from "@stores/messages.store";
import { loadSendQueue, type SendQueueModule } from "../messaging/sendQueueLoader";
import type { QueuedSend, QueueDeps } from "../messaging/sendQueue";

export interface ThreadSendQueueOptions {
  readonly threadId: number;
  /** Ends with the panel: nothing queued may post or keep uploading after it. */
  readonly signal: AbortSignal;
  readonly currentUser: () => MessageUser | null;
  readonly upload: QueueDeps["upload"];
  /** Withdraw a stored upload that will never be sent. */
  readonly discard: (id: string) => void;
  /** Files that can no longer be sent go back to the thread's composer. */
  readonly putBack: (files: readonly SentAttachment[]) => void;
  /** Every file landed: post the message with these, in chip order. */
  readonly dispatch: (
    content: string,
    replyTo: number | null,
    replyPing: boolean,
    files: readonly SentAttachment[],
  ) => void;
}

export interface ThreadSendQueue {
  enqueue(
    content: string,
    replyTo: number | null,
    replyPing: boolean,
    queued: readonly QueuedAttachment[],
  ): void;
  /** Retry a failed queued row; false when `cid` is not one. */
  retry(cid: string): boolean;
  /** Drop a queued row, its uploads and its stored files; false when `cid` is not one. */
  remove(cid: string): boolean;
  renderUploadStrip(cid: string, signal: AbortSignal): HTMLElement | null;
}

function stop(entry: QueuedSend): void {
  entry.cancelled = true;
  for (const item of entry.items) item.upload?.owner.destroy();
}

export function createThreadSendQueue(options: ThreadSendQueueOptions): ThreadSendQueue {
  const { threadId, signal } = options;
  const entries = new Map<string, QueuedSend>();
  let mod: SendQueueModule | null = null;

  signal.addEventListener(
    "abort",
    () => {
      // A closed panel drops its unsent messages, so no row is left
      // uploading with nothing behind it.
      for (const entry of entries.values()) {
        stop(entry);
        removeOptimistic(entry.cid);
      }
      entries.clear();
    },
    { once: true },
  );

  function deps(entry: QueuedSend): QueueDeps {
    const live = (): boolean => !signal.aborted && entries.get(entry.cid) === entry;
    return {
      upload: options.upload,
      putBack: (files) => {
        if (live()) options.putBack(files);
      },
      slowWindow: () => undefined,
      fail: (code) => {
        if (live()) markSendFailed(entry.cid, code);
      },
      dispatch: (files) => {
        if (!live()) return;
        entries.delete(entry.cid);
        removeOptimistic(entry.cid);
        if (files.length === 0 && entry.content === "") return;
        options.dispatch(entry.content, entry.replyTo, entry.replyPing, files);
      },
    };
  }

  function start(entry: QueuedSend, retry: boolean): void {
    void loadSendQueue()
      .catch(() => null)
      .then((loaded) => {
        if (signal.aborted || entries.get(entry.cid) !== entry) return;
        const user = options.currentUser();
        if (user === null || user.id !== entry.userId) {
          stop(entry);
          entries.delete(entry.cid);
          return;
        }
        if (retry) {
          if (entry.failed !== true) return;
          entries.delete(entry.cid);
          removeOptimistic(entry.cid);
          entry.cid = crypto.randomUUID();
          entries.set(entry.cid, entry);
        }
        entry.failed = false;
        if (loaded !== null) mod = loaded;
        addOptimisticMessage({
          correlationId: entry.cid,
          channelId: threadId,
          user,
          content: entry.content,
          replyTo: entry.replyTo,
          timestamp: new Date().toISOString(),
          status: "uploading",
        });
        if (loaded === null) {
          entry.failed = true;
          markSendFailed(entry.cid, "UPLOAD_FAILED");
          return;
        }
        void (retry ? loaded.retryQueuedSend : loaded.runQueuedSend)(entry, deps(entry));
      });
  }

  return {
    enqueue(content, replyTo, replyPing, queued) {
      const user = options.currentUser();
      if (user === null || signal.aborted) {
        for (const q of queued) q.upload?.owner.destroy();
        return;
      }
      const entry: QueuedSend = {
        cid: crypto.randomUUID(),
        channelId: threadId,
        userId: user.id,
        content,
        replyTo,
        replyPing,
        items: queued.map((q) => ({ ...q })),
      };
      entries.set(entry.cid, entry);
      start(entry, false);
    },
    retry(cid) {
      const entry = entries.get(cid);
      if (entry === undefined) return false;
      start(entry, true);
      return true;
    },
    remove(cid) {
      const entry = entries.get(cid);
      if (entry === undefined) return false;
      stop(entry);
      for (const item of entry.items) {
        if (item.id !== undefined) options.discard(item.id);
      }
      entries.delete(cid);
      removeOptimistic(cid);
      return true;
    },
    renderUploadStrip(cid, stripSignal) {
      const entry = entries.get(cid);
      return entry === undefined || mod === null ? null : mod.renderUploadStrip(entry, stripSignal);
    },
  };
}
