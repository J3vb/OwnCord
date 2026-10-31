/**
 * Channel mount steps for sending: the NSFW consent UI, the send queue, the
 * send itself, retry and discard.
 */
import type { MountableComponent } from "@lib/text/safeRender";
import type { VoiceUploadMeta } from "@lib/types";
import type { QueuedAttachment, SentAttachment } from "@components/MessageInput";
import { loadSendQueue, preloadSendQueue } from "../../../features/messaging/sendQueueLoader";
import type { QueuedSend, QueueDeps } from "../../../features/messaging/sendQueue";
import {
  getChannelMessages,
  addOptimisticMessage,
  markSendFailed,
  removeOptimistic,
  reattachToPresent,
  isWindowDetached,
} from "@stores/messages.store";
import { canManageMessages } from "@lib/permissions";
import { findSticker } from "@stores/stickers.store";
import { stickersText } from "../../../i18n/stickers";
import { channelsStore, setNsfwAcknowledged } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { messagingText } from "../../../i18n/messaging";
import { markChannelRead, markChannelReadSeen } from "@lib/readState";
import { readPointerEnabled } from "@lib/net/serverCapabilities";
import {
  newClientMessageId,
  pendingMessageExpired,
  pendingMessageRetryFloor,
  recoveredPendingText,
  supportsMessageDeduplication,
  savePendingText,
  acknowledgePendingMessage,
} from "@lib/pendingMessages";
import { WsErrorCode } from "@lib/protocolTypes";
import { log, currentMessageUser, abortQueued } from "./channelShared";
import type { ChannelState, ChannelApi, MountScope } from "./channelState";

