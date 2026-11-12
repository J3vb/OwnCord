/** What the mounted channel does when the server accepts a send. */

import { canManageMessages } from "@lib/permissions";
import type { ChatSendOkPayload } from "@lib/wireServer";
import { channelsStore } from "@stores/channels.store";
import type {
  ChannelState,
  ChannelApi,
  MountScope,
} from "../../pages/main-page/channel/channelState";

/**
 * An accepted send can never be retried, so its draft is dead weight. The map
 * is controller-scoped (a failed row outlives a channel switch, so its draft
 * must too), which means nothing else would ever drop it — every message sent
 * in the session would be retained.
 */
function dropAcknowledgedDrafts(
  st: ChannelState,
  cc: ChannelApi,
  payload: ChatSendOkPayload,
  correlationId: string | undefined,
): void {
  if (correlationId !== undefined && correlationId !== "") {
    st.draftByCorrelation.delete(correlationId);
    cc.clearSendTimer(correlationId);
  }
  if (!payload.client_message_id) return;
  for (const [id, draft] of st.draftByCorrelation) {
    if (draft.clientMessageId === payload.client_message_id) {
      st.draftByCorrelation.delete(id);
      cc.clearSendTimer(id);
    }
  }
}

/** The server accepted a message — the next one is subject to the cooldown. */
export function onSendAcknowledged(
  st: ChannelState,
  cc: ChannelApi,
  ms: MountScope,
  payload: ChatSendOkPayload,
  correlationId: string | undefined,
): void {
  if (!ms.ownsSession()) return;
  const sameChannel = ms.sentToMountedChannel(correlationId);
  const sentDraft =
    correlationId === undefined ? undefined : st.draftByCorrelation.get(correlationId);
  const sentTo = sentDraft?.channelId;
  dropAcknowledgedDrafts(st, cc, payload, correlationId);
  if (payload.deduplicated) return;
  if (sameChannel) startMountedCooldown(ms);
  else if (sentTo !== undefined) chargeLeftChannel(cc, sentTo, sentDraft?.sentAt);
}

function startMountedCooldown(ms: MountScope): void {
  const ch = channelsStore.getState().channels.get(ms.channelId);
  if (ch !== undefined && ch.id === channelsStore.getState().activeChannelId) {
    ms.startSlowMode(ch.slowMode);
  }
}

/** A late ack for a channel the user has left: charge that channel's cooldown
 *  now, without arming the mounted channel's ticker. */
function chargeLeftChannel(cc: ChannelApi, sentTo: number, sentAt: number | undefined): void {
  const seconds = channelsStore.getState().channels.get(sentTo)?.slowMode ?? 0;
  if (seconds > 0 && !canManageMessages()) cc.recordSlowModeSend(sentTo, seconds, sentAt);
}
