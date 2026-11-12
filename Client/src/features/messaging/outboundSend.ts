/** The steps of sending a chat message and of retrying a failed one. */

import type { MessageUser } from "@lib/types";
import {
  getChannelMessages,
  addOptimisticMessage,
  markSendFailed,
  isWindowDetached,
} from "@stores/messages.store";
import { findSticker } from "@stores/stickers.store";
import { stickersText } from "../../i18n/stickers";
import { messagingText } from "../../i18n/messaging";
import {
  newClientMessageId,
  pendingMessageExpired,
  pendingMessageRetryFloor,
  recoveredPendingText,
  supportsMessageDeduplication,
  savePendingText,
} from "@lib/pendingMessages";
import { WsErrorCode } from "@lib/protocolTypes";
import { serverNow } from "@lib/net/serverClock";
import type { SentAttachment } from "./MessageInput";
import type {
  ChannelState,
  ChannelApi,
  MountScope,
} from "../../pages/main-page/channel/channelState";

export interface SendOptions {
  readonly queued?: boolean;
  readonly sticker?: { readonly id: number; readonly name: string };
}

/** What one send needs, settled before anything is shown or sent. */
export interface SendPlan {
  readonly content: string;
  readonly replyTo: number | null;
  readonly replyPing: boolean;
  readonly files: readonly SentAttachment[];
  readonly attachments: string[];
  readonly sticker: SendOptions["sticker"];
  readonly user: MessageUser;
  readonly owns: () => boolean;
  readonly timestamp: string;
  readonly clientMessageId: string | undefined;
  /** Set only for a send with a recoverable logical identity: plain text
   *  with a client_message_id, no reply and no attachments. */
  readonly persistId: string | undefined;
  readonly rowFields: {
    readonly content: string;
    readonly sticker?: { readonly id: number; readonly name: string; readonly url: string };
  };
}

/** The optimistic row's text is the server's fallback for the sticker. */
function stickerRowFields(content: string, sticker: SendOptions["sticker"]): SendPlan["rowFields"] {
  const rowContent = sticker === undefined ? content : `[Sticker: ${sticker.name}]`;
  const live = sticker === undefined ? null : findSticker(sticker.id);
  const rowSticker = live === null ? undefined : { id: live.id, name: live.name, url: live.url };
  return { content: rowContent, ...(rowSticker === undefined ? {} : { sticker: rowSticker }) };
}

/**
 * Settle a send, or null when it must not go: another account's mount, or a
 * sticker send on a server that cannot deduplicate. Sending while viewing a
 * detached history window jumps to present first: the optimistic row belongs
 * in the live tail, and addMessage would refuse to append the echo into a
 * detached window anyway. A queued send that outlived this mount leaves it,
 * since that window is no longer shown.
 */
export function prepareSend(
  st: ChannelState,
  ms: MountScope,
  user: MessageUser | null,
  input: {
    readonly content: string;
    readonly replyTo: number | null;
    readonly files: readonly SentAttachment[];
    readonly existingClientMessageId: string | undefined;
    readonly replyPing: boolean;
    readonly options: SendOptions;
  },
): SendPlan | null {
  const { content, replyTo, files, options } = input;
  const sticker = options.sticker;
  const attachments = files.map((f) => f.id);
  // A queued send was built by this mount but may post after the user left
  // the channel: it needs the account, not the mount.
  const owns = options.queued === true ? ms.ownsAccountSession : ms.ownsSession;
  if (user === null || !owns()) return null;
  if (isWindowDetached(ms.channelId) && !ms.signal.aborted) ms.jumpToPresentForSend();
  const timestamp = new Date().toISOString();
  const clientMessageId =
    input.existingClientMessageId ??
    (supportsMessageDeduplication(ms.owner)
      ? newClientMessageId(pendingMessageRetryFloor(ms.owner))
      : undefined);
  const persistId =
    replyTo === null && attachments.length === 0 && sticker === undefined
      ? clientMessageId
      : undefined;
  // A sticker send commits with its receipt, so the server requires the id.
  if (sticker !== undefined && clientMessageId === undefined) {
    if (owns()) st.showToast(stickersText("send.unsupported"), "error");
    return null;
  }
  return {
    content,
    replyTo,
    replyPing: input.replyPing,
    files,
    attachments,
    sticker,
    user,
    owns,
    timestamp,
    clientMessageId,
    persistId,
    rowFields: stickerRowFields(content, sticker),
  };
}

/**
 * Persist before handing text to the socket, so a process crash after commit
 * but before ACK can recover the same logical identity. Resolves false when
 * the write did not land: callers that send regardless only need the toast,
 * but the offline branch has nothing else carrying the text and must say so
 * on the row.
 */
function persistPendingText(
  st: ChannelState,
  ms: MountScope,
  plan: SendPlan,
  id: string,
): Promise<boolean> {
  return savePendingText(ms.owner, {
    clientMessageId: id,
    channelId: ms.channelId,
    content: plan.content,
    createdAt: Number(id.split(":", 1)[0]),
  }).then(
    () => true,
    () => {
      if (plan.owns()) st.showToast(messagingText("toast.pendingSaveFailed"), "error");
      return false;
    },
  );
}

