// The messaging branches of an `error` frame: refused sends and reactions.
import {
  rollbackReaction,
  markSendFailed,
  removeOptimistic,
  messagesStore,
} from "../../stores/messages.store";
import { dmStore } from "../../stores/dm.store";
import { setUserBlockedByThem } from "../../stores/blocks.store";
import { showToast } from "../../lib/ui/toast";
import { connectText } from "../../i18n/connect";
import { isForwardRequest } from "./forwardRequests";
import { isPollRequest } from "./pollRequests";
import { pendingMessageBeforeRestore } from "../../lib/pendingMessages";
import type { Payload } from "../connection/dispatchContext";
import { WsErrorCode } from "@lib/protocolTypes";

function hasSendRow(correlationId: string): boolean {
  for (const rows of messagesStore.getState().messagesByChannel.values()) {
    if (rows.some((m) => m.correlationId === correlationId)) return true;
  }
  return false;
}

/**
 * A FORBIDDEN on a DM send is the server's generic block refusal
 * (ErrBlocked → FORBIDDEN, bidirectional). Gate the composer with the
 * neutral "being blocked" reason; blocks.store precedence still shows
 * the explicit reason if we are the blocker. Read the channel before
 * markSendFailed clears the pending row.
 */
function gateDmBlockedByThem(id: string): void {
  const chId = messagesStore.getState().pendingSends.get(id);
  const dm =
    chId === undefined ? undefined : dmStore.getState().channels.find((c) => c.channelId === chId);
  // Block gating is a 1:1-only rule (server exempts group DMs from
  // block checks entirely — a group FORBIDDEN means something else,
  // e.g. stale membership). recipient is just participants[0] for a
  // group, so flagging it there would gate an unrelated 1:1 DM.
  if (dm !== undefined && !dm.isGroup) setUserBlockedByThem(dm.recipient.id, true);
}

/** Mark the pending optimistic send `id` failed (with retry) for this error. */
function failPendingSend(payload: Payload<"error">, id: string): void {
  if (payload.code === WsErrorCode.FORBIDDEN) gateDmBlockedByThem(id);
  // A resent pre-restore id the server holds no receipt for is
  // refused as BAD_REQUEST; say the server was restored, keeping the text.
  // The toast lives here, with the connect catalog, to keep MainPage small.
  const { pendingSends, messagesByChannel } = messagesStore.getState();
  const clientMessageId = messagesByChannel
    .get(pendingSends.get(id) ?? 0)
    ?.find((m) => m.correlationId === id)?.clientMessageId;
  const beforeRestore =
    payload.code === WsErrorCode.BAD_REQUEST &&
    clientMessageId !== undefined &&
    pendingMessageBeforeRestore(clientMessageId);
  if (beforeRestore) showToast(connectText("app.sendBeforeRestore"), "error");
  markSendFailed(id, beforeRestore ? "BEFORE_RESTORE" : payload.code);
}

/**
 * The pending-send and pending-reaction branches of `error`. Returns true when
 * the frame answered one of them and the error chain must stop.
 */
export function handleMessagingError(payload: Payload<"error">, id: string | undefined): boolean {
  // A refused Forward is shown on its picker row; no toast on top.
  if (isForwardRequest(id)) return true;
  // A refused poll create, vote or end is shown on its dialog or card.
  if (isPollRequest(id)) return true;
  // 2A-3: a files-only send none of whose files could be attached stored
  // nothing, and a Retry with the same ids fails the same way. Its row goes,
  // even one already failed as unconfirmed; the channel controller puts its
  // files back into the composer.
  if (payload.code === WsErrorCode.ATTACHMENTS_UNAVAILABLE && id !== undefined && hasSendRow(id)) {
    removeOptimistic(id);
    return true;
  }
  // If the error carries the request id of a pending optimistic send, mark
  // that specific row failed (with retry) instead of a global toast. This
  // covers SLOW_MODE, FORBIDDEN, RATE_LIMITED, BAD_REQUEST, etc. on send.
  if (id && messagesStore.getState().pendingSends.has(id)) {
    failPendingSend(payload, id);
    return true;
  }
  // A failed optimistic reaction toggle: the pill reverting is the
  // feedback the spec asks for (ux/messaging §5) — no toast on top.
  if (id !== undefined && rollbackReaction(id)) {
    // 3A-12: the cap is not visible from the pill alone, so say why it reverted.
    if (payload.code === WsErrorCode.REACTION_LIMIT)
      showToast(connectText("app.reactionLimit"), "error");
    return true;
  }
  return false;
}
