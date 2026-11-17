/** Whether your screen share is live: asked for and published. The share is
 *  asked for while its picker is still open, so the ask alone is not enough. */
import { getLocalScreenshareStream } from "@lib/voice/livekitSession";
import type { VoiceState } from "@stores/voice.store";

export function isShareLive(voice: VoiceState): boolean {
  return (
    voice.currentChannelId !== null &&
    voice.localScreenshare &&
    getLocalScreenshareStream() !== null
  );
}
