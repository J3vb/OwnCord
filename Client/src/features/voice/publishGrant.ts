// SFU publish-grant checks and the mute fallback announcement, split from
// mediaControl.ts. Both are whole synchronous helpers.
import { Track } from "livekit-client";
import type { WsClient } from "../../lib/ws";
import { setShareDenied } from "../../stores/voice.store";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

/** Whether the SFU grant lets this room publish `source`; an empty source
 *  list means every source. */
export function publishAllowed(room: VoiceRoom, source: Track.Source): boolean {
  const permissions = room.localParticipant.permissions;
  return (
    permissions === undefined ||
    (permissions.canPublish &&
      (permissions.canPublishSources.length === 0 ||
        permissions.canPublishSources.includes(Track.sourceToProto(source))))
  );
}

/** Mirror the grant's screen-share permission into the store for the share buttons. */
export function syncShareGrant(room: VoiceRoom): void {
  setShareDenied(!publishAllowed(room, Track.Source.ScreenShare));
}

/** The unmute toggle already sent voice_mute{muted:false}; restate the
 *  fallback's mute so the server row and every peer's roster match. */
export function announceFallbackMute(ws: WsClient | null, currentChannelId: number | null): void {
  if (ws === null || ws.getState() !== "connected") return;
  if (currentChannelId === null) return;
  ws.send({ type: "voice_mute", payload: { muted: true } });
}
