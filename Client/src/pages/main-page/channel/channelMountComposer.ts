/**
 * Channel mount steps for the composer: the typing indicator, the message input
 * and its draft, then slow mode and the rules that disable or gate it.
 */
import { isServerRowKind } from "@lib/text/messageKind";
import { ApiClientError } from "@lib/api";
import {
  createMessageInput,
  type QueuedAttachment,
  type SentAttachment,
} from "@components/MessageInput";
import { createTypingIndicator } from "@components/TypingIndicator";
import { getChannelMessages } from "@stores/messages.store";
import { canManageMessages } from "@lib/permissions";
import { blocksStore, dmComposerBlockReason } from "@stores/blocks.store";
import { membersStore } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { safetyStore } from "../../../features/safety/store";
import { messagingText } from "../../../i18n/messaging";
import { shellText } from "../../../i18n/shell";
import { formatUntil, safetyText } from "../../../i18n/safety";
import { WsErrorCode } from "@lib/protocolTypes";
import { log } from "./channelShared";
import type { ChannelState, ChannelApi, MountScope } from "./channelState";

export function mountComposer(st: ChannelState, cc: ChannelApi, ms: MountScope): void {
  // TypingIndicator
  st.typingIndicator = createTypingIndicator({
    channelId: ms.channelId,
    currentUserId: ms.userId,
  });

  st.typingIndicator.mount(st.slots.typingSlot);

  // MessageInput
  st.messageInput = createMessageInput({
    channelId: ms.channelId,
    channelName: ms.channelName,
    gifApi: st.api,
    onSend: (
      content: string,
      replyTo: number | null,
      _attachments: readonly string[],
      files: readonly SentAttachment[],
      replyPing: boolean,
      queued?: readonly QueuedAttachment[],
    ) => {
      const reply = ms.liveReplyTo(replyTo);
      const ping = reply !== null && replyPing === true;
      if (queued === undefined) ms.performSend(content, reply, files, undefined, ping);
      else ms.enqueueSend(content, reply, ping, queued);
    },
    onSendSticker: (sticker, replyTo, replyPing) => {
      const reply = ms.liveReplyTo(replyTo);
      ms.performSend("", reply, [], undefined, reply !== null && replyPing, { sticker });
    },
    onUploadFile: ms.uploadFile,
    onDiscardUpload: async (id: string) => {
      try {
        await st.api.discardUpload(id);
      } catch (err) {
        // The server sweeps an unsent upload on its own; this only frees
        // the quota sooner, so a failure is logged and not shown. A 404 is
        // a copy already gone (withdrawn before, or an older server).
        if (!(err instanceof ApiClientError && err.status === 404)) {
          log.warn("Discarding an unsent upload failed", { error: String(err) });
        }
        throw err;
      }
    },
    onTyping: () => {
      if (st.typingLimiter.tryConsume(String(ms.channelId))) {
        st.ws.send({
          type: "typing_start",
          payload: { channel_id: ms.channelId },
        });
      }
    },
    onDraftChange: cc.scheduleDraftSave,
    onCreatePoll: () => {
      import("../../../components/PollComposer").then(
        ({ openPollComposer }) => {
          if (ms.signal.aborted) return;
          openPollComposer({
            ws: st.ws,
            channelId: ms.channelId,
            signal: ms.signal,
            fallbackFocus: () => st.slots.inputSlot.querySelector<HTMLElement>("textarea"),
          });
        },
        () => st.showToast(messagingText("poll.loadFailed"), "error"),
      );
    },
  });

  st.messageInput.mount(st.slots.inputSlot);

  // Restore this channel's stashed draft, if any — its text, reply
  // target and staged upload ids — so a switch away and back is lossless.
  // A reply whose target is gone (deleted while away) is dropped, not
  // restored onto a message the server would refuse the reply to.
  ms.stashedDraft = st.draftByChannel.get(ms.channelId);

  if (ms.stashedDraft !== undefined) {
    const replyTo =
      ms.stashedDraft.replyTo !== null &&
      !getChannelMessages(ms.channelId).some(
        (m) => m.id === ms.stashedDraft!.replyTo!.messageId && !m.deleted,
      )
        ? null
        : ms.stashedDraft.replyTo;
    st.messageInput.restoreDraft({ ...ms.stashedDraft, replyTo });
    st.draftByChannel.delete(ms.channelId);
  } else {
    cc.restoreSavedDraft(ms.channelId, st.messageInput);
  }

  // A dropped reply must not come back from storage on the next start.
  cc.scheduleDraftSave();
}

