/**
 * Channel mount step for the message list: delete and its confirm, and every
 * callback the list hands back.
 */
import { createElement } from "@lib/dom";
import { createConfirmModal } from "../../../features/dialogs/confirmModal";
import { createMessageList } from "@components/MessageList";
import { bindGifFavoritesApi } from "@stores/gifFavorites.store";
import { setInlineImageDecorator } from "../../../features/messaging/content/media";
import { WAVE_CONTENT } from "@components/message-list/welcomeRows";
import { gifFavoriteStar } from "@components/message-list/gifFavoriteStar";
import { endPoll, votePoll } from "../../../features/messaging/pollSend";
import {
  messagesStore,
  getChannelMessages,
  setMessagePinned,
  reattachToPresent,
} from "@stores/messages.store";
import { jumpToMessage } from "@lib/nav/messageNavigation";
import { uiStore } from "@stores/ui.store";
import { reportEntryText } from "../../../i18n/reportEntry";
import { messagingText } from "../../../i18n/messaging";
import { markChannelRead } from "@lib/readState";
import { log, renderDeletePreview } from "./channelShared";
import type { ChannelState, ChannelApi, MountScope } from "./channelState";

export function mountMessageList(st: ChannelState, cc: ChannelApi, ms: MountScope): void {
  /** Send the delete frame. A destructive menu action is gated on
   *  the connection; a closed or half-open socket would drop the frame and
   *  leave the moderator thinking the message was deleted. */
  ms.sendDelete = function sendDelete(msgId: number): void {
    if (uiStore.getState().connectionStatus !== "connected") {
      st.showToast(messagingText("toast.deleteFailed"), "error");
      return;
    }
    const id = st.ws.send({
      type: "chat_delete",
      payload: { message_id: msgId },
    });
    cc.track(st.pendingDeletes, id, { channelId: ms.channelId, messageId: msgId });
  };

  /** The destructive delete confirm, on the shared confirm preset
   *  (features/dialogs/confirmModal.ts): Cancel first and focused, Escape and the backdrop
   *  cancel, focus returns to the opener. Tied to the mounted channel's
   *  signal, so a switch or destroy closes it. */
  /** `onConfirm` runs just before the delete is sent. */
  ms.openDeleteConfirm = function openDeleteConfirm(
    msgId: number,
    flow: { readonly onConfirm?: () => void; readonly clicked: boolean },
  ): void {
    const body: Node[] = [
      createElement("p", { class: "modal-danger-text" }, messagingText("delete.body")),
    ];
    const target = getChannelMessages(ms.channelId).find((m) => m.id === msgId);
    if (target !== undefined) body.push(renderDeletePreview(target));
    // The tip is about the Delete click, so it is left out when no click
    // opened this (an emptied edit).
    if (flow.clicked) {
      body.push(
        createElement(
          "p",
          { class: "msg-delete-tip", "data-testid": "msg-delete-tip" },
          messagingText("delete.shiftTip"),
        ),
      );
    }
    createConfirmModal({
      title: messagingText("delete.title"),
      titleId: `msg-delete-title-${msgId}`,
      body,
      confirmLabel: messagingText("delete.confirm"),
      testId: "msg-delete-modal",
      confirmTestId: "msg-delete-confirm",
      cancelTestId: "msg-delete-cancel",
      signal: ms.signal,
      onConfirm: () => {
        flow.onConfirm?.();
        ms.sendDelete(msgId);
      },
    });
  };

  // Bound before any message renders so GIFs in messages get their star.
  bindGifFavoritesApi(st.api);

  setInlineImageDecorator(gifFavoriteStar);

  // MessageList
  st.messageList = createMessageList({
    channelId: ms.channelId,
    channelName: ms.channelName,
    channelType: ms.channelType,
    currentUserId: ms.userId,
    ...(st.opts.onJoinCall !== undefined && { onJoinCall: st.opts.onJoinCall }),
    ...(st.opts.onOpenPins !== undefined && { onOpenPins: st.opts.onOpenPins }),
    onScrollTop: () => {
      if (st.channelAbort !== null) {
        return st.msgCtrl.loadOlderMessages(ms.channelId, st.channelAbort.signal);
      }
      return undefined;
    },
    onScrollBottom: () => {
      if (st.channelAbort !== null) {
        return st.msgCtrl.loadNewerMessages(ms.channelId, st.channelAbort.signal);
      }
      return undefined;
    },
    onRetryLoad: () => {
      if (st.channelAbort !== null) {
        void st.msgCtrl.loadMessages(ms.channelId, st.channelAbort.signal);
      }
    },
    // A reply bar (and any other in-row jump) goes through the same jumper
    // as search hits and permalinks, so an out-of-window target fetches its
    // around-window instead of silently doing nothing.
    onJumpToMessage: (msgId: number) => {
      jumpToMessage(ms.channelId, msgId);
    },
    onJumpToPresent: () => {
      // Dropping the detached flag also clears "loaded", so loadMessages
      // refetches the live tail instead of short-circuiting.
      reattachToPresent(ms.channelId);
      // See performSend's identical call above — a detached
      // active channel's badge (from dispatcher.ts's evenIfActive path)
      // must be cleared here too, or it lingers after the user has jumped
      // back to present and is looking straight at the live tail.
      markChannelRead(ms.channelId);
      if (st.channelAbort !== null) {
        void st.msgCtrl.loadMessages(ms.channelId, st.channelAbort.signal);
      }
    },
    // The Wave button of a welcome row: an ordinary 👋 message sent as
    // a reply to the join row through the normal send path.
    onWave: (msgId: number): boolean => {
      const target = ms.liveReplyTo(msgId);
      if (target === null) return false;
      ms.performSend(WAVE_CONTENT, target, []);
      return true;
    },
    onReplyClick: (msgId: number) => {
      const msgs = getChannelMessages(ms.channelId);
      const msg = msgs.find((m) => m.id === msgId);
      if (msg === undefined) st.messageInput?.setReplyTo(msgId, "");
      else {
        const { messageId, username, ...replyOpts } = cc.replyTargetOf(msg);
        st.messageInput?.setReplyTo(messageId, username, replyOpts);
      }
    },
    onEditClick: (msgId: number) => {
      st.messageList?.startEdit(msgId);
    },
    onEditSave: (messageId: number, content: string): boolean => {
      const msgs = getChannelMessages(ms.channelId);
      const original = msgs.find((m) => m.id === messageId);
      if (original !== undefined && original.content === content) {
        return true;
      }
      // Same connection gate as delete. A dropped edit frame must
      // not look saved — the row would keep its old text, and the user
      // would never know to try again. The editor stays open with the text.
      if (uiStore.getState().connectionStatus !== "connected") {
        st.showToast(messagingText("toast.editFailed"), "error");
        return false;
      }
      const id = st.ws.send({
        type: "chat_edit",
        payload: { message_id: messageId, content },
      });
      cc.track(st.pendingEdits, id, { channelId: ms.channelId, messageId, content });
      return true;
    },
    // Discord's flow: clearing an edit and pressing Save asks to delete the
    // message. Cancel leaves the editor open; Delete closes it first.
    onEmptyEdit: (messageId: number) => {
      ms.openDeleteConfirm(messageId, {
        onConfirm: () => {
          st.messageList?.cancelEdit();
          // The modal handed focus back to the editor that is now gone.
          st.messageInput?.focus();
        },
        clicked: false,
      });
    },
    onEditEnd: () => st.messageInput?.focus(),
    onDeleteClick: (msgId: number, shiftKey: boolean) => {
      // Shift-click skips the prompt, as Discord's delete confirm does.
      // A plain click opens a confirm.
      if (!shiftKey) {
        ms.openDeleteConfirm(msgId, { clicked: true });
        return;
      }
      ms.sendDelete(msgId);
    },
    onReactionClick: (msgId: number, emoji: string) => {
      st.reactionCtrl.handleReaction(msgId, emoji);
    },
    onPinClick: (msgId: number, chId: number, currentlyPinned: boolean) => {
      // One request per message at a time: a second click while one is
      // pending would race its revert against the first.
      const flightKey = `${chId}:${msgId}`;
      if (st.pinsInFlight.has(flightKey)) return;
      st.pinsInFlight.add(flightKey);
      // Optimistic: the row flips now and snaps back if the server refuses,
      // so the control answers the click instead of waiting on the round trip.
      setMessagePinned(chId, msgId, !currentlyPinned);
      const revisionAfterFlip = messagesStore.getState().messagePinRevision?.get(msgId);
      const action = currentlyPinned
        ? st.api.unpinMessage(chId, msgId)
        : st.api.pinMessage(chId, msgId);
      action
        .then(() => {
          st.showToast(
            currentlyPinned ? messagingText("toast.unpinned") : messagingText("toast.pinned"),
            "success",
          );
        })
        .catch((err) => {
          // A moved revision means a chat_pinned for this message already
          // holds the truth; do not overwrite it.
          if (messagesStore.getState().messagePinRevision?.get(msgId) === revisionAfterFlip) {
            setMessagePinned(chId, msgId, currentlyPinned);
          }
          log.error("Pin/unpin failed", { error: String(err) });
          st.showToast(messagingText("toast.pinFailed"), "error");
        })
        .finally(() => {
          st.pinsInFlight.delete(flightKey);
        });
    },
    onReportClick: (msgId: number) => {
      const msg = getChannelMessages(ms.channelId).find((m) => m.id === msgId);
      if (msg === undefined) return;
      import("../../../features/reports/openers").then(
        ({ openMessageReport }) => {
          if (ms.signal.aborted) return;
          // The dialog's closing restores focus to the Report button; the
          // composer is the fallback when a re-render has replaced the row.
          openMessageReport({
            api: st.api,
            msg,
            signal: ms.signal,
            fallbackFocus: () => st.slots.inputSlot.querySelector<HTMLElement>("textarea"),
          });
        },
        () => st.showToast(reportEntryText("reportLoadFailed"), "error"),
      );
    },
    onForwardClick: (msgId: number) => {
      import("../../../components/ForwardPicker").then(
        ({ openForwardPicker }) => {
          if (ms.signal.aborted) return;
          // Focus goes back to the composer: the menu that opened it is gone.
          openForwardPicker({
            ws: st.ws,
            channelId: ms.channelId,
            messageId: msgId,
            signal: ms.signal,
            fallbackFocus: () => st.slots.inputSlot.querySelector<HTMLElement>("textarea"),
          });
        },
        () => st.showToast(messagingText("forward.loadFailed"), "error"),
      );
    },
    // Voting and ending are plain requests on this channel's socket; the counts
    // come back as poll_update through the dispatcher.
    onPollVote: (messageId, answerIds) => votePoll(st.ws, messageId, answerIds, ms.signal),
    onPollEnd: (messageId) => endPoll(st.ws, messageId, ms.signal),
    ...(st.threadHost !== null && {
      onCreateThreadClick: (msgId: number) => {
        import("../../../components/CreateThreadDialog").then(
          ({ openCreateThreadDialog }) => {
            if (ms.signal.aborted) return;
            openCreateThreadDialog({
              ws: st.ws,
              channelId: ms.channelId,
              messageId: msgId,
              signal: ms.signal,
              onCreated: (thread) => st.threadHost!.openById(thread.id, ms.channelId, ms.signal),
              onExists: (threadId) => st.threadHost!.openById(threadId, ms.channelId, ms.signal),
              fallbackFocus: () => st.slots.inputSlot.querySelector<HTMLElement>("textarea"),
            });
          },
          () => st.showToast(messagingText("thread.panelLoadFailed"), "error"),
        );
      },
      onOpenThread: (threadId: number) => {
        st.threadHost!.openById(threadId, ms.channelId, ms.signal);
      },
    }),
    onRetry: (correlationId: string) => ms.retrySend(correlationId),
    onDeleteDraft: (correlationId: string) => ms.deleteDraft(correlationId),
    renderUploadStrip: (correlationId, stripSignal) => {
      const entry = st.queuedSends.get(correlationId);
      return entry === undefined || st.sendQueueMod === null
        ? null
        : st.sendQueueMod.renderUploadStrip(entry, stripSignal);
    },
  });

  st.messageList.mount(st.slots.messagesSlot);

  if (ms.storedChannel?.nsfw === true) ms.mountConsentBar();
}
