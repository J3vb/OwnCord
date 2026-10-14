import type { VoiceState } from "../../stores/voice.store";
import { channelsStore } from "../../stores/channels.store";
import { voiceText } from "../../i18n/voice";

/** Why the share button is off, or null: the grant leaves out screen share,
 *  or the channel's video limit is used up (cameras and shares both count,
 *  as on the server). Never while you share, so Stop sharing always works. */
export function shareBlockReason(voice: VoiceState): string | null {
  const channelId = voice.currentChannelId;
  if (channelId === null || voice.localScreenshare) return null;
  if (voice.shareDenied === true) return voiceText("widget.control.shareDenied");
  const max = channelsStore.getState().channels.get(channelId)?.voiceMaxVideo ?? 0;
  if (max <= 0) return null;
  let used = 0;
  for (const u of voice.voiceUsers.get(channelId)?.values() ?? []) {
    used += Number(u.camera) + Number(u.screenshare);
  }
  return used >= max ? voiceText("widget.control.shareVideoLimit") : null;
}
