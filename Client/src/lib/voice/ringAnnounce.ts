// The speaking ring a participant reports for itself. A client whose
// input-sensitivity gate decides its own ring sends that verdict to the
// OwnCord server (`voice_speak`), which relays it to the voice channel
// (`voice_speaking`). Listeners show it in place of the media server's
// loudness-based speaker detection, which trails the gate and misses a quiet
// voice the gate lets through.

/** A lit ring is reported again this often, so a late joiner learns it and a
 *  listener can tell a speaker whose connection dropped. */
export const RING_REPEAT_MS = 1000;

/** A report counts this long. Past it the listener goes back to the media
 *  server's detection for that participant. */
export const RING_TTL_MS = 3000;

/** A participant's own verdict: lit, dark, or null for "no verdict of my
 *  own, use the media server's detection". */
export type RingState = boolean | null;
