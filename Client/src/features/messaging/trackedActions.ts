/**
 * The delete, edit and pin actions of a message list, shared by the channel
 * view and the thread panel so both report a failure the same way: an edit or
 * delete frame is tracked until the server's echo (or a transport failure)
 * resolves it, and a pin toggle is guarded against a second click and a stale
 * revert.
 */
import { createLogger } from "@lib/logger";
import type { ApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import { messagesStore, setMessagePinned } from "@stores/messages.store";
import { uiStore } from "@stores/ui.store";
import { messagingText } from "../../i18n/messaging";
import type { MessageInputComponent } from "./MessageInput";
import type { MessageListComponent } from "./MessageList";

const log = createLogger("tracked-actions");

/** Longer than ws.ts's 60 s server-silence deadline, so a half-open socket is
 *  declared dead (and the entry failed) before the entry can expire. */
const TRACKED_ACTION_EXPIRY_MS = 90_000;

export interface TrackedEdit {
  readonly channelId: number;
  readonly messageId: number;
  readonly content: string;
}

export interface TrackedDelete {
  readonly channelId: number;
  readonly messageId: number;
}

/** The maps a view keeps its in-flight frames in. */
export interface TrackedStore {
  readonly pendingEdits: Map<string, TrackedEdit>;
  readonly pendingDeletes: Map<string, TrackedDelete>;
  readonly trackTimers: Map<string, number>;
}

export function createTrackedStore(): TrackedStore {
  return { pendingEdits: new Map(), pendingDeletes: new Map(), trackTimers: new Map() };
}

type ToastFn = (msg: string, type: "success" | "error" | "info") => void;

export function trackEntry<T>(
  store: TrackedStore,
  pending: Map<string, T>,
  id: string,
  entry: T,
): void {
  pending.set(id, entry);
  store.trackTimers.set(
    id,
    window.setTimeout(() => untrackEntry(store, pending, id), TRACKED_ACTION_EXPIRY_MS),
  );
}

/** Remove a tracked entry and its expiry timer; returns the entry, if any. */
export function untrackEntry<T>(
  store: TrackedStore,
  pending: Map<string, T>,
  id: string,
): T | undefined {
  const entry = pending.get(id);
  pending.delete(id);
  window.clearTimeout(store.trackTimers.get(id));
  store.trackTimers.delete(id);
  return entry;
}

/** Send the delete frame and track it. A destructive action is gated on the
 *  connection: a closed or half-open socket would drop the frame and leave the
 *  user thinking the message was deleted. */
export function sendTrackedDelete(
  store: TrackedStore,
  ws: WsClient,
  showToast: ToastFn,
  channelId: number,
  messageId: number,
): void {
  if (uiStore.getState().connectionStatus !== "connected") {
    showToast(messagingText("toast.deleteFailed"), "error");
    return;
  }
  const id = ws.send({ type: "chat_delete", payload: { message_id: messageId } });
  trackEntry(store, store.pendingDeletes, id, { channelId, messageId });
}

/** Send the edit frame and track it. Returns false (editor stays open with
 *  its text) when the connection is down. */
export function sendTrackedEdit(
  store: TrackedStore,
  ws: WsClient,
  showToast: ToastFn,
  channelId: number,
  messageId: number,
  content: string,
): boolean {
  if (uiStore.getState().connectionStatus !== "connected") {
    showToast(messagingText("toast.editFailed"), "error");
    return false;
  }
  const id = ws.send({ type: "chat_edit", payload: { message_id: messageId, content } });
  trackEntry(store, store.pendingEdits, id, { channelId, messageId, content });
  return true;
}

export interface EditRestoreView {
  /** The channel (or thread) the view currently shows. */
  currentChannelId(): number | null;
  messageList(): MessageListComponent | null;
  messageInput(): MessageInputComponent | null;
  showToast: ToastFn;
}

/** A failure can land long after the save: if the user has moved on to the
 *  composer or another text field, the restored editor must not take focus. */
export function userIsBusyElsewhere(input: MessageInputComponent | null): boolean {
  if (input !== null && !input.isIdle()) return true;
  const active = document.activeElement;
  // The idle composer is where a just-saved edit hands focus back.
  if (active instanceof HTMLElement && active.classList.contains("msg-textarea")) return false;
  return (
    active instanceof HTMLElement &&
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active.isContentEditable)
  );
}

/** Put a failed edit's text back in its row's inline editor, but only while
 *  its own channel is the mounted one and no other edit is open. At most one
 *  edit lands, the newest; the error toast (when asked for) says the text is
 *  back only if it is. */
