/**
 * Whether local sounds must stay silent: the user is deafened and currently in
 * a voice session, as a pair of leaf flags.
 *
 * `lib/notificationSound.ts` is in the startup closure and must know to stay
 * silent while deafened (DP-40), but importing `stores/voice.store` there would
 * drag auth/members/ui/desktop into that closure. Instead the voice store, which
 * loads lazily, mirrors its `localDeafened` and its channel membership here on
 * every edge, and the sound module reads this leaf.
 *
 * Deafen is a global mic state that outlives a call: `leaveVoiceChannel()` keeps
 * `localDeafened` and only drops the channel. The chime is therefore gated on
 * both flags together, so a deafen taken inside a call never disables message
 * chimes for the rest of the session once the user has left voice.
 */

let deafened = false;
let inVoiceSession = false;

/** Mirror the voice store's local-deafen state. Called by its mutators only. */
export function setVoiceDeafened(value: boolean): void {
  deafened = value;
}

/** Mirror whether the local user is in a voice channel. Called by the voice
 *  store's channel-membership edges only. */
export function setVoiceInSession(value: boolean): void {
  inVoiceSession = value;
}

/** Whether every non-ring sound must stay silent. */
export function isVoiceDeafened(): boolean {
  return deafened && inVoiceSession;
}
