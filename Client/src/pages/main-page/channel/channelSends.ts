/**
 * Bookkeeping for sends, edits and deletes in flight: slow-mode windows,
 * tracked frames, send timers and reply targets.
 */
import type { ReplyTarget } from "../../../features/messaging/MessageInput";
import type { ImportedAuthor } from "@lib/types";
import { importedName } from "../../../features/messaging/importedAuthor";
import {
  restoreFailedEdits,
  trackEntry,
  untrackEntry,
  userIsBusyElsewhere as busyElsewhere,
  type TrackedEdit,
} from "../../../features/messaging/trackedActions";
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

  const store = {
    pendingEdits: st.pendingEdits,
    pendingDeletes: st.pendingDeletes,
    trackTimers: st.trackTimers,
  };

  const track = <T>(pending: Map<string, T>, id: string, entry: T): void =>
    trackEntry(store, pending, id, entry);

  const untrack = <T>(pending: Map<string, T>, id: string): T | undefined =>
    untrackEntry(store, pending, id);

  const view = {
    currentChannelId: () => st.currentChannelId,
    messageList: () => st.messageList,
    messageInput: () => st.messageInput,
    showToast: st.showToast,
  };

  const userIsBusyElsewhere = (): boolean => busyElsewhere(st.messageInput);

  const failEdits = (edits: readonly TrackedEdit[], toast: boolean): void =>
    restoreFailedEdits(view, edits, toast);

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
