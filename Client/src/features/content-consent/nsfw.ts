/**
 * NSFW consent (B9-7): the client half of B5-7's server-enforced label.
 *
 * The authority is the server's per-account acknowledgement row, never local
 * state: `ready` carries it per channel, a 204 from the acknowledgement route
 * confirms a change made here, and `nsfw_ack` reports one made on another
 * device. Until the store holds a confirmed acknowledgement, a labelled
 * channel's content is neither mounted nor requested — a pending, failed or
 * unknown state reads as "gated".
 */

import { channelsStore } from "../../stores/channels.store";
import type { Channel } from "../../stores/channels.store";

/** Error code the server answers a pre-consent content request with (docs/api.md). */
export const NSFW_ACKNOWLEDGEMENT_REQUIRED = "NSFW_ACKNOWLEDGEMENT_REQUIRED";

/** Whether `channel` is labelled and its content not yet consented to. */
export function nsfwConsentRequired(
  channel: Pick<Channel, "nsfw" | "nsfwAcknowledged"> | undefined,
): boolean {
  return channel?.nsfw === true && channel.nsfwAcknowledged !== true;
}

/**
 * Whether a content request for `channelId` must not be sent. A channel this
 * client does not know is left to the server, which refuses it on its own.
 */
export function nsfwContentBlocked(channelId: number): boolean {
  return nsfwConsentRequired(channelsStore.getState().channels.get(channelId));
}
