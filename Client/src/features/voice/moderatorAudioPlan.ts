// What a moderator's mute or deafen frame asks of the local audio, decided
// from the store snapshot taken before any of it is applied.
import type { VoiceState } from "../../stores/voice.store";

export interface ModeratorAudioPlan {
  readonly applyDeafen: boolean;
  readonly deafenLifted: boolean;
  readonly keepOwnDeafen: boolean;
  readonly applyMute: boolean;
  readonly releaseMute: boolean;
  readonly releaseDeafen: boolean;
}

/** What `enforceModeratorAudioState` does for one frame, decided from the
 *  store snapshot taken before any of it is applied. */
export function moderatorAudioPlan(
  voice: VoiceState,
  serverMuted: boolean,
  serverDeafened: boolean,
  prevServerMuted: boolean,
  prevServerDeafened: boolean,
  selfMuted: boolean,
  selfDeafened: boolean,
): ModeratorAudioPlan {
  const deafenLifted = prevServerDeafened && !serverDeafened;
  const keepOwnDeafen = deafenLifted && voice.localDeafened && voice.moderatorDeafened !== true;
  return {
    applyDeafen: serverDeafened && !voice.localDeafened,
    deafenLifted,
    keepOwnDeafen,
    applyMute: serverMuted && !voice.localMuted,
    releaseMute: prevServerMuted && !serverMuted && voice.localMuted && !selfMuted,
    releaseDeafen: deafenLifted && !keepOwnDeafen && voice.localDeafened && !selfDeafened,
  };
}
