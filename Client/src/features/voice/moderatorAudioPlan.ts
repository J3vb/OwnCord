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

/** The member's own moderator flags as the store held them before the frame
 *  was applied: the update itself rewrites them, so they are read first. */
export interface PrevModeratorFlags {
  readonly serverMuted: boolean;
  readonly serverDeafened: boolean;
  /** The local mute was the one the moderator's mute laid over an open mic
   *  (VoiceState.moderatorMuted). Only that mute is the moderator's to lift. */
  readonly moderatorMuted: boolean;
}

/** Read the pre-update moderator flags from `state`. */
export function prevModeratorFlags(state: VoiceState): PrevModeratorFlags {
  return {
    serverMuted: state.localServerMuted ?? false,
    serverDeafened: state.localServerDeafened ?? false,
    moderatorMuted: state.moderatorMuted === true,
  };
}

/** What `enforceModeratorAudioState` does for one frame, decided from the
 *  store snapshot taken before any of it is applied. */
export function moderatorAudioPlan(
  voice: VoiceState,
  serverMuted: boolean,
  serverDeafened: boolean,
  prev: PrevModeratorFlags,
  selfMuted: boolean,
  selfDeafened: boolean,
): ModeratorAudioPlan {
  const deafenLifted = prev.serverDeafened && !serverDeafened;
  const keepOwnDeafen = deafenLifted && voice.localDeafened && voice.moderatorDeafened !== true;
  const muteLifted = prev.serverMuted && !serverMuted;
  return {
    applyDeafen: serverDeafened && !voice.localDeafened,
    deafenLifted,
    keepOwnDeafen,
    applyMute: serverMuted && !voice.localMuted,
    // A mute the member set themselves stays: only the moderator's own mute is released.
    releaseMute: muteLifted && prev.moderatorMuted && voice.localMuted && !selfMuted,
    releaseDeafen: deafenLifted && !keepOwnDeafen && voice.localDeafened && !selfDeafened,
  };
}