export function mountSendPipeline(st: ChannelState, cc: ChannelApi, ms: MountScope): void {
  /**
   * Mount the gate or the withdraw bar. Their module (with its catalog) is
   * loaded on first use so only a labelled channel pays for it (B9 shared
   * MainPage budget); the gated path mounts no content while it loads.
   */
  ms.mountConsentUi = function mountConsentUi(
    build: (ui: typeof import("@components/NsfwGate")) => MountableComponent,
  ): void {
    const gen = ++st.nsfwConsentUiGen;
    import("@components/NsfwGate").then(
      (ui) => {
        if (ms.signal.aborted || gen !== st.nsfwConsentUiGen) return;
        st.nsfwConsentUi = build(ui);
        st.nsfwConsentUi.mount(st.slots.messagesSlot);
      },
      (err: unknown) =>
        log.error("NSFW consent UI failed to load", {
          channelId: ms.channelId,
          error: String(err),
        }),
    );
  };

  ms.mountConsentBar = function mountConsentBar(): void {
    ms.mountConsentUi((ui) =>
      ui.createNsfwConsentBar({
        onRevoke: () =>
          st.api.revokeNsfw(ms.channelId).then(
            () => {
              if (ms.ownsAccountSession()) setNsfwAcknowledged(ms.channelId, false);
            },
            (err: unknown) => {
              log.error("NSFW consent revoke failed", {
                channelId: ms.channelId,
                error: String(err),
              });
              if (ms.ownsSession()) st.showToast(ui.nsfwConsentText("bar.revokeFailed"), "error");
            },
          ),
      }),
    );
  };

  /** Mirrors onJumpToPresent — reattach clears "loaded" so the tail is refetched. */
  ms.jumpToPresentForSend = function jumpToPresentForSend(): void {
    reattachToPresent(ms.channelId);
    // While detached, this (already-active) channel could have
    // picked up an unread/mention badge for messages that arrived below
    // the gap (dispatcher.ts's evenIfActive path) — nothing else clears
    // it, since incrementUnread's usual "active channel" skip is exactly
    // what a detached window opts out of. Jumping to present is reading
    // it, so mark it read the same way leaving a channel does. With a read
    // pointer that is what was seen, not everything.
    if (readPointerEnabled()) markChannelReadSeen(ms.channelId);
    else markChannelRead(ms.channelId);
    void st.msgCtrl.loadMessages(ms.channelId, ms.signal);
  };

  /** A reply whose target was deleted while composing sends as a plain message. */
  ms.liveReplyTo = function liveReplyTo(replyTo: number | null): number | null {
    const target =
      replyTo === null ? undefined : getChannelMessages(ms.channelId).find((m) => m.id === replyTo);
    return target?.deleted === true ? null : replyTo;
  };

  // 3A-9: the queue's hooks into this mount. Built here, so a send queued in
  // this channel posts, fails and puts files back for this channel even after
  // the user has switched away.
  ms.queueDeps = function queueDeps(entry: QueuedSend): QueueDeps {
    const live = (): boolean => st.queuedSends.get(entry.cid) === entry && ms.ownsAccountSession();
    return {
      upload: ms.uploadFile,
      putBack: (files) => {
        if (live()) cc.putBackUnsent(entry.channelId, files, "skipped");
      },
      // The server refuses a send inside the channel's slow-mode window, so wait it out.
      // Like the composer gate: the channel's current slow_mode, none for moderators.
      slowWindow: () => {
        const sent = st.slowModeSentAtByChannel.get(entry.channelId);
        if (sent === undefined || canManageMessages()) return undefined;
        const window = channelsStore.getState().channels.get(entry.channelId)?.slowMode ?? 0;
        return { sentAt: sent.sentAt, window };
      },
      fail: (code) => {
        if (live()) markSendFailed(entry.cid, code);
      },
      dispatch: (files) => {
        if (st.queuedSends.get(entry.cid) !== entry) return;
        st.queuedSends.delete(entry.cid);
        // Remove and add run in this one task, so no frame shows the gap.
        removeOptimistic(entry.cid);
        // Everything went back to the composer and there is no text: nothing to post.
        if (files.length === 0 && entry.content === "") return;
        const reply = ms.liveReplyTo(entry.replyTo);
        ms.performSend(entry.content, reply, files, undefined, reply !== null && entry.replyPing, {
          queued: true,
        });
      },
    };
  };

  /** Show `entry` as an "uploading" row and run it; on Retry it replaces the
   *  failed row under a new id. The entry stays under its old id until the
   *  module has loaded, so a Delete in that window still finds it. Waits for
   *  the lazy module, which the first upload preloaded. A failed entry whose
   *  row vanishes without Delete stays in `queuedSends`, holding its Files,
   *  until teardown. */
  ms.startQueued = function startQueued(entry: QueuedSend, retry: boolean): void {
    // A failed load is already logged by the loader's preload.
    void loadSendQueue()
      .catch(() => null)
      .then((mod) => {
        if (st.queuedSends.get(entry.cid) !== entry) return;
        const user = currentMessageUser();
        if (user === null || !ms.ownsAccountSession()) {
          // Another account's send: nothing may post or keep uploading.
          abortQueued(entry);
          st.queuedSends.delete(entry.cid);
          return;
        }
        if (retry) {
          // A second Retry click in the window finds it no longer failed.
          if (entry.failed !== true) return;
          st.queuedSends.delete(entry.cid);
          removeOptimistic(entry.cid);
          entry.cid = crypto.randomUUID();
          st.queuedSends.set(entry.cid, entry);
        }
        // The strip reads this when the row first renders: Cancel only while it runs.
        entry.failed = false;
        if (isWindowDetached(ms.channelId) && !ms.signal.aborted) ms.jumpToPresentForSend();
        // Set first, so a render during the add can draw the strip.
        if (mod !== null) st.sendQueueMod = mod;
        addOptimisticMessage({
          correlationId: entry.cid,
          channelId: ms.channelId,
          user,
          content: entry.content,
          replyTo: entry.replyTo,
          timestamp: new Date().toISOString(),
          status: "uploading",
        });
        if (mod === null) {
          // The uploads keep going; the text is on the row, and Retry loads again.
          entry.failed = true;
          markSendFailed(entry.cid, "UPLOAD_FAILED");
          return;
        }
        void (retry ? mod.retryQueuedSend : mod.runQueuedSend)(entry, ms.queueDeps(entry));
      });
  };

  ms.enqueueSend = function enqueueSend(
    content: string,
    replyTo: number | null,
    replyPing: boolean,
    queued: readonly QueuedAttachment[],
  ): void {
    const entry: QueuedSend = {
      cid: crypto.randomUUID(),
      channelId: ms.channelId,
      userId: ms.owner.userId,
      content,
      replyTo,
      replyPing,
      items: queued.map((q) => ({ ...q })),
    };
    st.queuedSends.set(entry.cid, entry);
    ms.startQueued(entry, false);
  };

  /** The file upload, shared by the composer and a queued send's re-uploads. */
  ms.uploadFile = async (
    file: File,
    uploadSignal?: AbortSignal,
    onProgress?: (fraction: number) => void,
    voice?: VoiceUploadMeta,
  ): Promise<{ id: string; url: string; filename: string }> => {
    // The first upload loads the queue module, so a send queued while it runs finds it ready.
    preloadSendQueue();
    try {
      const result = await st.api.uploadFile(file, uploadSignal, onProgress, voice);
      return { id: result.id, url: result.url, filename: result.filename };
    } catch (err) {
      // A user-cancelled upload is not a failure — the composer already
      // removed its preview and does not want an error for it. A real
      // failure is reported once, inline, by the composer from this
      // rejection, so it is not toasted here too.
      if (!uploadSignal?.aborted) log.error("File upload failed", { error: String(err) });
      throw err;
    }
  };

  ms.performSend = function performSend(
    content: string,
    replyTo: number | null,
    files: readonly SentAttachment[],
    existingClientMessageId?: string,
    replyPing = false,
    sendOptions: {
      readonly queued?: boolean;
      readonly sticker?: { readonly id: number; readonly name: string };
    } = {},
  ): void {
    const sticker = sendOptions.sticker;
    const attachments = files.map((f) => f.id);
    const user = currentMessageUser();
    // A queued send (3A-9) was built by this mount but may post after the
    // user left the channel: it needs the account, not the mount.
    const owns = sendOptions.queued === true ? ms.ownsAccountSession : ms.ownsSession;
    if (user === null || !owns()) return;
    // Sending while viewing a detached history window jumps to present: the
    // optimistic row belongs in the live tail, and addMessage would refuse
    // to append the echo into a detached window anyway. A queued send that
    // outlived this mount leaves it, since that window is no longer shown.
    if (isWindowDetached(ms.channelId) && !ms.signal.aborted) ms.jumpToPresentForSend();
    const timestamp = new Date().toISOString();
    const clientMessageId =
      existingClientMessageId ??
      (supportsMessageDeduplication(ms.owner)
        ? newClientMessageId(pendingMessageRetryFloor(ms.owner))
        : undefined);
    // Set only for a send with a recoverable logical identity: plain text
    // with a client_message_id, no reply and no attachments.
    const persistId =
      replyTo === null && attachments.length === 0 && sticker === undefined
        ? clientMessageId
        : undefined;
    // A sticker send commits with its receipt, so the server requires the id.
    if (sticker !== undefined && clientMessageId === undefined) {
      if (owns()) st.showToast(stickersText("send.unsupported"), "error");
      return;
    }
    // The optimistic row's text is the server's fallback for the sticker.
    const rowContent = sticker === undefined ? content : `[Sticker: ${sticker.name}]`;
    const live = sticker === undefined ? null : findSticker(sticker.id);
    const rowSticker = live === null ? undefined : { id: live.id, name: live.name, url: live.url };
    const rowFields = {
      content: rowContent,
      ...(rowSticker === undefined ? {} : { sticker: rowSticker }),
    };
    const draftSticker = sticker === undefined ? {} : { sticker };
    /** Persist before handing text to the socket, so a process crash after
     *  commit but before ACK can recover the same logical identity. Resolves
     *  false when the write did not land: callers that send regardless only
     *  need the toast, but the offline branch has nothing else carrying the
     *  text and must say so on the row. */
    function persistPendingText(id: string): Promise<boolean> {
      return savePendingText(ms.owner, {
        clientMessageId: id,
        channelId: ms.channelId,
        content,
        createdAt: Number(id.split(":", 1)[0]),
      }).then(
        () => true,
        () => {
          if (owns()) st.showToast(messagingText("toast.pendingSaveFailed"), "error");
          return false;
        },
      );
    }
    if (uiStore.getState().connectionStatus !== "connected") {
      // Composer gating normally prevents this, but stay consistent: show a
      // failed row with retry rather than silently dropping the message.
      const cid = crypto.randomUUID();
      addOptimisticMessage({
        correlationId: cid,
        clientMessageId,
        channelId: ms.channelId,
        user,
        ...rowFields,
        replyTo,
        timestamp,
      });
      st.draftByCorrelation.set(cid, {
        content,
        ...draftSticker,
        replyTo,
        ...(replyTo === null ? {} : { replyPing }),
        attachments: files,
        channelId: ms.channelId,
        userId: ms.owner.userId,
        clientMessageId,
        sentAt: Date.now(),
      });
      markSendFailed(cid, "OFFLINE");
      if (persistId !== undefined) {
        // Nothing will deliver this text: it was never handed to a socket, so
        // a failed write means it is gone at restart. Distinguish that from a
        // plain offline row, whose retry window is still open.
        void persistPendingText(persistId).then((saved) => {
          if (!saved && owns()) markSendFailed(cid, "OFFLINE_NO_RECOVERY");
        });
      }
      return;
    }
    const sendNow = (): void => {
      if (!ms.ownsAccountSession()) return;
      const cid = st.ws.send({
        type: "chat_send",
        payload: {
          channel_id: ms.channelId,
          content: sticker === undefined ? content : "",
          ...(sticker === undefined ? {} : { sticker_id: sticker.id }),
          reply_to: replyTo,
          ...(replyTo === null ? {} : { reply_ping: replyPing }),
          attachments,
          ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
        },
      });
      addOptimisticMessage({
        correlationId: cid,
        clientMessageId,
        channelId: ms.channelId,
        user,
        ...rowFields,
        replyTo,
        timestamp,
      });
      st.draftByCorrelation.set(cid, {
        content,
        ...draftSticker,
        replyTo,
        ...(replyTo === null ? {} : { replyPing }),
        attachments: files,
        channelId: ms.channelId,
        userId: ms.owner.userId,
        clientMessageId,
        sentAt: Date.now(),
      });
      // A live socket can lose an ACK without disconnecting. End the spinner
      // honestly; only a server ACK/echo ever calls a message delivered.
      const timer = window.setTimeout(() => {
        cc.clearSendTimer(cid);
        if (
          (ms.session === undefined || ms.session.isCurrent()) &&
          st.getCurrentUserId() === ms.owner.userId
        ) {
          markSendFailed(cid, "UNCONFIRMED");
        }
      }, 20_000);
      st.sendTimers.set(cid, {
        timer,
        release: ms.session?.addCleanup(() => cc.clearSendTimer(cid)),
      });
    };
    // Both branches go through the single controller-scoped
    // sendChain so a synchronous reply/attachment send can never jump a
    // plain-text send whose persistPendingText IPC is still in flight — and
    // vice versa. Without this, only guarding the branch a given finding
    // named would still leave the two branches racing each other. When
    // nothing is already in flight and this send needs no persistence,
    // dispatch stays fully synchronous — unchanged from before, and relied
    // on by every caller (e.g. a same-tick read of ws.send's return value).
    if (persistId === undefined && !st.sendChainBusy) {
      sendNow();
      return;
    }
    st.sendChainBusy = true;
    const myGen = ++st.sendChainGen;
    st.sendChain = st.sendChain
      .then(() => (persistId === undefined ? undefined : persistPendingText(persistId)))
      .then(() => {
        sendNow();
        // Only the still-last-queued entry may clear the flag — a newer
        // send may have queued behind this one while it was persisting.
        if (st.sendChainGen === myGen) st.sendChainBusy = false;
      });
  };

  ms.retrySend = function retrySend(correlationId: string): void {
    if (!ms.ownsSession()) return;
    const queued = st.queuedSends.get(correlationId);
    if (queued !== undefined) {
      // 3A-9: a failed queued send uploads what it lacks and posts again, as
      // a new row under a new id.
      if (queued.channelId !== ms.channelId) return;
      ms.startQueued(queued, true);
      return;
    }
    const recovered = recoveredPendingText(ms.owner, correlationId);
    const draft =
      st.draftByCorrelation.get(correlationId) ??
      (recovered
        ? {
            ...recovered,
            userId: ms.owner.userId,
            replyTo: null,
            replyPing: false,
            attachments: [] as readonly SentAttachment[],
          }
        : undefined);
    if (draft === undefined || draft.channelId !== ms.channelId) return;
    if (
      draft.clientMessageId &&
      pendingMessageExpired(draft.clientMessageId, Date.now(), pendingMessageRetryFloor(ms.owner))
    ) {
      st.showToast(messagingText("toast.retryExpired"), "error");
      return;
    }
    if (draft.clientMessageId && !supportsMessageDeduplication(ms.owner)) {
      st.showToast(messagingText("toast.retryUnsupported"), "error");
      return;
    }
    // A refused reply may point at a message deleted outside the loaded
    // window. Nothing was stored, so it goes again as a plain message under
    // a fresh id.
    const refusedReply =
      draft.replyTo !== null &&
      getChannelMessages(ms.channelId).find((m) => m.correlationId === correlationId)?.errorCode ===
        WsErrorCode.BAD_REQUEST;
    st.draftByCorrelation.delete(correlationId);
    cc.clearSendTimer(correlationId);
    removeOptimistic(correlationId);
    const retrySticker = "sticker" in draft ? draft.sticker : undefined;
    const stickerOpts = retrySticker === undefined ? {} : { sticker: retrySticker };
    if (refusedReply) {
      ms.performSend(draft.content, null, draft.attachments, undefined, false, stickerOpts);
      return;
    }
    ms.performSend(
      draft.content,
      draft.replyTo,
      draft.attachments,
      draft.clientMessageId,
      draft.replyPing === true,
      stickerOpts,
    );
  };

  /** Withdraw a stored upload that will never be sent; the server sweeps it anyway if this fails. */
  ms.discardQuietly = function discardQuietly(id: string): void {
    void st.api.discardUpload(id).catch(() => {});
  };

  ms.deleteDraft = function deleteDraft(correlationId: string): void {
    if (!ms.ownsSession()) return;
    const queued = st.queuedSends.get(correlationId);
    if (queued !== undefined) {
      // 3A-9: stop its uploads and withdraw the ones already stored.
      abortQueued(queued);
      for (const item of queued.items) {
        if (item.id !== undefined) ms.discardQuietly(item.id);
      }
      st.queuedSends.delete(correlationId);
      removeOptimistic(correlationId);
      return;
    }
    const id =
      st.draftByCorrelation.get(correlationId)?.clientMessageId ??
      recoveredPendingText(ms.owner, correlationId)?.clientMessageId;
    acknowledgePendingMessage(id);
    st.draftByCorrelation.delete(correlationId);
    cc.clearSendTimer(correlationId);
    removeOptimistic(correlationId);
  };
}