export function mountComposerGating(st: ChannelState, cc: ChannelApi, ms: MountScope): void {
  // Composer gating: express permission + connection as affordance. The
  // composer disables (with a reason) when the socket is down or the user
  // may not post here, instead of accepting a click and failing. For DM
  // channels the reason also covers block state (channels-members-dms.md §3.2).
  // Slow mode as affordance: after an accepted send the composer disables
  // itself for the channel's cooldown with a live countdown, instead of
  // taking a message the server will bounce with SLOW_MODE (UX spec §5,
  // "do not drop the drafted message" — the draft stays in the textarea).
  ms.slowModeTicker = null;

  ms.stopSlowModeTicker = (): void => {
    if (ms.slowModeTicker !== null) {
      clearInterval(ms.slowModeTicker);
      ms.slowModeTicker = null;
    }
  };

  ms.slowModeRemaining = (): number => {
    const entry = st.slowModeSentAtByChannel.get(ms.channelId);
    if (entry === undefined) return 0;
    const seconds = channelsStore.getState().channels.get(ms.channelId)?.slowMode ?? 0;
    entry.window = Math.max(entry.window, seconds);
    return Math.max(0, Math.ceil((entry.sentAt + seconds * 1000 - Date.now()) / 1000));
  };

  ms.computeComposerReason = (): string | null => {
    const status = uiStore.getState().connectionStatus;
    if (status === "reconnecting") return shellText("channel.reconnecting");
    if (status === "disconnected") return shellText("channel.notConnected");
    const timeout = safetyStore.getState().timeout;
    if (timeout !== null)
      return safetyText("timeout.composer", { time: formatUntil(timeout.expiresAt) });
    if (ms.dmRecipientId !== null) {
      const blockReason = dmComposerBlockReason(blocksStore.getState(), ms.dmRecipientId);
      if (blockReason !== null) return blockReason;
    }
    const ch = channelsStore.getState().channels.get(ms.channelId);
    if (ch === undefined) return null;
    if (!ch.canSend) {
      return ch.type === "announcement"
        ? messagingText("composer.announcementOnly")
        : messagingText("composer.noPermission");
    }
    return null;
  };

  // The standing slow-mode note: shown from the first moment, for anyone
  // slow mode would limit. Not a send gate, so the first send still goes.
  ms.refreshSlowModeNote = (): void => {
    const seconds = channelsStore.getState().channels.get(ms.channelId)?.slowMode ?? 0;
    st.messageInput?.setSlowModeNote(
      seconds > 0 && !canManageMessages()
        ? messagingText("composer.slowModeNote", { seconds: String(seconds) })
        : null,
    );
  };

  ms.refreshComposerState = (): void => {
    ms.refreshSlowModeNote();
    st.messageInput?.setDisabled(ms.computeComposerReason());
    // Slow mode gates the SEND only: the draft stays editable so the user
    // can keep typing through the cooldown (Discord parity, F12).
    const remaining = ms.slowModeRemaining();
    st.messageInput?.setSendGate(
      remaining > 0 ? messagingText("composer.slowMode", { seconds: String(remaining) }) : null,
    );
  };

  /**
   * Begin (or restart) the slow-mode cooldown for this channel. Moderators
   * bypass slow mode server-side, so they never get gated here either.
   */
  ms.armSlowModeTicker = (): void => {
    ms.refreshComposerState();
    ms.stopSlowModeTicker();
    ms.slowModeTicker = setInterval(() => {
      // Keep ticking past a zero gate until the largest observed window is
      // over, so a setting raised again meanwhile re-gates the composer.
      ms.refreshComposerState();
      if (cc.slowModeWindowOver(ms.channelId)) ms.stopSlowModeTicker();
    }, 1000);
  };

  ms.startSlowMode = (seconds: number): void => {
    if (seconds <= 0 || canManageMessages()) return;
    cc.recordSlowModeSend(ms.channelId, seconds);
    ms.armSlowModeTicker();
  };

  st.composerGatingUnsubs.push(ms.stopSlowModeTicker);

  // Both chat_send_ok and the SLOW_MODE error are global ws.on
  // subscriptions carrying no channel_id of their own — only the
  // correlation id ties a frame back to the send that produced it. A send
  // made in a channel the user has since left can still be in flight when
  // its ack/refusal arrives, and by then this listener belongs to whatever
  // channel is newly mounted. Absent/empty correlation ids never
  // happen over the real transport, so fall back to attributing to the
  // mounted channel rather than silently dropping every ack.
  ms.sentToMountedChannel = (correlationId: string | undefined): boolean =>
    correlationId === undefined ||
    correlationId === "" ||
    st.draftByCorrelation.get(correlationId)?.channelId === ms.channelId;

  // The server accepted a message — the next one is subject to the cooldown.
  st.composerGatingUnsubs.push(
    st.ws.on("chat_send_ok", (payload, correlationId) => {
      if (!ms.ownsSession()) return;
      const sameChannel = ms.sentToMountedChannel(correlationId);
      const sentDraft =
        correlationId === undefined ? undefined : st.draftByCorrelation.get(correlationId);
      const sentTo = sentDraft?.channelId;
      // An accepted send can never be retried, so its draft is dead weight.
      // The map is controller-scoped (a failed row outlives a channel
      // switch, so its draft must too), which means nothing else would ever
      // drop it — every message sent in the session would be retained.
      if (correlationId !== undefined && correlationId !== "") {
        st.draftByCorrelation.delete(correlationId);
        cc.clearSendTimer(correlationId);
      }
      if (payload.client_message_id) {
        for (const [id, draft] of st.draftByCorrelation) {
          if (draft.clientMessageId === payload.client_message_id) {
            st.draftByCorrelation.delete(id);
            cc.clearSendTimer(id);
          }
        }
      }
      const ch = channelsStore.getState().channels.get(ms.channelId);
      if (
        ch !== undefined &&
        ch.id === channelsStore.getState().activeChannelId &&
        sameChannel &&
        !payload.deduplicated
      ) {
        ms.startSlowMode(ch.slowMode);
      } else if (sentTo !== undefined && !sameChannel && !payload.deduplicated) {
        // A late ack for a channel the user has left: charge that channel's
        // cooldown now, without arming this mounted channel's ticker.
        const seconds = channelsStore.getState().channels.get(sentTo)?.slowMode ?? 0;
        if (seconds > 0 && !canManageMessages()) {
          cc.recordSlowModeSend(sentTo, seconds, sentDraft?.sentAt);
        }
      }
    }),
  );

  st.composerGatingUnsubs.push(
    st.ws.on("chat_message", (payload) => {
      if (!ms.ownsSession() || payload.user.id !== ms.owner.userId || !payload.client_message_id)
        return;
      // The live echo proves delivery even when its preceding ACK was lost.
      // Dispatcher owns store reconciliation; this listener only releases
      // private retry payloads and timers owned by this controller.
      for (const [id, draft] of st.draftByCorrelation) {
        if (
          draft.clientMessageId === payload.client_message_id &&
          draft.channelId === payload.channel_id
        ) {
          st.draftByCorrelation.delete(id);
          cc.clearSendTimer(id);
        }
      }
    }),
  );

  // The server's edit/delete echoes carry no envelope id, so a
  // tracked frame is resolved by its channel + message (the same
  // content-match reactions use). Only the server echo proves delivery.
  st.composerGatingUnsubs.push(
    st.ws.on("chat_edited", (payload) => {
      for (const [id, edit] of st.pendingEdits) {
        if (edit.channelId === payload.channel_id && edit.messageId === payload.message_id) {
          cc.untrack(st.pendingEdits, id);
        }
      }
    }),
  );

  st.composerGatingUnsubs.push(
    st.ws.on("chat_deleted", (payload) => {
      for (const [id, del] of st.pendingDeletes) {
        if (del.channelId === payload.channel_id && del.messageId === payload.message_id) {
          cc.untrack(st.pendingDeletes, id);
        }
      }
    }),
  );

  // A local transport failure never echoes, so the frame is gone: report
  // one error (the dispatcher's generic handler ignores an id that matches
  // no pending send/reaction) and put a failed edit's text back. A half-open
  // socket does not reject the send (the frame buffers), so the reconnect
  // transition below is what catches that case.
  st.composerGatingUnsubs.push(
    st.ws.onSendFailure((id) => {
      const edit = cc.untrack(st.pendingEdits, id);
      if (edit !== undefined) {
        cc.failEdits([edit], true);
        return;
      }
      if (cc.untrack(st.pendingDeletes, id) !== undefined) {
        st.showToast(messagingText("toast.deleteFailed"), "error");
      }
    }),
  );

  // Leaving "connected" means an in-flight frame can never be echoed: the
  // dispatcher only sweeps optimistic sends/reactions, so resolve the
  // tracked edit/delete frames here too — one error, and an edit's text
  // back — instead of leaving a false success and a leaked entry.
  st.composerGatingUnsubs.push(
    st.ws.onStateChange((state) => {
      if (state === "connected") return;
      if (st.pendingEdits.size > 0) cc.failEdits([...st.pendingEdits.values()], true);
      st.pendingEdits.clear();
      const hadDelete = st.pendingDeletes.size > 0;
      st.pendingDeletes.clear();
      for (const timer of st.trackTimers.values()) window.clearTimeout(timer);
      st.trackTimers.clear();
      if (hadDelete) st.showToast(messagingText("toast.deleteFailed"), "error");
    }),
  );

  // A refused send restarts the full window: the server's limiter is the
  // authority on when the next one is allowed. A refused edit restores the
  // text but leaves the one error to the dispatcher's own chain.
  st.composerGatingUnsubs.push(
    st.ws.on("error", (payload, correlationId) => {
      if (correlationId !== undefined) {
        const edit = cc.untrack(st.pendingEdits, correlationId);
        if (edit !== undefined) cc.failEdits([edit], false);
        cc.untrack(st.pendingDeletes, correlationId);
      }
      if (payload.code !== WsErrorCode.SLOW_MODE) return;
      if (!ms.sentToMountedChannel(correlationId)) return;
      const ch = channelsStore.getState().channels.get(ms.channelId);
      if (ch !== undefined) ms.startSlowMode(ch.slowMode);
    }),
  );

  ms.refreshComposerState();

  // Returning to a channel still inside its cooldown: re-arm the countdown.
  if (canManageMessages()) st.slowModeSentAtByChannel.delete(ms.channelId);
  else if (!cc.slowModeWindowOver(ms.channelId) || ms.slowModeRemaining() > 0)
    ms.armSlowModeTicker();
  else if (!cc.slowModeRetained(ms.channelId)) st.slowModeSentAtByChannel.delete(ms.channelId);

  st.composerGatingUnsubs.push(
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      () => ms.refreshComposerState(),
    ),
  );

  st.composerGatingUnsubs.push(
    channelsStore.subscribeSelector(
      (s) => s.channels.get(ms.channelId)?.canSend ?? true,
      () => ms.refreshComposerState(),
    ),
  );

  // A channel_update/create that changes the interval refreshes the note.
  st.composerGatingUnsubs.push(
    channelsStore.subscribeSelector(
      (s) => s.channels.get(ms.channelId)?.slowMode ?? 0,
      () => ms.refreshComposerState(),
    ),
  );

  st.composerGatingUnsubs.push(
    safetyStore.subscribeSelector(
      (s) => s.timeout,
      () => ms.refreshComposerState(),
    ),
  );

  // A role change can make the user exempt from slow mode, or no longer so.
  st.composerGatingUnsubs.push(
    membersStore.subscribeSelector(
      (s) => s.roleRevision ?? 0,
      () => ms.refreshComposerState(),
    ),
  );

  if (ms.dmRecipientId !== null) {
    // Un-gate live when the block clears (unblock) and gate on a refused send.
    st.composerGatingUnsubs.push(
      blocksStore.subscribeSelector(
        (s) => dmComposerBlockReason(s, ms.dmRecipientId!),
        () => ms.refreshComposerState(),
      ),
    );
  }

  // Arrow-up edit: listen for edit-last-message bubbling from MessageInput
  st.slots.inputSlot.addEventListener(
    "edit-last-message",
    () => {
      const msgs = getChannelMessages(ms.channelId);
      const myId = st.getCurrentUserId();
      // Find the last message sent by the current user (array is chronological)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        // Mirrors renderers.ts's gate on the visual Edit affordance: an
        // optimistic row (pending/failed) carries id 0 until the server
        // acks it, so editing it would send chat_edit for a message that
        // does not exist yet.
        // A server-written row (a DM call log) is never editable, nor is a
        // sticker message: it has no text and the server refuses it.
        if (
          m.user.id === myId &&
          !m.deleted &&
          m.status === "sent" &&
          !isServerRowKind(m.kind) &&
          m.sticker === undefined
        ) {
          st.messageList?.startEdit(m.id);
          break;
        }
      }
    },
    { signal: ms.signal },
  );
}