/** Show the optimistic row for `cid` and remember what was sent for a retry. */
function recordSent(st: ChannelState, ms: MountScope, plan: SendPlan, cid: string): void {
  addOptimisticMessage({
    correlationId: cid,
    clientMessageId: plan.clientMessageId,
    channelId: ms.channelId,
    user: plan.user,
    ...plan.rowFields,
    replyTo: plan.replyTo,
    timestamp: plan.timestamp,
  });
  st.draftByCorrelation.set(cid, {
    content: plan.content,
    ...(plan.sticker === undefined ? {} : { sticker: plan.sticker }),
    replyTo: plan.replyTo,
    ...(plan.replyTo === null ? {} : { replyPing: plan.replyPing }),
    attachments: plan.files,
    channelId: ms.channelId,
    userId: ms.owner.userId,
    clientMessageId: plan.clientMessageId,
    sentAt: Date.now(),
  });
}

/** Composer gating normally prevents this, but stay consistent: show a failed
 *  row with retry rather than silently dropping the message. */
function sendOffline(st: ChannelState, ms: MountScope, plan: SendPlan): void {
  const cid = crypto.randomUUID();
  recordSent(st, ms, plan, cid);
  markSendFailed(cid, "OFFLINE");
  if (plan.persistId !== undefined) {
    // Nothing will deliver this text: it was never handed to a socket, so
    // a failed write means it is gone at restart. Distinguish that from a
    // plain offline row, whose retry window is still open.
    void persistPendingText(st, ms, plan, plan.persistId).then((saved) => {
      if (!saved && plan.owns()) markSendFailed(cid, "OFFLINE_NO_RECOVERY");
    });
  }
}

function sendNow(st: ChannelState, cc: ChannelApi, ms: MountScope, plan: SendPlan): void {
  if (!ms.ownsAccountSession()) return;
  const { sticker, replyTo, clientMessageId } = plan;
  const cid = st.ws.send({
    type: "chat_send",
    payload: {
      channel_id: ms.channelId,
      content: sticker === undefined ? plan.content : "",
      ...(sticker === undefined ? {} : { sticker_id: sticker.id }),
      reply_to: replyTo,
      ...(replyTo === null ? {} : { reply_ping: plan.replyPing }),
      attachments: plan.attachments,
      ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
    },
  });
  recordSent(st, ms, plan, cid);
  // A live socket can lose an ACK without disconnecting. End the spinner
  // honestly; only a server ACK/echo ever calls a message delivered.
  const timer = window.setTimeout(() => {
    cc.clearSendTimer(cid);
    if (
      (ms.session === undefined || ms.session.isCurrent()) &&
      st.getCurrentUserId() === ms.owner.userId &&
      getChannelMessages(ms.channelId).some(
        (m) => m.correlationId === cid && m.status === "pending",
      )
    ) {
      markSendFailed(cid, "UNCONFIRMED");
    }
  }, 20_000);
  st.sendTimers.set(cid, {
    timer,
    release: ms.session?.addCleanup(() => cc.clearSendTimer(cid)),
  });
}

/** Offline, or through the single controller-scoped sendChain. */
export function deliverSend(
  st: ChannelState,
  cc: ChannelApi,
  ms: MountScope,
  plan: SendPlan,
  online: boolean,
): void {
  if (!online) {
    sendOffline(st, ms, plan);
    return;
  }
  const { persistId } = plan;
  // Both branches go through the single controller-scoped
  // sendChain so a synchronous reply/attachment send can never jump a
  // plain-text send whose persistPendingText IPC is still in flight — and
  // vice versa. Without this, only guarding the branch a given finding
  // named would still leave the two branches racing each other. When
  // nothing is already in flight and this send needs no persistence,
  // dispatch stays fully synchronous — unchanged from before, and relied
  // on by every caller (e.g. a same-tick read of ws.send's return value).
  if (persistId === undefined && !st.sendChainBusy) {
    sendNow(st, cc, ms, plan);
    return;
  }
  st.sendChainBusy = true;
  const myGen = ++st.sendChainGen;
  st.sendChain = st.sendChain
    .then(() => (persistId === undefined ? undefined : persistPendingText(st, ms, plan, persistId)))
    .then(() => {
      sendNow(st, cc, ms, plan);
      // Only the still-last-queued entry may clear the flag — a newer
      // send may have queued behind this one while it was persisting.
      if (st.sendChainGen === myGen) st.sendChainBusy = false;
    });
}

/** What a retry resends: the remembered send, else the text recovered from disk. */
export function resolveRetryDraft(st: ChannelState, ms: MountScope, correlationId: string) {
  const recovered = recoveredPendingText(ms.owner, correlationId);
  return (
    st.draftByCorrelation.get(correlationId) ??
    (recovered
      ? {
          ...recovered,
          userId: ms.owner.userId,
          replyTo: null,
          replyPing: false,
          attachments: [] as readonly SentAttachment[],
        }
      : undefined)
  );
}

/** Why a retry must not go, as a toast; null when it may. */
export function retryRefusal(ms: MountScope, clientMessageId: string | undefined): string | null {
  if (!clientMessageId) return null;
  if (pendingMessageExpired(clientMessageId, serverNow(), pendingMessageRetryFloor(ms.owner))) {
    return messagingText("toast.retryExpired");
  }
  if (!supportsMessageDeduplication(ms.owner)) return messagingText("toast.retryUnsupported");
  return null;
}

/** A refused reply may point at a message deleted outside the loaded
 *  window. Nothing was stored, so it goes again as a plain message. */
export function replyWasRefused(
  ms: MountScope,
  correlationId: string,
  replyTo: number | null,
): boolean {
  return (
    replyTo !== null &&
    getChannelMessages(ms.channelId).find((m) => m.correlationId === correlationId)?.errorCode ===
      WsErrorCode.BAD_REQUEST
  );
}
