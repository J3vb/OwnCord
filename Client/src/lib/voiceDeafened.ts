/**
 * Whether the local user is currently deafened, as a leaf flag.
 *
 * `lib/notificationSound.ts` is in the startup closure and must know to stay
 * silent while deafened (DP-40), but importing `stores/voice.store` there would
 * drag auth/members/ui/desktop into that closure. Instead the voice store, which
 * loads lazily, mirrors its `localDeafened` here on the rare edge it changes,
 * and the sound module reads this leaf. Defaults false, which is correct while
 * no voice session (and so no deafen) can exist.
 */

let deafened = false;

/** Mirror the voice store's local-deafen state. Called by its mutators only. */
export function setVoiceDeafened(value: boolean): void {
  deafened = value;
}

/** Whether every non-ring sound must stay silent. */
export function isVoiceDeafened(): boolean {
  return deafened;
}
