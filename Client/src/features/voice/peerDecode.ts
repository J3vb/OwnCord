/**
 * The video decode lists of the other users in our voice channel, for
 * `resolveVideoCodec`. Reads the voice store; kept apart from `videoCodec.ts`
 * so that module (imported by the settings UI) stays free of store imports.
 */

import { authStore } from "../../stores/auth.store";
import { voiceStore } from "../../stores/voice.store";
import type { PeerDecodeLists } from "./decodeCaps";

/** One entry per other user in `currentChannelId`; `undefined` is a user whose
 *  announce has not arrived (counted as the baseline by `pickCommonCodec`). */
export function channelPeerDecode(): PeerDecodeLists {
  const { currentChannelId, voiceUsers, peerVideoDecode } = voiceStore.getState();
  if (currentChannelId === null) return [];
  const selfId = authStore.getState().user?.id;
  const out: Array<readonly string[] | undefined> = [];
  for (const userId of voiceUsers.get(currentChannelId)?.keys() ?? []) {
    if (userId !== selfId) out.push(peerVideoDecode?.get(userId));
  }
  return out;
}
