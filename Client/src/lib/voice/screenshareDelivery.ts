// Stream audio nobody can hear is paused at the server, not only muted here.

import { Track } from "livekit-client";
import { isMusicPublication } from "./musicTrack";
import type { VoiceRemotePublication, VoiceRoom } from "./voiceRoom";

/** Pause the server's delivery of each subscribed stream audio that this user
 *  cannot hear, and resume the rest. `audible` answers for a participant
 *  identity: true or false, or null to leave that participant's alone. The
 *  subscription stays, so resuming needs no renegotiation. A music share is
 *  answered by `audibleMusic` (left alone without it), never by `audible`. */
export function syncScreenshareDelivery(
  room: VoiceRoom | null,
  audible: (identity: string) => boolean | null,
  audibleMusic?: (identity: string) => boolean | null,
): void {
  if (room === null) return;
  for (const participant of room.remoteParticipants.values()) {
    const streamEnabled = audible(participant.identity);
    const musicEnabled = audibleMusic?.(participant.identity) ?? null;
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.source !== Track.Source.ScreenShareAudio) continue;
      const enabled = isMusicPublication(publication) ? musicEnabled : streamEnabled;
      if (enabled === null) continue;
      if (publication.isSubscribed) publication.setEnabled(enabled);
    }
  }
}

/** Send whether a stream audio that just became subscribed is delivered.
 *  livekit skips a request that matches the one it cached, but a fresh server
 *  subscription starts delivered whatever was cached before, so a pause that
 *  matches the cache is preceded by a resume to put it on the wire. */
export function resendStreamAudioDelivery(
  publication: VoiceRemotePublication,
  enabled: boolean,
): void {
  if (publication.source !== Track.Source.ScreenShareAudio) return;
  if (!enabled && !publication.isEnabled) publication.setEnabled(true);
  publication.setEnabled(enabled);
}