export function restoreFailedEdits(
  view: EditRestoreView,
  edits: readonly TrackedEdit[],
  toast: boolean,
): void {
  queueMicrotask(() => {
    const newest = edits.findLast((edit) => edit.channelId === view.currentChannelId());
    const list = view.messageList();
    let restored = false;
    if (
      newest !== undefined &&
      list !== null &&
      !list.isEditing() &&
      list.startEdit(newest.messageId, newest.content, {
        focus: !userIsBusyElsewhere(view.messageInput()),
      })
    ) {
      restored = true;
    }
    if (toast) {
      view.showToast(
        messagingText(restored ? "toast.editFailedRestored" : "toast.editFailed"),
        "error",
      );
    }
  });
}

/** Resolve a tracked edit or delete whose request was refused. A refused edit
 *  restores the text but leaves the one error to the dispatcher's own chain. */
export function settleTrackedError(
  store: TrackedStore,
  restore: (edits: readonly TrackedEdit[], toast: boolean) => void,
  correlationId: string,
): void {
  const edit = untrackEntry(store, store.pendingEdits, correlationId);
  if (edit !== undefined) restore([edit], false);
  untrackEntry(store, store.pendingDeletes, correlationId);
}

/** Subscribe the failure paths of tracked frames; returns the unsubscribers.
 *  The server's edit/delete echoes carry no envelope id, so a tracked frame
 *  is resolved by its channel + message. A local transport failure never
 *  echoes, so it reports one error and puts a failed edit's text back. Leaving
 *  "connected" means an in-flight frame can never be echoed. */
export function bindTrackedFailures(
  store: TrackedStore,
  ws: WsClient,
  showToast: ToastFn,
  restore: (edits: readonly TrackedEdit[], toast: boolean) => void,
): Array<() => void> {
  return [
    ws.on("chat_edited", (payload) => {
      for (const [id, edit] of store.pendingEdits) {
        if (edit.channelId === payload.channel_id && edit.messageId === payload.message_id) {
          untrackEntry(store, store.pendingEdits, id);
        }
      }
    }),
    ws.on("chat_deleted", (payload) => {
      for (const [id, del] of store.pendingDeletes) {
        if (del.channelId === payload.channel_id && del.messageId === payload.message_id) {
          untrackEntry(store, store.pendingDeletes, id);
        }
      }
    }),
    ws.onSendFailure((id) => {
      const edit = untrackEntry(store, store.pendingEdits, id);
      if (edit !== undefined) {
        restore([edit], true);
        return;
      }
      if (untrackEntry(store, store.pendingDeletes, id) !== undefined) {
        showToast(messagingText("toast.deleteFailed"), "error");
      }
    }),
    ws.onStateChange((state) => {
      if (state === "connected") return;
      if (store.pendingEdits.size > 0) restore([...store.pendingEdits.values()], true);
      store.pendingEdits.clear();
      const hadDelete = store.pendingDeletes.size > 0;
      store.pendingDeletes.clear();
      for (const timer of store.trackTimers.values()) window.clearTimeout(timer);
      store.trackTimers.clear();
      if (hadDelete) showToast(messagingText("toast.deleteFailed"), "error");
    }),
  ];
}

/** Pin or unpin a message: optimistic, one request per message at a time, and
 *  the revert only lands when no newer pin event arrived meanwhile. */
export function togglePin(
  inFlight: Set<string>,
  api: Pick<ApiClient, "pinMessage" | "unpinMessage">,
  showToast: ToastFn,
  messageId: number,
  channelId: number,
  currentlyPinned: boolean,
): void {
  const flightKey = `${channelId}:${messageId}`;
  if (inFlight.has(flightKey)) return;
  inFlight.add(flightKey);
  // Optimistic: the row flips now and snaps back if the server refuses.
  setMessagePinned(channelId, messageId, !currentlyPinned);
  const revisionAfterFlip = messagesStore.getState().messagePinRevision?.get(messageId);
  const action = currentlyPinned
    ? api.unpinMessage(channelId, messageId)
    : api.pinMessage(channelId, messageId);
  action
    .then(() => {
      showToast(
        currentlyPinned ? messagingText("toast.unpinned") : messagingText("toast.pinned"),
        "success",
      );
    })
    .catch((err: unknown) => {
      // A moved revision means a chat_pinned for this message already holds
      // the truth; do not overwrite it.
      if (messagesStore.getState().messagePinRevision?.get(messageId) === revisionAfterFlip) {
        setMessagePinned(channelId, messageId, currentlyPinned);
      }
      log.error("Pin/unpin failed", { error: String(err) });
      showToast(messagingText("toast.pinFailed"), "error");
    })
    .finally(() => {
      inFlight.delete(flightKey);
    });
}
