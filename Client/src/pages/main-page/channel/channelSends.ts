/**
 * Bookkeeping for sends, edits and deletes in flight: slow-mode windows,
 * tracked frames, send timers and reply targets.
 */
import type { ReplyTarget } from "@components/MessageInput";
import type { ImportedAuthor } from "@lib/types";
import { importedName } from "../../../features/messaging/importedAuthor";
import { messagingText } from "../../../i18n/messaging";
import { TRACKED_ACTION_EXPIRY_MS, type TrackedEdit } from "./channelShared";
import type { ChannelState, ChannelApi } from "./channelState";

export function createChannelSends(st: ChannelState, _cc: ChannelApi) {
  const recordSlowModeSend = (id: number, seconds: number, sentAt = Date.now()): void => {
    st.slowModeSentAtByChannel.set(id, { sentAt, window: seconds });
  };

  const slowModeRetained = (id: number): boolean => {
    const entry = st.slowModeSentAtByChannel.get(id);
    return (
      entry !== undefined &&
      Date.now() < entry.sentAt + Math.max(entry.window * 1000, st.SLOW_MODE_RETENTION_MS)
    );
  };

  const slowModeWindowOver = (id: number): boolean => {
    const entry = st.slowModeSentAtByChannel.get(id);
    return entry === undefined || Date.now() >= entry.sentAt + entry.window * 1000;
  };

  function track<T>(pending: Map<string, T>, id: string, entry: T): void {
    pending.set(id, entry);
    st.trackTimers.set(
      id,
      window.setTimeout(() => untrack(pending, id), TRACKED_ACTION_EXPIRY_MS),
    );
  }

  /** Remove a tracked entry and its expiry timer; returns the entry, if any. */
  function untrack<T>(pending: Map<string, T>, id: string): T | undefined {
    const entry = pending.get(id);
    pending.delete(id);
    window.clearTimeout(st.trackTimers.get(id));
    st.trackTimers.delete(id);
    return entry;
  }

  /** A failure can land long after the save: if the user has moved on to the
   *  composer or another text field, the restored editor must not take focus. */
  function userIsBusyElsewhere(): boolean {
    if (st.messageInput !== null && !st.messageInput.isIdle()) return true;
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
   *  its own channel is the mounted one and no other edit is open — the row it
   *  belongs to may be gone by now (startEdit refuses a message that is not
   *  loaded, not yours or not sent), and a list for another channel would
   *  target the wrong message id. At most one edit lands, the newest; the error
   *  toast (when asked for) says the text is back only if it is. */
  function failEdits(edits: readonly TrackedEdit[], toast: boolean): void {
    queueMicrotask(() => {
      const newest = edits.findLast((edit) => edit.channelId === st.currentChannelId);
      let restored = false;
      if (
        newest !== undefined &&
        st.messageList !== null &&
        !st.messageList.isEditing() &&
        st.messageList.startEdit(newest.messageId, newest.content, {
          focus: !userIsBusyElsewhere(),
        })
      ) {
        restored = true;
      }
      if (toast) {
        st.showToast(
          messagingText(restored ? "toast.editFailedRestored" : "toast.editFailed"),
          "error",
        );
      }
    });
  }

  function clearSendTimer(id: string): void {
    const owned = st.sendTimers.get(id);
    if (!owned) return;
    st.sendTimers.delete(id);
    window.clearTimeout(owned.timer);
    owned.release?.();
  }

  /** 3A-12: the reply bar shows the display name, and no @ON/@OFF on your own message. */
  function replyTargetOf(msg: {
    readonly id: number;
    readonly user: {
      readonly id: number;
      readonly username: string;
      readonly display_name?: string | null;
    };
    readonly importedAuthor?: ImportedAuthor;
  }): ReplyTarget {
    return {
      messageId: msg.id,
      username:
        msg.importedAuthor !== undefined
          ? importedName(msg.importedAuthor)
          : msg.user.display_name || msg.user.username,
      // An imported author has no one to ping, so the toggle is hidden as for your own message.
      self: msg.importedAuthor !== undefined || msg.user.id === st.getCurrentUserId(),
    };
  }

  return {
    recordSlowModeSend,
    slowModeRetained,
    slowModeWindowOver,
    track,
    untrack,
    userIsBusyElsewhere,
    failEdits,
    clearSendTimer,
    replyTargetOf,
  };
}
