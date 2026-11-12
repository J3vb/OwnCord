/**
 * A phone's call audio: where a call's sound plays (speaker, earpiece, a
 * headset) and whether a phone call holds the audio. Only the Android app has
 * it; elsewhere nothing is ever reported and the commands do nothing.
 */

export type AudioRouteKind = "speaker" | "earpiece" | "wired" | "bluetooth";

export interface AudioRoute {
  readonly kind: AudioRouteKind;
  /** A Bluetooth headset's own name; "" for every other route. */
  readonly name: string;
}

export interface MobileAudioState {
  /** False where the host has no routes to offer: no route control shows. */
  readonly supported: boolean;
  /** The routes there are now, in the order to list them. */
  readonly routes: readonly AudioRoute[];
  /** The route the call's sound uses. */
  readonly active: AudioRouteKind;
  /** The route the user picked, or null while the host picks by itself (a
   *  headset when one is connected, else the speaker). The host drops a pick
   *  whose device left, and when a headset is newly connected. */
  readonly manual: AudioRouteKind | null;
  /** A phone call holds the audio. The host has silenced the call's sound; the
   *  microphone is the caller's to close. */
  readonly interrupted: boolean;
}

export interface MobileAudio {
  /** Follow the host's audio state until `signal` aborts: `onState` gets the
   *  state now and then each change, in order. One watcher at a time; a second
   *  call takes over from the first. Never throws: a host without call audio
   *  reports nothing. */
  watch(signal: AbortSignal, onState: (state: MobileAudioState) => void): void;
  /** A call began (`active`) or ended. The host follows the routes, applies a
   *  pick and watches for a phone call only during one. Calls reach the host
   *  in the order they are made. */
  setSession(active: boolean): void;
  /** Play the call through `kind`; null hands the choice back to the host. A
   *  pick the host cannot keep comes back as `manual: null`. */
  setRoute(kind: AudioRouteKind | null): void;
  /** Ask for the state again, for a page that may have missed a change while
   *  it was in the background. */
  refresh(): void;
}
